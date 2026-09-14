//! HTTP + socket.io server that serves the preview page and pushes buffer
//! content to it.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use include_dir::{include_dir, Dir};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::editor::{Editor, Incoming};
use crate::{error, info, opener};

const LOG: &str = "server";

/// The preview page: static export of the Next.js app in `app/`, built by
/// build.rs.
static OUT: Dir = include_dir!("$CARGO_MANIFEST_DIR/app/out");

/// How many ports after the preferred one to try before letting the OS pick.
const PORT_ATTEMPTS: u16 = 20;

/// A preview page connected over the WebSocket.
struct Client {
    id: u64,
    tx: mpsc::UnboundedSender<Message>,
}

pub struct App {
    editor: Editor,
    /// Connected preview pages, keyed by the buffer number they show.
    clients: Mutex<HashMap<i64, Vec<Client>>>,
    next_client_id: AtomicU64,
    open_to_the_world: bool,
    port: u16,
}

pub async fn run(editor: Editor, mut incoming: mpsc::UnboundedReceiver<Incoming>) {
    let open_to_the_world = truthy(&editor.get_var("mkdp_open_to_the_world").await);
    let preferred_port = parse_port(&editor.get_var("mkdp_port").await);

    let listener = match bind(open_to_the_world, preferred_port).await {
        Ok(listener) => listener,
        Err(err) => {
            error!(LOG, "failed to start server: {err}");
            editor.echo_error(&format!(
                "[markdown-preview.nvim]: failed to start server: {err}"
            ));
            // keep answering the editor so rpcrequest() calls don't hang
            while let Some(msg) = incoming.recv().await {
                if let Incoming::Request { id, .. } = msg {
                    editor.respond(id);
                }
            }
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or_default();
    info!(LOG, "server run: {port}");

    let app = Arc::new(App {
        editor: editor.clone(),
        clients: Mutex::new(HashMap::new()),
        next_client_id: AtomicU64::new(1),
        open_to_the_world,
        port,
    });

    let router = Router::new()
        .route("/ws", get(websocket))
        .fallback(route)
        .with_state(app.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            error!(LOG, "http server error: {err}");
        }
    });

    if let Ok(api_info) = editor.request("nvim_get_api_info", vec![]).await {
        if let Some(channel_id) = api_info.get(0) {
            editor
                .set_var("mkdp_node_channel_id", channel_id.clone())
                .await;
        }
    }
    editor.call_detached("mkdp#util#open_browser", vec![]);

    // Requests block the editor until answered, so reply to them right away.
    // Notifications are handled in order on a separate task.
    let (notify_tx, notify_rx) = mpsc::unbounded_channel();
    tokio::spawn(app.clone().process_notifications(notify_rx));
    while let Some(msg) = incoming.recv().await {
        match msg {
            Incoming::Request { id, method } => {
                if method == "close_all_pages" {
                    app.close_all_pages();
                }
                editor.respond(id);
            }
            Incoming::Notification { method, args } => {
                let _ = notify_tx.send((method, args));
            }
        }
    }
}

