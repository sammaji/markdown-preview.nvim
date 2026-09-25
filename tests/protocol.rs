//! Runs the server binary the way (neo)vim does and plays the editor's side
//! of the stdio protocol.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_markdown-preview");
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Nvim,
    Vim,
}

/// A request from the server, with vim's `nvim#api#call` unwrapped into the
/// `nvim_*` method it stands for.
#[derive(Clone, Debug)]
struct Request {
    id: i64,
    method: String,
    args: Vec<Value>,
}

enum Message {
    Request(Request),
    /// A reply to a request we sent: (id, error, result).
    Response(i64, Value, Value),
}

struct Server {
    mode: Mode,
    child: Child,
    stdin: Option<ChildStdin>,
    messages: mpsc::Receiver<Message>,
    log: PathBuf,
}

fn temp_path(name: &str) -> PathBuf {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "mkdp-test-{}-{}-{nanos}-{name}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ))
}

impl Server {
    /// Starts the server like mkdp#rpc#start_server does.
    fn start(mode: Mode) -> Server {
        let log = temp_path("mkdp.log");
        let mut command = Command::new(BIN);
        command
            .env("NVIM_MKDP_LOG_FILE", &log)
            .env_remove("NVIM_MKDP_LOG_LEVEL")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match mode {
            Mode::Nvim => command.env_remove("VIM_NODE_RPC"),
            Mode::Vim => command.env("VIM_NODE_RPC", "1"),
        };
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, messages) = mpsc::channel();
        std::thread::spawn(move || match mode {
            Mode::Nvim => read_msgpack(stdout, tx),
            Mode::Vim => read_json(stdout, tx),
        });
        Server {
            mode,
            child,
            stdin,
            messages,
            log,
        }
    }

    fn send(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn send_msgpack(&mut self, value: rmpv::Value) {
        let mut buf = Vec::new();
        rmpv::encode::write_value(&mut buf, &value).unwrap();
        self.send(&buf);
    }

    fn send_json(&mut self, value: Value) {
        self.send(format!("{value}\n").as_bytes());
    }

    /// Answers a request as nvim, or as vim running `nvim#api#call`.
    fn reply(&mut self, id: i64, result: Result<Value, String>) {
        match self.mode {
            Mode::Nvim => {
                let (err, result) = match result {
                    Ok(result) => (rmpv::Value::Nil, to_msgpack(&result)),
                    Err(err) => (
                        rmpv::Value::Array(vec![0.into(), err.into()]),
                        rmpv::Value::Nil,
                    ),
                };
                self.send_msgpack(rmpv::Value::Array(vec![1.into(), id.into(), err, result]));
            }
            // vim replies to ["call", func, args, id] with [id, return value],
            // and nvim#api#call returns [error, result]
            Mode::Vim => {
                let pair = match result {
                    Ok(result) => json!([null, result]),
                    Err(err) => json!([err, null]),
                };
                self.send_json(json!([id, pair]));
            }
        }
    }

    fn notify(&mut self, method: &str, bufnr: i64) {
        match self.mode {
            // rpcnotify(chan, method, {'bufnr': n})
            Mode::Nvim => self.send_msgpack(rmpv::Value::Array(vec![
                2.into(),
                method.into(),
                rmpv::Value::Array(vec![rmpv::Value::Map(vec![("bufnr".into(), bufnr.into())])]),
            ])),
            // mkdp#rpc#notify
            Mode::Vim => self.send_json(json!([0, [method, { "bufnr": bufnr }]])),
        }
    }

    fn request(&mut self, id: i64, method: &str) {
        match self.mode {
            Mode::Nvim => self.send_msgpack(rmpv::Value::Array(vec![
                0.into(),
                id.into(),
                method.into(),
                rmpv::Value::Array(vec![]),
            ])),
            // ch_evalexpr(chan, [method, args])
            Mode::Vim => self.send_json(json!([id, [method, []]])),
        }
    }

    fn next(&self) -> Message {
        self.messages
            .recv_timeout(TIMEOUT)
            .expect("no message from the server")
    }

    /// Answers requests with `editor` until one matches `until`, which is
    /// returned unanswered. Every request seen is appended to `seen`.
    fn serve_until(
        &mut self,
        seen: &mut Vec<Request>,
        editor: &dyn Fn(&Request) -> Result<Value, String>,
        until: impl Fn(&Request) -> bool,
    ) -> Request {
        loop {
            match self.next() {
                Message::Request(req) => {
                    seen.push(req.clone());
                    if until(&req) {
                        return req;
                    }
                    let result = editor(&req);
                    self.reply(req.id, result);
                }
                Message::Response(id, ..) => panic!("unexpected response to {id}"),
            }
        }
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                panic!("server did not exit after stdin was closed");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.log);
    }
}

