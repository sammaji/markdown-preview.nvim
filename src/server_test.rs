// the port lock is held across awaits on purpose, see lock_ports
#![allow(clippy::await_holding_lock)]

use super::*;
use crate::editor::tests::FakeEditor;
use axum::body::to_bytes;
use futures_util::StreamExt;
use std::net::TcpListener as StdListener;
use std::sync::atomic::AtomicUsize;
use std::time::Duration;
use tokio_tungstenite::tungstenite;

const TIMEOUT: Duration = Duration::from_secs(5);

/// A directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> TempDir {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            "mkdp-test-{}-{}-{nanos}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(name);
        std::fs::create_dir_all(&dir).unwrap();
        // canonical, so paths compare equal on macOS where /var -> /private/var
        TempDir(dir.canonicalize().unwrap())
    }

    /// Creates `relative` (and its parents) with `contents`.
    fn file(&self, relative: &str, contents: &[u8]) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An nvim with the global variables in `vars` and the buffers in
/// `buffers` (bufnr, directory of its file). `mkdp#util#preview_data`
/// answers `{"bufnr": n, "seq": <how many times it was called>}`.
fn fake(vars: Value, buffers: Vec<(i64, PathBuf)>) -> FakeEditor {
    let seq = AtomicUsize::new(0);
    FakeEditor::new(move |call| {
        let args = &call.args;
        match call.method.as_str() {
            "nvim_get_var" => {
                let name = args[0].as_str().unwrap();
                vars.get(name)
                    .cloned()
                    .ok_or_else(|| format!("Key not found: {name}"))
            }
            "nvim_call_function" => {
                let func_args = args[1].as_array().unwrap();
                let bufnr = |arg: &Value| {
                    buffers
                        .iter()
                        .find(|(n, _)| Some(*n) == arg.as_i64())
                        .cloned()
                };
                match args[0].as_str().unwrap() {
                    "bufexists" => Ok(json!(i32::from(bufnr(&func_args[0]).is_some()))),
                    "expand" => {
                        let expr = func_args[0].as_str().unwrap();
                        let found = buffers.iter().find(|(n, _)| expr == format!("#{n}:p:h"));
                        Ok(found
                            .map(|(_, dir)| json!(dir.to_string_lossy()))
                            .unwrap_or_else(|| json!("")))
                    }
                    "mkdp#util#preview_data" => {
                        let n = seq.fetch_add(1, Ordering::Relaxed) + 1;
                        Ok(json!({ "bufnr": func_args[0], "seq": n }))
                    }
                    func => Ok(json!(format!("called {func}"))),
                }
            }
            _ => Ok(Value::Null),
        }
    })
}

fn test_app(editor: &FakeEditor) -> Arc<App> {
    App::new(editor.editor.clone(), false, 4321)
}

async fn get(app: &Arc<App>, path: &str, referer: Option<&str>) -> (StatusCode, String, Vec<u8>) {
    let mut req = Request::builder().uri(path);
    if let Some(referer) = referer {
        req = req.header(header::REFERER, referer);
    }
    let res = route(State(app.clone()), req.body(Body::empty()).unwrap()).await;
    let status = res.status();
    let content_type = res
        .headers()
        .get(header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, content_type, body)
}

fn embedded_file(path: &str) -> Vec<u8> {
    OUT.get_file(path).unwrap().contents().to_vec()
}

/// Polls `check` until it returns something.
async fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + TIMEOUT;
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[test]
fn truthy_follows_vim_semantics() {
    for value in [
        json!(1),
        json!(-1),
        json!(0.5),
        json!("1"),
        json!("yes"),
        json!(true),
    ] {
        assert!(truthy(&value), "{value}");
    }
    for value in [
        json!(0),
        json!(0.0),
        json!(""),
        json!("0"),
        json!(false),
        json!(null),
        json!([1]),
    ] {
        assert!(!truthy(&value), "{value}");
    }
}