/// Binds the preferred port, falling back to the following ports and finally
/// to one picked by the OS. Several editor instances each run their own
/// server, so a fixed `g:mkdp_port` is often already taken.
async fn bind(open_to_the_world: bool, preferred: Option<u16>) -> std::io::Result<TcpListener> {
    let host = if open_to_the_world {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let start = preferred.unwrap_or_else(|| {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        8080 + (millis % 1000) as u16
    });
    for port in (0..PORT_ATTEMPTS).filter_map(|i| start.checked_add(i)) {
        match TcpListener::bind(SocketAddr::new(host, port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => info!(LOG, "port {port} unavailable: {err}"),
        }
    }
    TcpListener::bind(SocketAddr::new(host, 0)).await
}

impl App {
    async fn process_notifications(
        self: Arc<Self>,
        mut rx: mpsc::UnboundedReceiver<(String, Value)>,
    ) {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            while let Ok(next) = rx.try_recv() {
                batch.push(next);
            }
            for (i, (method, args)) in batch.iter().enumerate() {
                // cursor movement emits bursts of identical refreshes; only
                // the last of a consecutive run matters
                if method == "refresh_content"
                    && batch.get(i + 1) == Some(&(method.clone(), args.clone()))
                {
                    continue;
                }
                // nvim sends the params array, vim the dict itself
                let opts = args.get(0).unwrap_or(args);
                let Some(bufnr) = opts.get("bufnr").and_then(Value::as_i64) else {
                    continue;
                };
                match method.as_str() {
                    "refresh_content" => self.refresh_page(bufnr).await,
                    "close_page" => self.close_page(bufnr).await,
                    "open_browser" => self.open_browser(bufnr).await,
                    _ => {}
                }
            }
        }
    }

    /// Serves one preview page until it disconnects or its buffer's preview is
    /// closed.
    async fn serve_client(self: Arc<Self>, bufnr: i64, mut socket: WebSocket) {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        info!(LOG, "client connect: {id} {bufnr}");
        let (tx, mut rx) = mpsc::unbounded_channel();
        if let Some(data) = self.preview_data(bufnr).await {
            let _ = tx.send(message(json!({ "type": "refresh_content", "data": data })));
        }
        self.clients
            .lock()
            .unwrap()
            .entry(bufnr)
            .or_default()
            .push(Client { id, tx });
        self.update_clients_active().await;

        // the map holds the only sender, so removing the client ends the loop
        // once its queued messages are sent
        loop {
            tokio::select! {
                outgoing = rx.recv() => match outgoing {
                    Some(msg) => if socket.send(msg).await.is_err() { break },
                    None => break,
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // pings are answered by axum; pages send nothing else
                    Some(Ok(_)) => {}
                },
            }
        }

        info!(LOG, "disconnect: {id}");
        for clients in self.clients.lock().unwrap().values_mut() {
            clients.retain(|c| c.id != id);
        }
        self.update_clients_active().await;
    }

    async fn update_clients_active(&self) {
        let active = self
            .clients
            .lock()
            .unwrap()
            .values()
            .flatten()
            .any(|c| !c.tx.is_closed());
        self.editor
            .set_var("mkdp_clients_active", Value::from(i32::from(active)))
            .await;
    }

    async fn preview_data(&self, bufnr: i64) -> Option<Value> {
        match self
            .editor
            .call("mkdp#util#preview_data", vec![bufnr.into()])
            .await
        {
            Ok(data) if data.is_object() => Some(data),
            Ok(_) => None,
            Err(err) => {
                error!(LOG, "failed to get content of buffer {bufnr}: {err}");
                None
            }
        }
    }

    /// Sends `msg` to the pages showing `bufnr`, or to all pages.
    fn broadcast(&self, bufnr: Option<i64>, msg: Value) -> usize {
        let msg = message(msg);
        let clients = self.clients.lock().unwrap();
        let targets: Vec<&Client> = match bufnr {
            Some(bufnr) => clients.get(&bufnr).into_iter().flatten().collect(),
            None => clients.values().flatten().collect(),
        };
        targets
            .iter()
            .filter(|c| c.tx.send(msg.clone()).is_ok())
            .count()
    }

    fn has_clients(&self, bufnr: i64) -> bool {
        self.clients
            .lock()
            .unwrap()
            .get(&bufnr)
            .is_some_and(|c| !c.is_empty())
    }

    async fn refresh_page(&self, bufnr: i64) {
        if !self.has_clients(bufnr) {
            return;
        }
        info!(LOG, "refresh page: {bufnr}");
        if let Some(data) = self.preview_data(bufnr).await {
            self.broadcast(
                Some(bufnr),
                json!({ "type": "refresh_content", "data": data }),
            );
        }
    }

    async fn close_page(&self, bufnr: i64) {
        info!(LOG, "close page: {bufnr}");
        self.broadcast(Some(bufnr), json!({ "type": "close_page" }));
        self.clients.lock().unwrap().remove(&bufnr);
        self.update_clients_active().await;
    }

    fn close_all_pages(&self) {
        info!(LOG, "close all pages");
        self.broadcast(None, json!({ "type": "close_page" }));
        self.clients.lock().unwrap().clear();
    }

    async fn open_browser(&self, bufnr: i64) {
        let editor = &self.editor;
        let combine_preview = truthy(&editor.get_var("mkdp_combine_preview").await);
        if combine_preview
            && self.broadcast(None, json!({ "type": "change_bufnr", "bufnr": bufnr })) > 0
        {
            info!(LOG, "combine preview page: {bufnr}");
            return;
        }

        let open_ip = var_string(editor.get_var("mkdp_open_ip").await);
        let host = if !open_ip.is_empty() {
            open_ip
        } else if self.open_to_the_world {
            local_ip().unwrap_or_else(|| "localhost".into())
        } else {
            "localhost".into()
        };
        let url = format!("http://{host}:{}/page/{bufnr}", self.port);

        let browserfunc = var_string(editor.get_var("mkdp_browserfunc").await);
        if !browserfunc.is_empty() {
            info!(LOG, "open page [{browserfunc}]: {url}");
            editor.call_detached(&browserfunc, vec![url.clone().into()]);
        } else {
            let browser = var_string(editor.get_var("mkdp_browser").await);
            info!(
                LOG,
                "open page [{}]: {url}",
                if browser.is_empty() {
                    "default"
                } else {
                    &browser
                }
            );
            let browser = (!browser.is_empty()).then_some(browser.as_str());
            if let Err(msg) = opener::open(&url, browser) {
                error!(LOG, "{msg}");
                editor.echo_error(&msg);
            }
        }
        if truthy(&editor.get_var("mkdp_echo_preview_url").await) {
            editor.call_detached("mkdp#util#echo_url", vec![url.into()]);
        }
    }
}

fn message(msg: Value) -> Message {
    Message::Text(msg.to_string().into())
}

async fn websocket(State(app): State<Arc<App>>, uri: Uri, ws: WebSocketUpgrade) -> Response {
    let bufnr = uri.query().and_then(|q| {
        q.split('&')
            .find_map(|kv| kv.strip_prefix("bufnr="))
            .and_then(|v| v.parse::<i64>().ok())
    });
    match bufnr {
        Some(bufnr) => ws.on_upgrade(move |socket| app.serve_client(bufnr, socket)),
        None => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn route(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path();

    // old preview pages rewrote their url to /<bufnr>
    if let Some(bufnr) = path
        .strip_prefix('/')
        .filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Redirect::temporary(&format!("/page/{bufnr}")).into_response();
    }
    if path == "/"
        || (path.starts_with("/page/") && path[6..].starts_with(|c: char| c.is_ascii_digit()))
    {
        return embedded("index.html");
    }
    let custom_css = match path {
        "/_static/markdown.css" => Some("mkdp_markdown_css"),
        "/_static/highlight.css" => Some("mkdp_highlight_css"),
        _ => None,
    };
    if let Some(var) = custom_css {
        let css = var_string(app.editor.get_var(var).await);
        if !css.is_empty() {
            match tokio::fs::read(&css).await {
                Ok(bytes) => return file_response(&css, bytes),
                Err(err) => error!(LOG, "load diy css fail: {path} {css}: {err}"),
            }
        }
    }
    if let Some(image) = path.strip_prefix("/_local_image_") {
        let referer = req
            .headers()
            .get(header::REFERER)
            .and_then(|r| r.to_str().ok())
            .map(|r| r.split(['?', '#']).next().unwrap_or(r))
            .unwrap_or(path);
        let bufnr = referer
            .rsplit('/')
            .next()
            .and_then(|n| n.parse::<i64>().ok());
        return local_image(&app, bufnr, image)
            .await
            .unwrap_or_else(not_found);
    }
    embedded(path.trim_start_matches('/'))
}

async fn local_image(app: &App, bufnr: Option<i64>, image: &str) -> Option<Response> {
    info!(LOG, "image route: {image}");
    let editor = &app.editor;
    let bufnr = bufnr?;
    if !truthy(&editor.call("bufexists", vec![bufnr.into()]).await.ok()?) {
        return None;
    }
    let mut file_dir = var_string(editor.get_var("mkdp_images_path").await);
    if file_dir.is_empty() {
        file_dir = var_string(
            editor
                .call("expand", vec![format!("#{bufnr}:p:h").into()])
                .await
                .ok()?,
        );
    }
    if std::env::var_os("MINGW_HOME").is_some() && !file_dir.contains(':') {
        // unix-like path such as /Z/x/y from a MinGW vim; convert to Z:\x\y
        if let Ok(out) = std::process::Command::new("cygpath.exe")
            .args(["-w", "-a", &file_dir])
            .output()
        {
            file_dir = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
        }
    }

    // the page encodes the src once and the browser may encode it again
    let decoded = percent_decode_str(image).decode_utf8_lossy().into_owned();
    let decoded = percent_decode_str(&decoded)
        .decode_utf8_lossy()
        .replace("\\ ", " ");
    let file_dir = PathBuf::from(file_dir);
    let rooted = decoded.starts_with(['/', '\\']) || Path::new(&decoded).is_absolute();
    let mut img_path = if rooted {
        PathBuf::from(&decoded)
    } else {
        file_dir.join(&decoded)
    };
    if rooted && !img_path.exists() {
        // "/images/x.png" may be relative to a parent directory of the file
        let relative = decoded.trim_start_matches(['/', '\\']);
        if let Some(found) = file_dir
            .ancestors()
            .map(|dir| dir.join(relative))
            .find(|p| p.exists())
        {
            img_path = found;
        }
    }
    info!(LOG, "imgPath {}", img_path.display());

    if img_path.is_file() {
        if let Ok(bytes) = tokio::fs::read(&img_path).await {
            return Some(file_response(&img_path.to_string_lossy(), bytes));
        }
    }
    error!(LOG, "image not exists: {}", img_path.display());
    None
}

fn embedded(path: &str) -> Response {
    match OUT.get_file(path) {
        Some(file) => file_response(path, file.contents()),
        None => not_found(),
    }
}

fn not_found() -> Response {
    let body = OUT
        .get_file("404.html")
        .map(|f| f.contents())
        .unwrap_or_default();
    let mut response = file_response("404.html", body);
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

fn file_response(path: &str, body: impl Into<Body>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(body.into());
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response
}

/// vim booleans arrive as numbers, strings or bools depending on the config
fn truthy(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty() && s != "0",
        _ => false,
    }
}

fn var_string(value: Value) -> String {
    match value {
        Value::String(s) => s,
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn parse_port(value: &Value) -> Option<u16> {
    match value {
        Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|&port| port != 0)
}

/// The address other machines on the network can reach us on. Connecting a
/// UDP socket sends no packets but makes the OS choose the outbound interface.
fn local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}