fn read_msgpack(mut stdout: impl Read, tx: mpsc::Sender<Message>) {
    while let Ok(msg) = rmpv::decode::read_value(&mut stdout) {
        let msg = to_json(msg);
        let msg = match msg.as_array().map(Vec::as_slice) {
            Some([kind, id, method, Value::Array(args)]) if kind == 0 => {
                Message::Request(Request {
                    id: id.as_i64().unwrap(),
                    method: method.as_str().unwrap().to_string(),
                    args: args.clone(),
                })
            }
            Some([kind, id, err, result]) if kind == 1 => {
                Message::Response(id.as_i64().unwrap(), err.clone(), result.clone())
            }
            _ => panic!("unexpected message from the server: {msg}"),
        };
        if tx.send(msg).is_err() {
            return;
        }
    }
}

fn read_json(stdout: impl Read, tx: mpsc::Sender<Message>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { return };
        let msg: Value = serde_json::from_str(&line)
            .unwrap_or_else(|err| panic!("server sent invalid json {line:?}: {err}"));
        let msg = match msg.as_array().map(Vec::as_slice) {
            // what vim's channel expects for "call this function"
            Some([call, func, Value::Array(call_args), id]) if call == "call" => {
                assert_eq!(func, "nvim#api#call", "{line}");
                let [name, Value::Array(args)] = call_args.as_slice() else {
                    panic!("bad nvim#api#call arguments: {line}")
                };
                let id = id.as_i64().unwrap();
                assert!(
                    id < 0,
                    "requests from the job must use negative ids: {line}"
                );
                Message::Request(Request {
                    id,
                    method: format!("nvim_{}", name.as_str().unwrap()),
                    args: args.clone(),
                })
            }
            Some([id, Value::Array(pair)]) if pair.len() == 2 => {
                Message::Response(id.as_i64().unwrap(), pair[0].clone(), pair[1].clone())
            }
            _ => panic!("unexpected message from the server: {line}"),
        };
        if tx.send(msg).is_err() {
            return;
        }
    }
}