#[test]
fn var_string_returns_strings_verbatim() {
    assert_eq!(var_string(json!("Open Me")), "Open Me");
    assert_eq!(var_string(json!(null)), "");
    assert_eq!(var_string(json!(12)), "12");
}

#[test]
fn parse_port_accepts_numbers_and_strings() {
    assert_eq!(parse_port(&json!(8080)), Some(8080));
    assert_eq!(parse_port(&json!("8080")), Some(8080));
    assert_eq!(parse_port(&json!(" 9000 ")), Some(9000));
    assert_eq!(parse_port(&json!(65535)), Some(65535));
    for value in [
        json!(0),
        json!("0"),
        json!(""),
        json!(65536),
        json!(-1),
        json!("80 80"),
        json!("port"),
        json!(true),
        json!(null),
        json!(80.5),
    ] {
        assert_eq!(parse_port(&value), None, "{value}");
    }
}

/// A port that is free on 127.0.0.1 along with the `count - 1` after it.
/// Picked below the OS's ephemeral range, so tests binding port 0 in
/// parallel don't take it.
/// Held by the tests that bind ports, which would otherwise walk into each
/// other's ports when bind() falls back to the next one, and by tests that
/// spawn processes: a child holds the test process's sockets until it execs.
static PORTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn lock_ports() -> std::sync::MutexGuard<'static, ()> {
    PORTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A run of `count` ports free on 127.0.0.1 (and IPv6), held until dropped.
/// Picked below the OS's ephemeral range, so tests binding port 0 in
/// parallel don't take them.
fn hold_ports(count: u16) -> (u16, Vec<StdListener>) {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let seed = std::process::id() as usize + NEXT.fetch_add(1, Ordering::Relaxed) * 997;
    for i in 0..50 {
        let start = 20_000 + ((seed + i * 211) % 10_000) as u16;
        let held: Vec<StdListener> = (start..start + count)
            .map_while(|p| {
                if ipv6_taken(p) {
                    return None;
                }
                StdListener::bind(("127.0.0.1", p)).ok()
            })
            .collect();
        if held.len() == usize::from(count) {
            return (start, held);
        }
    }
    panic!("no run of {count} free ports");
}

/// Like [`hold_ports`], but released for the test to bind.
fn free_ports(count: u16) -> u16 {
    let (start, held) = hold_ports(count);
    drop(held);
    start
}

#[tokio::test]
async fn bind_uses_the_preferred_port() {
    let _ports = lock_ports();
    let port = free_ports(1);
    let listener = bind(false, Some(port)).await.unwrap();
    assert_eq!(listener.local_addr().unwrap().port(), port);
}

#[tokio::test]
async fn bind_falls_back_to_the_next_port() {
    let _ports = lock_ports();
    let port = free_ports(2);
    let _taken = StdListener::bind(("127.0.0.1", port)).unwrap();
    let listener = bind(false, Some(port)).await.unwrap();
    assert_eq!(listener.local_addr().unwrap().port(), port + 1);
}

#[tokio::test]
async fn bind_skips_a_port_another_program_has_on_ipv6() {
    let _ports = lock_ports();
    let port = free_ports(2);
    // what Node.js and most servers do by default
    let Ok(_taken) = StdListener::bind(("::", port)) else {
        return; // no IPv6 on this machine
    };
    let listener = bind(false, Some(port)).await.unwrap();
    assert_eq!(listener.local_addr().unwrap().port(), port + 1);
}

#[tokio::test]
async fn bind_lets_the_os_pick_when_every_attempt_is_taken() {
    let _ports = lock_ports();
    let (start, _taken) = hold_ports(PORT_ATTEMPTS);
    let listener = bind(false, Some(start)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 0);
    assert!(!(start..start + PORT_ATTEMPTS).contains(&port), "{port}");
}

#[tokio::test]
async fn bind_without_a_preferred_port() {
    let _ports = lock_ports();
    let listener = bind(false, None).await.unwrap();
    assert_ne!(listener.local_addr().unwrap().port(), 0);
}

