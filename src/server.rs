use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use include_dir::{include_dir, Dir};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Notify};

use crate::editor::{Editor, Incoming};
use crate::{error, info, opener};

const LOG: &str = "server";

/// The preview page: static export of the Next.js app in `app/`, built by
/// build.rs.
static OUT: Dir = include_dir!("$CARGO_MANIFEST_DIR/app/out");

/// How many ports after the preferred one to try before letting the OS pick.
const PORT_ATTEMPTS: u16 = 20;

/// Characters escaped in the file names of /files/ urls.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// What a preview page shows: a buffer, which the editor keeps up to date, or
/// a markdown file under the root that no buffer has open, read from disk.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Target {
    Buffer(i64),
    File(PathBuf),
}

/// A preview page connected over the WebSocket.
struct Client {
    id: u64,
    tx: mpsc::UnboundedSender<Message>,
}

pub struct App {
    editor: Editor,
    /// Connected preview pages, keyed by what they show.
    clients: Mutex<HashMap<Target, Vec<Client>>>,
    next_client_id: AtomicU64,
    /// Pages whose socket is still open, and a signal when one closes.
    connected: AtomicUsize,
    disconnected: Notify,
    open_to_the_world: bool,
    port: u16,
    token: String,
    /// The editor's working directory when the server started, canonical.
    /// Files under it are previewed at /files/<path relative to it>.
    root: Option<PathBuf>,
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

    let root = match editor.call("getcwd", vec![]).await {
        Ok(Value::String(cwd)) => Path::new(&cwd).canonicalize().ok(),
        _ => None,
    };
    let app = App::new(editor.clone(), open_to_the_world, port, root);
    let router = router(app.clone());
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
                    app.close_all_pages().await;
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
        if ipv6_taken(port) {
            info!(LOG, "port {port} unavailable: in use on IPv6");
            continue;
        }
        match TcpListener::bind(SocketAddr::new(host, port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => info!(LOG, "port {port} unavailable: {err}"),
        }
    }
    TcpListener::bind(SocketAddr::new(host, 0)).await
}

fn ipv6_taken(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port);
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/ws", get(websocket))
        .fallback(route)
        .with_state(app)
}

impl App {
    fn new(editor: Editor, open_to_the_world: bool, port: u16, root: Option<PathBuf>) -> Arc<App> {
        Arc::new(App {
            editor,
            clients: Mutex::new(HashMap::new()),
            next_client_id: AtomicU64::new(1),
            connected: AtomicUsize::new(0),
            disconnected: Notify::new(),
            open_to_the_world,
            port,
            token: new_token(),
            root,
        })
    }

    fn cookie_name(&self) -> String {
        format!("mkdp_token_{}", self.port)
    }