fn to_json(value: rmpv::Value) -> Value {
    use rmpv::Value as M;
    match value {
        M::Nil => Value::Null,
        M::Boolean(b) => b.into(),
        M::Integer(i) => i.as_i64().map(Value::from).unwrap_or(Value::Null),
        M::String(s) => s.into_str().unwrap().into(),
        M::Array(items) => items.into_iter().map(to_json).collect(),
        M::Map(entries) => entries
            .into_iter()
            .map(|(k, v)| (k.as_str().unwrap().to_string(), to_json(v)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => panic!("unexpected msgpack value {other}"),
    }
}

fn to_msgpack(value: &Value) -> rmpv::Value {
    use rmpv::Value as M;
    match value {
        Value::Null => M::Nil,
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => n.as_i64().unwrap().into(),
        Value::String(s) => s.as_str().into(),
        Value::Array(items) => M::Array(items.iter().map(to_msgpack).collect()),
        Value::Object(map) => M::Map(
            map.iter()
                .map(|(k, v)| (k.as_str().into(), to_msgpack(v)))
                .collect(),
        ),
    }
}

/// An editor with `g:mkdp_browserfunc` set and nothing else configured.
fn editor(mode: Mode) -> impl Fn(&Request) -> Result<Value, String> {
    move |req| match req.method.as_str() {
        "nvim_get_var" => match req.args[0].as_str().unwrap() {
            "mkdp_browserfunc" => Ok(json!("MkdpTestOpen")),
            "mkdp_open_to_the_world" => Ok(json!(0)),
            // unset: nvim fails the request, vim's get_var returns v:null
            name => match mode {
                Mode::Nvim => Err(format!("Key not found: {name}")),
                Mode::Vim => Ok(Value::Null),
            },
        },
        "nvim_get_api_info" => Ok(json!([42, { "functions": [] }])),
        "nvim_set_var" => Ok(Value::Null),
        "nvim_call_function" => Ok(Value::Null),
        method => panic!("unexpected request {method}"),
    }
}

fn is_call(req: &Request, func: &str) -> bool {
    req.method == "nvim_call_function" && req.args[0] == func
}

fn http_get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn stdio_protocol(mode: Mode) {
    let mut server = Server::start(mode);
    let editor = editor(mode);
    let mut seen = Vec::new();

    let open = server.serve_until(&mut seen, &editor, |r| is_call(r, "mkdp#util#open_browser"));
    assert_eq!(open.args, vec![json!("mkdp#util#open_browser"), json!([])]);
    let var_reads: Vec<&Value> = seen
        .iter()
        .filter(|r| r.method == "nvim_get_var")
        .map(|r| &r.args[0])
        .collect();
    assert!(var_reads.contains(&&json!("mkdp_port")), "{seen:?}");
    assert!(
        var_reads.contains(&&json!("mkdp_open_to_the_world")),
        "{seen:?}"
    );
    // the channel id from nvim_get_api_info is stored for the plugin scripts
    assert!(
        seen.iter()
            .any(|r| r.method == "nvim_set_var"
                && r.args == [json!("mkdp_node_channel_id"), json!(42)]),
        "{seen:?}"
    );
    server.reply(open.id, Ok(Value::Null));

    // what :MarkdownPreview does through mkdp#util#open_browser
    server.notify("open_browser", 1);
    let browse = server.serve_until(&mut seen, &editor, |r| is_call(r, "MkdpTestOpen"));
    let url = browse.args[1][0].as_str().unwrap().to_string();
    let port: u16 = url
        .strip_prefix("http://localhost:")
        .and_then(|rest| rest.strip_suffix("/page/1"))
        .unwrap_or_else(|| panic!("unexpected preview url {url}"))
        .parse()
        .unwrap();
    server.reply(browse.id, Ok(Value::Null));
    // then g:mkdp_on_start, if the user set one
    let hook = server.serve_until(&mut seen, &editor, |r| is_call(r, "mkdp#util#call_hook"));
    assert_eq!(hook.args[1], json!(["on_start", url]));
    server.reply(hook.id, Ok(Value::Null));

    let response = http_get(port, "/page/1");
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: text/html"),
        "{head}"
    );
    assert!(body.contains("<html"), "{body}");

    // rpcrequest(chan, 'close_all_pages') blocks the editor until answered
    server.request(9, "close_all_pages");
    match server.next() {
        Message::Response(id, err, result) => {
            assert_eq!((id, err, result), (9, Value::Null, Value::Null));
        }
        Message::Request(req) => panic!("expected a response, got {req:?}"),
    }

    server.close_stdin();
    assert!(server.wait().success());
    let log = std::fs::read_to_string(&server.log).unwrap();
    assert!(log.contains(&format!("server run: {port}")), "{log}");
}

#[test]
fn nvim_stdio_protocol() {
    stdio_protocol(Mode::Nvim);
}

#[test]
fn vim_stdio_protocol() {
    stdio_protocol(Mode::Vim);
}

#[test]
fn exits_when_nvim_closes_stdin() {
    let mut server = Server::start(Mode::Nvim);
    // the server is up and waiting on the editor
    match server.next() {
        Message::Request(req) => assert_eq!(req.method, "nvim_get_var"),
        Message::Response(..) => panic!("expected a request"),
    }
    server.close_stdin();
    assert!(server.wait().success());
}

#[test]
fn exits_when_vim_closes_stdin() {
    let mut server = Server::start(Mode::Vim);
    match server.next() {
        Message::Request(req) => assert_eq!(req.method, "nvim_get_var"),
        Message::Response(..) => panic!("expected a request"),
    }
    server.close_stdin();
    assert!(server.wait().success());
}

#[test]
fn version_matches_cargo_toml() {
    let manifest =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
    let version = manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap();
    let output = Command::new(BIN).arg("--version").output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{version}\n")
    );
}