#[tokio::test]
async fn bind_is_local_unless_open_to_the_world() {
    let _ports = lock_ports();
    let local = bind(false, None).await.unwrap().local_addr().unwrap();
    assert_eq!(local.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    let world = bind(true, None).await.unwrap().local_addr().unwrap();
    assert_eq!(world.ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
}

#[tokio::test]
async fn bare_bufnr_redirects_to_its_page() {
    let editor = fake(json!({}), vec![]);
    let res = route(
        State(test_app(&editor)),
        Request::builder().uri("/12").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(res.headers()[header::LOCATION], "/page/12");
}

#[tokio::test]
async fn pages_serve_the_index() {
    let app = test_app(&fake(json!({}), vec![]));
    let index = embedded_file("index.html");
    for path in ["/", "/page/3", "/page/3?x=1"] {
        let (status, content_type, body) = get(&app, path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(
            content_type.starts_with("text/html"),
            "{path}: {content_type}"
        );
        assert_eq!(body, index, "{path}");
    }
    let (status, _, body) = get(&app, "/page/abc", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_ne!(body, index);
}

#[tokio::test]
async fn unknown_paths_are_404() {
    let app = test_app(&fake(json!({}), vec![]));
    let (status, content_type, body) = get(&app, "/no/such/file.js", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(content_type.starts_with("text/html"), "{content_type}");
    assert_eq!(body, embedded_file("404.html"));
}

#[tokio::test]
async fn embedded_assets_are_served() {
    let app = test_app(&fake(json!({}), vec![]));
    let (status, content_type, body) = get(&app, "/_static/favicon.ico", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("image/"), "{content_type}");
    assert_eq!(body, embedded_file("_static/favicon.ico"));
}

#[tokio::test]
async fn custom_css_replaces_the_embedded_css() {
    let tmp = TempDir::new();
    let markdown = tmp.file("my markdown.css", b"body { color: red }");
    let highlight = tmp.file("hl.css", b".hljs { color: blue }");
    let editor = fake(
        json!({
            "mkdp_markdown_css": markdown.to_string_lossy(),
            "mkdp_highlight_css": highlight.to_string_lossy(),
        }),
        vec![],
    );
    let app = test_app(&editor);
    for (path, expected) in [
        ("/_static/markdown.css", "body { color: red }"),
        ("/_static/highlight.css", ".hljs { color: blue }"),
    ] {
        let (status, content_type, body) = get(&app, path, None).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(content_type, "text/css", "{path}");
        assert_eq!(String::from_utf8(body).unwrap(), expected, "{path}");
    }
}

#[tokio::test]
async fn css_falls_back_to_the_embedded_file() {
    let tmp = TempDir::new();
    // unset, and set to a file that does not exist
    let editor = fake(
        json!({ "mkdp_highlight_css": tmp.0.join("missing.css").to_string_lossy() }),
        vec![],
    );
    let app = test_app(&editor);
    for name in ["markdown.css", "highlight.css"] {
        let (status, content_type, body) = get(&app, &format!("/_static/{name}"), None).await;
        assert_eq!(status, StatusCode::OK, "{name}");
        assert_eq!(content_type, "text/css", "{name}");
        assert_eq!(body, embedded_file(&format!("_static/{name}")), "{name}");
    }
}

#[test]
fn theme_css_keeps_a_shadcn_v4_theme() {
    let css = ":root {\n  --radius: 0.625rem;\n  --background: oklch(1 0 0);\n  --font-sans: Inter, sans-serif;\n}\n.dark {\n  --border: oklch(1 0 0 / 10%);\n}\n@theme inline {\n  --color-background: var(--background);\n}";
    assert_eq!(theme_css(css), css);
}

#[test]
fn theme_css_wraps_tailwind_v3_hsl_channels() {
    let css = "@layer base {\n  :root {\n    --background: 0 0% 100%;\n    --primary:222.2 47.4% 11.2%;\n    --ring: 215deg 20.2% 65.1% / 50%;\n    --radius: 0.5rem;\n  }\n  .dark { --muted: 217.2 32.6% 17.5% }\n}";
    assert_eq!(
        theme_css(css),
        "@layer base {\n  :root {\n    --background: hsl(0 0% 100%);\n    --primary: hsl(222.2 47.4% 11.2%);\n    --ring: hsl(215deg 20.2% 65.1% / 50%);\n    --radius: 0.5rem;\n  }\n  .dark { --muted: hsl(217.2 32.6% 17.5%)}\n}"
    );
}

#[test]
fn theme_css_drops_package_imports_only() {
    let css = "@import \"tailwindcss\";\n@import 'tw-animate-css';\n@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n@import \"./fonts.css\";\n@import \"https://example.com/x\";\n:root { --x: 1px; }";
    assert_eq!(
        theme_css(css),
        "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n@import \"./fonts.css\";\n@import \"https://example.com/x\";\n:root { --x: 1px; }"
    );
}

#[tokio::test]
async fn theme_css_is_empty_without_a_theme() {
    let tmp = TempDir::new();
    for vars in [
        json!({}),
        json!({ "mkdp_theme_css": tmp.0.join("missing.css").to_string_lossy() }),
    ] {
        let app = test_app(&fake(vars.clone(), vec![]));
        let (status, content_type, body) = get(&app, "/_theme/theme.css", None).await;
        assert_eq!(status, StatusCode::OK, "{vars}");
        assert_eq!(content_type, "text/css", "{vars}");
        assert!(body.is_empty(), "{vars}");
    }
}

#[tokio::test]
async fn theme_css_and_its_fonts_are_served() {
    let tmp = TempDir::new();
    let theme = tmp.file("theme/globals.css", b":root { --primary: 0 0% 9%; }");
    tmp.file("theme/fonts/My Font.woff2", b"woff2 bytes");
    tmp.file("theme/notes.txt", b"secret");
    tmp.file("outside.woff2", b"outside");
    let app = test_app(&fake(
        json!({ "mkdp_theme_css": theme.to_string_lossy() }),
        vec![],
    ));

    let (status, content_type, body) = get(&app, "/_theme/theme.css", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/css");
    assert_eq!(body, b":root { --primary: hsl(0 0% 9%); }");

    let (status, content_type, body) = get(&app, "/_theme/fonts/My%20Font.woff2", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "font/woff2");
    assert_eq!(body, b"woff2 bytes");

    // only fonts, and only from the theme's folder
    for path in [
        "/_theme/notes.txt",
        "/_theme/globals.css",
        "/_theme/../outside.woff2",
        "/_theme/%2e%2e/outside.woff2",
        "/_theme/missing.woff2",
    ] {
        let (status, _, body) = get(&app, path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_ne!(body, b"secret", "{path}");
        assert_ne!(body, b"outside", "{path}");
    }
}

const PAGE_3: Option<&str> = Some("http://localhost:4321/page/3");

#[tokio::test]
async fn local_image_is_relative_to_the_buffer() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/img/a.png", b"png bytes");
    let editor = fake(json!({}), vec![(3, docs)]);
    let app = test_app(&editor);

    let (status, content_type, body) = get(&app, "/_assets/img/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "image/png");
    assert_eq!(body, b"png bytes");
    assert_eq!(editor.function_calls("bufexists"), vec![vec![json!(3)]]);
    assert_eq!(editor.function_calls("expand"), vec![vec![json!("#3:p:h")]]);

    // the page's query string and hash are not part of the bufnr
    let referer = Some("http://localhost:4321/page/3?theme=dark#top");
    let (status, _, body) = get(&app, "/_assets/img/a.png", referer).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"png bytes");
}

#[tokio::test]
async fn local_image_uses_mkdp_images_path() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/a.png", b"next to the buffer");
    let assets = tmp.dir("assets");
    tmp.file("assets/a.png", b"from images path");
    let editor = fake(
        json!({ "mkdp_images_path": assets.to_string_lossy() }),
        vec![(3, docs)],
    );
    let (status, _, body) = get(&test_app(&editor), "/_assets/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"from images path");
}

#[tokio::test]
async fn local_image_decodes_the_path() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/my pic.jpg", b"jpeg bytes");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));
    for path in [
        "/_assets/my%20pic.jpg",
        // encoded by the page and again by the browser
        "/_assets/my%2520pic.jpg",
        // `my\ pic.jpg`, a shell-escaped space
        "/_assets/my%5C%20pic.jpg",
    ] {
        let (status, content_type, body) = get(&app, path, PAGE_3).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert_eq!(content_type, "image/jpeg", "{path}");
        assert_eq!(body, b"jpeg bytes", "{path}");
    }
}

#[tokio::test]
async fn local_image_rooted_path_is_found_in_an_ancestor() {
    let tmp = TempDir::new();
    let sub = tmp.dir("project/docs/sub");
    tmp.file("project/images/mkdp-test-logo.svg", b"<svg/>");
    let app = test_app(&fake(json!({}), vec![(3, sub)]));
    let (status, content_type, body) =
        get(&app, "/_assets//images/mkdp-test-logo.svg", PAGE_3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "image/svg+xml");
    assert_eq!(body, b"<svg/>");
}

#[tokio::test]
async fn local_image_absolute_path_inside_the_buffer_dir() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    let image = tmp.file("docs/a.gif", b"gif bytes");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));
    let path = format!("/_assets/{}", image.to_string_lossy());
    let (status, content_type, body) = get(&app, &path, PAGE_3).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "image/gif");
    assert_eq!(body, b"gif bytes");
}

#[tokio::test]
async fn local_image_needs_an_existing_buffer() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/a.png", b"png bytes");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));

    let (status, _, _) = get(&app, "/_assets/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK, "control request");

    let (status, _, body) = get(
        &app,
        "/_assets/a.png",
        Some("http://localhost:4321/page/8"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, embedded_file("404.html"));
    let (status, _, _) = get(&app, "/_assets/a.png", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = get(&app, "/_assets/a.png", Some("http://localhost:4321/")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn local_image_missing_file_is_404() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/a.png", b"png bytes");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));
    let (status, _, _) = get(&app, "/_assets/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK, "control request");
    let (status, _, body) = get(&app, "/_assets/b.png", PAGE_3).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, embedded_file("404.html"));
    // a directory is not an image
    let (status, _, _) = get(&app, "/_assets/.", PAGE_3).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn local_image_only_serves_images() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/a.png", b"png bytes");
    let secret = TempDir::new();
    let secret_file = secret.file("id_rsa", b"PRIVATE KEY");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));

    let (status, _, _) = get(&app, "/_assets/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK, "control request");

    let path = format!("/_assets/{}", secret_file.to_string_lossy());
    let (status, _, body) = get(&app, &path, PAGE_3).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{path} was served");
    assert_ne!(body, b"PRIVATE KEY");

    let (status, _, body) = get(&app, "/_assets//etc/passwd", PAGE_3).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "/etc/passwd was served");
    assert!(!String::from_utf8_lossy(&body).contains("root:"));
}

#[tokio::test]
async fn local_image_does_not_traverse_to_non_images() {
    let tmp = TempDir::new();
    let docs = tmp.dir("project/docs");
    tmp.file("project/images/a.png", b"png bytes");
    tmp.file("secret.txt", b"TOKEN=hunter2");
    let app = test_app(&fake(json!({}), vec![(3, docs)]));

    // `../images/a.png` is an ordinary markdown image link
    let (status, _, body) = get(&app, "/_assets/../images/a.png", PAGE_3).await;
    assert_eq!(status, StatusCode::OK, "control request");
    assert_eq!(body, b"png bytes");

    for path in [
        "/_assets/../../secret.txt",
        "/_assets/%2E%2E%2F%2E%2E%2Fsecret.txt",
    ] {
        let (status, _, body) = get(&app, path, PAGE_3).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} was served");
        assert_ne!(body, b"TOKEN=hunter2");
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Serves `app`'s router on the port it was created with.
async fn serve(editor: &FakeEditor, open_to_the_world: bool) -> Arc<App> {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = App::new(editor.editor.clone(), open_to_the_world, port);
    let router = router(app.clone());
    tokio::spawn(async move { axum::serve(listener, router).await });
    app
}

/// Connects a preview page for `bufnr` and waits for its initial content.
async fn connect(app: &App, bufnr: i64) -> Ws {
    let url = format!("ws://127.0.0.1:{}/ws?bufnr={bufnr}", app.port);
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let first = next_json(&mut ws).await.unwrap();
    assert_eq!(first["type"], "refresh_content");
    assert_eq!(first["data"]["bufnr"], bufnr);
    ws
}

/// The next message on `ws`, or `None` once it is closed.
async fn next_json(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .expect("no message")
        {
            Some(Ok(tungstenite::Message::Text(text))) => {
                return Some(serde_json::from_str(&text).unwrap())
            }
            Some(Ok(tungstenite::Message::Close(_))) | Some(Err(_)) | None => return None,
            Some(Ok(_)) => {}
        }
    }
}

fn notifier(app: &Arc<App>) -> mpsc::UnboundedSender<(String, Value)> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(app.clone().process_notifications(rx));
    tx
}

fn set_var_calls(editor: &FakeEditor, name: &str) -> Vec<Value> {
    editor
        .calls()
        .into_iter()
        .filter(|c| c.method == "nvim_set_var" && c.args[0] == name)
        .map(|c| c.args[1].clone())
        .collect()
}

#[tokio::test]
async fn websocket_needs_a_bufnr() {
    let app = serve(&fake(json!({}), vec![]), false).await;
    let url = format!("ws://127.0.0.1:{}/ws", app.port);
    match tokio_tungstenite::connect_async(url).await {
        Err(tungstenite::Error::Http(res)) => assert_eq!(res.status(), StatusCode::BAD_REQUEST),
        other => panic!("expected a 400, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_rejects_other_web_sites() {
    let app = serve(&fake(json!({}), vec![(3, PathBuf::new())]), false).await;
    let url = format!("ws://127.0.0.1:{}/ws?bufnr=3", app.port);
    let mut req = tungstenite::client::IntoClientRequest::into_client_request(url).unwrap();
    req.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://evil.example"),
    );
    match tokio_tungstenite::connect_async(req).await {
        Err(tungstenite::Error::Http(res)) => assert_eq!(res.status(), StatusCode::FORBIDDEN),
        other => panic!("expected a 403, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_accepts_the_page_origin() {
    let app = serve(&fake(json!({}), vec![(3, PathBuf::new())]), false).await;
    let url = format!("ws://127.0.0.1:{}/ws?bufnr=3", app.port);
    let mut req = tungstenite::client::IntoClientRequest::into_client_request(url).unwrap();
    let origin = format!("http://127.0.0.1:{}", app.port);
    req.headers_mut()
        .insert(header::ORIGIN, HeaderValue::from_str(&origin).unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(next_json(&mut ws).await.unwrap()["type"], "refresh_content");
}

#[tokio::test]
async fn open_to_the_world_needs_the_token() {
    let tmp = TempDir::new();
    let docs = tmp.dir("docs");
    tmp.file("docs/a.png", b"png bytes");
    let app = serve(&fake(json!({}), vec![(3, docs)]), true).await;
    let token = app.token.clone();
    assert_eq!(token.len(), 32);
    assert_ne!(token, App::new(app.editor.clone(), true, 1).token);

    for path in ["/page/3", "/", "/_assets/a.png", "/_theme/theme.css"] {
        let (status, _, body) = get(&app, path, PAGE_3).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        assert!(!body.contains(&b'<'), "{path} served the page");
        let (status, _, _) = get(&app, &format!("{path}?token=wrong"), PAGE_3).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "{path} with a wrong token"
        );
    }
    // the page's scripts need no token
    let (status, _, _) = get(&app, "/404.html", None).await;
    assert_eq!(status, StatusCode::OK);

    // the link the editor opens works and hands the page a cookie
    let req = Request::builder()
        .uri(format!("/page/3?token={token}"))
        .body(Body::empty())
        .unwrap();
    let res = route(State(app.clone()), req).await;
    assert_eq!(res.status(), StatusCode::OK);
    let cookie = res.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        cookie.starts_with(&format!("mkdp_token_{}={token};", app.port)),
        "{cookie}"
    );
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"),
        "{cookie}"
    );

    // which images and the socket then accept
    let req = Request::builder()
        .uri("/_assets/a.png")
        .header(header::REFERER, PAGE_3.unwrap())
        .header(
            header::COOKIE,
            format!("other=1; mkdp_token_{}={token}", app.port),
        )
        .body(Body::empty())
        .unwrap();
    let res = route(State(app.clone()), req).await;
    assert_eq!(res.status(), StatusCode::OK);

    let url = format!("ws://127.0.0.1:{}/ws?bufnr=3", app.port);
    match tokio_tungstenite::connect_async(url.clone()).await {
        Err(tungstenite::Error::Http(res)) => assert_eq!(res.status(), StatusCode::UNAUTHORIZED),
        other => panic!("expected a 401, got {other:?}"),
    }
    let mut req = tungstenite::client::IntoClientRequest::into_client_request(url).unwrap();
    req.headers_mut().insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("mkdp_token_{}={token}", app.port)).unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    assert_eq!(next_json(&mut ws).await.unwrap()["type"], "refresh_content");
}

#[tokio::test]
async fn localhost_needs_no_token() {
    let editor = fake(json!({ "mkdp_browserfunc": "OpenPreview" }), vec![]);
    let app = serve(&editor, false).await;
    let (status, _, _) = get(&app, "/page/3", None).await;
    assert_eq!(status, StatusCode::OK);
    notifier(&app)
        .send(("open_browser".into(), json!({ "bufnr": 2 })))
        .unwrap();
    let opened =
        wait_for(|| Some(editor.function_calls("OpenPreview")).filter(|c| !c.is_empty())).await;
    assert_eq!(
        opened,
        vec![vec![json!(format!("http://localhost:{}/page/2", app.port))]]
    );
}

#[tokio::test]
async fn close_page_only_closes_that_buffers_pages() {
    let editor = fake(json!({}), vec![]);
    let app = serve(&editor, false).await;
    let mut page3 = connect(&app, 3).await;
    let mut other3 = connect(&app, 3).await;
    let mut page4 = connect(&app, 4).await;
    assert_eq!(
        set_var_calls(&editor, "mkdp_clients_active").last(),
        Some(&json!(1))
    );

    let notify = notifier(&app);
    notify
        .send(("close_page".into(), json!([{ "bufnr": 3 }])))
        .unwrap();
    for page in [&mut page3, &mut other3] {
        assert_eq!(next_json(page).await, Some(json!({ "type": "close_page" })));
        assert_eq!(next_json(page).await, None, "page should be disconnected");
    }

    // the other buffer's page still gets updates, and nothing before them
    notify
        .send(("refresh_content".into(), json!({ "bufnr": 4 })))
        .unwrap();
    let next = next_json(&mut page4).await.unwrap();
    assert_eq!(next["type"], "refresh_content");
    assert_eq!(next["data"]["bufnr"], 4);

    notify
        .send(("close_page".into(), json!([{ "bufnr": 4 }])))
        .unwrap();
    assert_eq!(
        next_json(&mut page4).await,
        Some(json!({ "type": "close_page" }))
    );
    wait_for(|| {
        (set_var_calls(&editor, "mkdp_clients_active").last() == Some(&json!(0))).then_some(())
    })
    .await;
}

#[tokio::test]
async fn close_all_pages_closes_every_page() {
    let editor = fake(json!({}), vec![]);
    let app = serve(&editor, false).await;
    let mut page3 = connect(&app, 3).await;
    let mut page4 = connect(&app, 4).await;
    app.close_all_pages().await;
    // the editor kills the server as soon as this returns
    assert_eq!(app.connected.load(Ordering::SeqCst), 0);
    for page in [&mut page3, &mut page4] {
        assert_eq!(next_json(page).await, Some(json!({ "type": "close_page" })));
        assert_eq!(next_json(page).await, None);
    }
}

#[tokio::test]
async fn repeated_refreshes_are_collapsed() {
    let editor = fake(json!({}), vec![]);
    let app = serve(&editor, false).await;
    let mut page3 = connect(&app, 3).await;
    let mut page4 = connect(&app, 4).await;
    assert_eq!(editor.function_calls("mkdp#util#preview_data").len(), 2);

    // queued before processing starts, so they are handled as one batch
    let (tx, rx) = mpsc::unbounded_channel();
    let refresh = |bufnr: i64| ("refresh_content".to_string(), json!([{ "bufnr": bufnr }]));
    for msg in [refresh(3), refresh(3), refresh(3), refresh(4), refresh(3)] {
        tx.send(msg).unwrap();
    }
    tokio::spawn(app.clone().process_notifications(rx));

    let seqs = [
        next_json(&mut page3).await.unwrap()["data"]["seq"].clone(),
        next_json(&mut page4).await.unwrap()["data"]["seq"].clone(),
        next_json(&mut page3).await.unwrap()["data"]["seq"].clone(),
    ];
    assert_eq!(seqs, [json!(3), json!(4), json!(5)]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let calls = editor.function_calls("mkdp#util#preview_data");
    assert_eq!(
        calls[2..],
        [vec![json!(3)], vec![json!(4)], vec![json!(3)]],
        "{calls:?}"
    );
}

#[tokio::test]
async fn open_browser_calls_browserfunc_with_the_page_url() {
    let editor = fake(json!({ "mkdp_browserfunc": "OpenPreview" }), vec![]);
    let app = serve(&editor, false).await;
    notifier(&app)
        .send(("open_browser".into(), json!([{ "bufnr": 7 }])))
        .unwrap();
    let calls =
        wait_for(|| Some(editor.function_calls("OpenPreview")).filter(|c| !c.is_empty())).await;
    let url = format!("http://localhost:{}/page/7", app.port);
    assert_eq!(calls, vec![vec![json!(url)]]);
    assert!(editor.function_calls("mkdp#util#echo_url").is_empty());
}

#[tokio::test]
async fn open_browser_uses_mkdp_open_ip_and_echoes_the_url() {
    let editor = fake(
        json!({
            "mkdp_browserfunc": "OpenPreview",
            "mkdp_open_ip": "192.0.2.7",
            "mkdp_echo_preview_url": 1,
        }),
        vec![],
    );
    // open_ip wins over the address picked for open_to_the_world
    let app = serve(&editor, true).await;
    notifier(&app)
        .send(("open_browser".into(), json!({ "bufnr": 2 })))
        .unwrap();
    let url = json!(format!(
        "http://192.0.2.7:{}/page/2?token={}",
        app.port, app.token
    ));
    let echoed =
        wait_for(|| Some(editor.function_calls("mkdp#util#echo_url")).filter(|c| !c.is_empty()))
            .await;
    assert_eq!(echoed, vec![vec![url.clone()]]);
    assert_eq!(editor.function_calls("OpenPreview"), vec![vec![url]]);
}

#[tokio::test]
async fn combine_preview_reuses_a_connected_page() {
    let editor = fake(
        json!({ "mkdp_browserfunc": "OpenPreview", "mkdp_combine_preview": 1 }),
        vec![],
    );
    let app = serve(&editor, false).await;
    let notify = notifier(&app);

    // no page yet, so one is opened
    notify
        .send(("open_browser".into(), json!([{ "bufnr": 3 }])))
        .unwrap();
    wait_for(|| Some(()).filter(|_| !editor.function_calls("OpenPreview").is_empty())).await;

    let mut page = connect(&app, 3).await;
    notify
        .send(("open_browser".into(), json!([{ "bufnr": 5 }])))
        .unwrap();
    assert_eq!(
        next_json(&mut page).await,
        Some(json!({ "type": "change_bufnr", "bufnr": 5 }))
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(editor.function_calls("OpenPreview").len(), 1);
}