    fn authorized(&self, uri: &Uri, headers: &HeaderMap) -> bool {
        !self.open_to_the_world
            || query_param(uri, "token") == Some(self.token.as_str())
            || cookies(headers)
                .any(|(name, value)| name == self.cookie_name() && value == self.token)
    }

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
    async fn serve_client(self: Arc<Self>, target: Target, mut socket: WebSocket) {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        self.connected.fetch_add(1, Ordering::SeqCst);
        info!(LOG, "client connect: {id} {target:?}");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let data = match &target {
            Target::Buffer(bufnr) => self.preview_data(*bufnr).await,
            Target::File(path) => self.file_preview_data(path).await,
        };
        if let Some(data) = data {
            let _ = tx.send(message(json!({ "type": "refresh_content", "data": data })));
        }
        self.clients
            .lock()
            .unwrap()
            .entry(target)
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
        let _ = socket.send(Message::Close(None)).await;
        drop(socket);
        self.connected.fetch_sub(1, Ordering::SeqCst);
        self.disconnected.notify_waiters();
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

    async fn file_preview_data(&self, path: &Path) -> Option<Value> {
        let path = path.to_string_lossy();
        match self
            .editor
            .call("mkdp#util#file_preview_data", vec![path.as_ref().into()])
            .await
        {
            Ok(data) if data.is_object() => Some(data),
            Ok(_) => None,
            Err(err) => {
                error!(LOG, "failed to read {path}: {err}");
                None
            }
        }
    }

    /// Sends `msg` to the pages showing `bufnr`, or to all pages.
    fn broadcast(&self, bufnr: Option<i64>, msg: Value) -> usize {
        let msg = message(msg);
        let clients = self.clients.lock().unwrap();
        let targets: Vec<&Client> = match bufnr {
            Some(bufnr) => clients
                .get(&Target::Buffer(bufnr))
                .into_iter()
                .flatten()
                .collect(),
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
            .get(&Target::Buffer(bufnr))
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
        self.clients.lock().unwrap().remove(&Target::Buffer(bufnr));
        self.update_clients_active().await;
    }

    async fn close_all_pages(&self) {
        info!(LOG, "close all pages");
        self.broadcast(None, json!({ "type": "close_page" }));
        self.clients.lock().unwrap().clear();
        let all_closed = async {
            loop {
                let notified = self.disconnected.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.connected.load(Ordering::SeqCst) == 0 {
                    return;
                }
                notified.await;
            }
        };
        if tokio::time::timeout(Duration::from_secs(1), all_closed)
            .await
            .is_err()
        {
            error!(LOG, "pages still open after close_all_pages");
        }
    }

    async fn open_browser(&self, bufnr: i64) {
        let editor = &self.editor;
        let combine_preview = truthy(&editor.get_var("mkdp_combine_preview").await);
        let path = self.page_path(bufnr).await;
        if combine_preview
            && self.broadcast(
                None,
                json!({ "type": "change_bufnr", "bufnr": bufnr, "path": path }),
            ) > 0
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
        let mut url = format!("http://{host}:{}{path}", self.port);
        if self.open_to_the_world {
            url.push_str(&format!("?token={}", self.token));
        }

        let browserfunc = var_string(editor.get_var("mkdp_browserfunc").await);
        if !browserfunc.is_empty() {
            info!(LOG, "open page [{browserfunc}]: {url}");
            editor.call_detached(&browserfunc, vec![url.clone().into()]);
        } else {
            let browser = opener::Browser::from_var(&editor.get_var("mkdp_browser").await);
            info!(LOG, "open page [{browser:?}]: {url}");
            if let Err(msg) = opener::open(&url, &browser) {
                error!(LOG, "{msg}");
                editor.echo_error(&msg);
            }
        }
        if truthy(&editor.get_var("mkdp_echo_preview_url").await) {
            editor.call_detached("mkdp#util#echo_url", vec![url.clone().into()]);
        }
        editor.call_detached("mkdp#util#call_hook", vec!["on_start".into(), url.into()]);
    }
}

impl App {
    /// `[bufnr, full path]` of the editor's loaded buffers with a file.
    async fn buffers(&self) -> Vec<(i64, String)> {
        let Ok(Value::Array(buffers)) = self.editor.call("mkdp#util#buffers", vec![]).await else {
            return vec![];
        };
        buffers
            .iter()
            .filter_map(|b| Some((b.get(0)?.as_i64()?, b.get(1)?.as_str()?.to_string())))
            .collect()
    }

    /// The url path of the page for `bufnr`: /files/<path> when its file is
    /// under the root, /page/<bufnr> for other files and unnamed buffers.
    async fn page_path(&self, bufnr: i64) -> String {
        let relative = async {
            let root = self.root.as_ref()?;
            let (_, name) = self
                .buffers()
                .await
                .into_iter()
                .find(|(n, _)| *n == bufnr)?;
            let path = Path::new(&name).canonicalize().ok()?;
            let relative = path.strip_prefix(root).ok()?;
            let segments: Vec<String> = relative
                .components()
                .map(|c| {
                    utf8_percent_encode(&c.as_os_str().to_string_lossy(), PATH_SEGMENT).to_string()
                })
                .collect();
            (!segments.is_empty()).then(|| segments.join("/"))
        };
        match relative.await {
            Some(relative) => format!("/files/{relative}"),
            None => format!("/page/{bufnr}"),
        }
    }

    /// The file a /files/ url path names: under the root, after following
    /// symlinks, and existing.
    fn resolve_file(&self, encoded: &str) -> Option<PathBuf> {
        let root = self.root.as_ref()?;
        let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
        let relative = Path::new(decoded.as_ref());
        // no `..`, no absolute paths and, on Windows, no drive letters
        if decoded.is_empty()
            || decoded.contains('\0')
            || !relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        let path = root.join(relative).canonicalize().ok()?;
        (path.starts_with(root) && path.is_file()).then_some(path)
    }

    /// What the page at url path `page` shows.
    async fn target(&self, page: &str) -> Option<Target> {
        if let Some(bufnr) = page.strip_prefix("/page/") {
            return bufnr.parse().ok().map(Target::Buffer);
        }
        let path = self.resolve_file(page.strip_prefix("/files/")?)?;
        let buffer = self.buffers().await.into_iter().find(|(_, name)| {
            Path::new(name)
                .canonicalize()
                .is_ok_and(|name| name == path)
        });
        match buffer {
            Some((bufnr, _)) => Some(Target::Buffer(bufnr)),
            None if is_markdown(&path) => Some(Target::File(path)),
            None => None,
        }
    }
}

fn message(msg: Value) -> Message {
    Message::Text(msg.to_string().into())
}

async fn websocket(
    State(app): State<Arc<App>>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !app.authorized(&uri, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // the url path of the page, e.g. /page/3 or /files/docs/a.md
    let page = query_param(&uri, "path").map(|p| percent_decode_str(p).decode_utf8_lossy());
    let target = match page {
        Some(page) => app.target(&page).await,
        None => None,
    };
    match target {
        Some(target) => ws.on_upgrade(move |socket| app.serve_client(target, socket)),
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
        let query = req
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        return Redirect::temporary(&format!("/page/{bufnr}{query}")).into_response();
    }
    let files = path.starts_with("/files/");
    let page = path == "/"
        || (path.starts_with("/page/") && path[6..].starts_with(|c: char| c.is_ascii_digit()));
    let private = page || files || path.starts_with("/_assets/") || path.starts_with("/_theme/");
    if private && !app.authorized(req.uri(), req.headers()) {
        return unauthorized();
    }
    if files && app.target(path).await.is_none() {
        // a link from a page to an image or video next to it
        return match app.resolve_file(&path[7..]) {
            Some(file) if is_media(&file) => match tokio::fs::read(&file).await {
                Ok(bytes) => file_response(&file.to_string_lossy(), bytes),
                Err(_) => not_found(),
            },
            _ => not_found(),
        };
    }
    if page || files {
        let mut response = embedded("index.html");
        if app.open_to_the_world {
            let cookie = format!(
                "{}={}; Path=/; HttpOnly; SameSite=Strict",
                app.cookie_name(),
                app.token
            );
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
        }
        return response;
    }
    if let Some(file) = path.strip_prefix("/_theme/") {
        return theme_file(&app, file).await;
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
    if let Some(image) = path.strip_prefix("/_assets/") {
        // the url path of the page showing the image
        let page = req
            .headers()
            .get(header::REFERER)
            .and_then(|r| r.to_str().ok())
            .map(|r| r.split(['?', '#']).next().unwrap_or(r))
            .and_then(|r| r.split_once("://"))
            .and_then(|(_, rest)| rest.find('/').map(|slash| &rest[slash..]));
        let target = match page {
            Some(page) => app.target(page).await,
            None => None,
        };
        return local_image(&app, target, image)
            .await
            .unwrap_or_else(not_found);
    }
    embedded(path.trim_start_matches('/'))
}

async fn local_image(app: &App, target: Option<Target>, image: &str) -> Option<Response> {
    info!(LOG, "image route: {image}");
    let editor = &app.editor;
    let target = target?;
    if let Target::Buffer(bufnr) = target {
        if !truthy(&editor.call("bufexists", vec![bufnr.into()]).await.ok()?) {
            return None;
        }
    }
    let mut file_dir = var_string(editor.get_var("mkdp_images_path").await);
    if file_dir.is_empty() {
        file_dir = match target {
            Target::Buffer(bufnr) => var_string(
                editor
                    .call("expand", vec![format!("#{bufnr}:p:h").into()])
                    .await
                    .ok()?,
            ),
            Target::File(path) => path.parent()?.to_string_lossy().into_owned(),
        };
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

    // the route takes any path, so it must not become a way to read the
    // user's files
    if !is_media(&img_path) {
        error!(LOG, "not an image: {}", img_path.display());
        return None;
    }
    if img_path.is_file() {
        if let Ok(bytes) = tokio::fs::read(&img_path).await {
            return Some(file_response(&img_path.to_string_lossy(), bytes));
        }
    }
    error!(LOG, "image not exists: {}", img_path.display());
    None
}

async fn theme_file(app: &App, file: &str) -> Response {
    let theme = var_string(app.editor.get_var("mkdp_theme_css").await);
    if file != "theme.css" {
        return theme_font(&theme, file).await.unwrap_or_else(not_found);
    }
    let mut css = String::new();
    if !theme.is_empty() {
        match tokio::fs::read_to_string(&theme).await {
            Ok(text) => css = theme_css(&text),
            Err(err) => error!(LOG, "load theme css fail: {theme}: {err}"),
        }
    }
    file_response("theme.css", css)
}

async fn theme_font(theme: &str, file: &str) -> Option<Response> {
    let decoded = percent_decode_str(file).decode_utf8_lossy();
    if theme.is_empty() || !is_font(Path::new(&*decoded)) {
        return None;
    }
    let dir = Path::new(theme).parent()?.canonicalize().ok()?;
    let font = dir.join(&*decoded).canonicalize().ok()?;
    if !font.starts_with(&dir) {
        return None;
    }
    let bytes = tokio::fs::read(&font).await.ok()?;
    Some(file_response(&font.to_string_lossy(), bytes))
}

fn is_font(path: &Path) -> bool {
    mime_guess::from_path(path)
        .iter()
        .any(|mime| mime.type_() == mime_guess::mime::FONT)
}

pub(crate) fn theme_css(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(at) = rest.find("--") {
        let (before, from) = rest.split_at(at);
        out.push_str(before);
        let name_len = from[2..]
            .find(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
            .map_or(from.len(), |n| n + 2);
        let (name, after) = from.split_at(name_len);
        out.push_str(name);
        rest = after;
        let Some(value) = after.strip_prefix(':') else {
            continue;
        };
        let end = value.find([';', '}']).unwrap_or(value.len());
        let (value, tail) = value.split_at(end);
        if is_hsl_channels(value.trim()) {
            out.push_str(&format!(": hsl({})", value.trim()));
        } else {
            out.push(':');
            out.push_str(value);
        }
        rest = tail;
    }
    out.push_str(rest);
    out.lines()
        .filter(|line| !is_package_import(line.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `222.2 47.4% 11.2%`, optionally with ` / 50%` alpha
fn is_hsl_channels(value: &str) -> bool {
    let (channels, alpha) = match value.split_once('/') {
        Some((channels, alpha)) => (channels, Some(alpha.trim())),
        None => (value, None),
    };
    let number = |s: &str| !s.is_empty() && s.parse::<f64>().is_ok();
    let percent = |s: &str| s.strip_suffix('%').is_some_and(number);
    let parts: Vec<&str> = channels.split_whitespace().collect();
    parts.len() == 3
        && number(parts[0].trim_end_matches("deg"))
        && percent(parts[1])
        && percent(parts[2])
        && alpha.is_none_or(|a| number(a) || percent(a))
}

/// `@import "tailwindcss";`, but not `@import url(https://fonts...)` or a file
fn is_package_import(line: &str) -> bool {
    let Some(target) = line.strip_prefix("@import") else {
        return false;
    };
    let target = target.trim().trim_end_matches(';').trim();
    let Some(name) = target
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .or_else(|| target.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')))
    else {
        return false;
    };
    !(name.contains(':') || name.starts_with(['.', '/']) || name.ends_with(".css"))
}

/// Files a /files/ url previews when no buffer has them open.
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ["md", "markdown", "mkd", "mdown", "mkdn", "mdwn"]
                .contains(&ext.to_ascii_lowercase().as_str())
        })
}

fn is_media(path: &Path) -> bool {
    mime_guess::from_path(path).iter().any(|mime| {
        matches!(
            mime.type_(),
            mime_guess::mime::IMAGE | mime_guess::mime::AUDIO | mime_guess::mime::VIDEO
        )
    })
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        "markdown-preview.nvim: open the preview from the editor, this link is missing its token",
    )
        .into_response()
}

fn query_param<'a>(uri: &'a Uri, name: &str) -> Option<&'a str> {
    uri.query()?.split('&').find_map(|kv| {
        kv.split_once('=')
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| value)
    })
}

fn cookies(headers: &HeaderMap) -> impl Iterator<Item = (&str, &str)> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
}

/// A request without an Origin header does not come from a web page.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let origin_host = origin
        .to_str()
        .ok()
        .and_then(|o| o.split_once("://"))
        .map(|(_, host)| host);
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    origin_host.is_some() && origin_host == host
}

/// 128 random bits, hex encoded.
fn new_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("no random numbers from the OS");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

#[cfg(test)]
#[path = "server_test.rs"]
pub(crate) mod tests;
