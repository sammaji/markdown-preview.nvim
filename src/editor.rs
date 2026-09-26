use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::{debug, error, info};

const LOG: &str = "editor";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Nvim,
    Vim,
}

/// A message initiated by the editor.
pub enum Incoming {
    Notification { method: String, args: Value },
    Request { id: i64, method: String },
}

type Pending = Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>;

struct Inner {
    kind: Kind,
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    next_id: AtomicI64,
}

#[derive(Clone)]
pub struct Editor(Arc<Inner>);

impl Editor {
    /// Starts reading stdin on a background thread. Incoming notifications and
    /// requests are delivered on the returned channel; the process exits when
    /// the editor closes stdin.
    pub fn attach() -> (Editor, mpsc::UnboundedReceiver<Incoming>) {
        let kind = if std::env::var("VIM_NODE_RPC").as_deref() == Ok("1") {
            Kind::Vim
        } else {
            Kind::Nvim
        };
        let editor = Editor::new(kind, Box::new(io::stdout()));
        let (tx, rx) = mpsc::unbounded_channel();
        let reader = editor.clone();
        std::thread::spawn(move || {
            reader.read(BufReader::new(io::stdin().lock()), tx);
            info!(LOG, "stdin closed, exiting");
            std::process::exit(0);
        });
        (editor, rx)
    }

    pub fn new(kind: Kind, writer: Box<dyn Write + Send>) -> Editor {
        Editor(Arc::new(Inner {
            kind,
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
        }))
    }

    /// Reads messages from the editor until `input` ends.
    pub fn read(&self, input: impl BufRead, tx: mpsc::UnboundedSender<Incoming>) {
        match self.0.kind {
            Kind::Nvim => self.read_msgpack(input, tx),
            Kind::Vim => self.read_json(input, tx),
        }
    }

    fn read_msgpack(&self, mut stdin: impl Read, tx: mpsc::UnboundedSender<Incoming>) {
        loop {
            let msg = match rmpv::decode::read_value(&mut stdin) {
                Ok(rmpv::Value::Array(msg)) => msg,
                Ok(other) => {
                    error!(LOG, "unexpected message: {other}");
                    continue;
                }
                Err(err) => {
                    debug!(LOG, "read error: {err}");
                    return;
                }
            };
            let msg: Vec<Value> = msg.into_iter().map(to_json).collect();
            match msg.as_slice() {
                [kind, id, method, _] if kind == 0 => {
                    let method = method.as_str().unwrap_or_default().to_string();
                    let _ = tx.send(Incoming::Request {
                        id: id.as_i64().unwrap_or(0),
                        method,
                    });
                }
                [kind, id, err, result] if kind == 1 => {
                    let result = if err.is_null() {
                        Ok(result.clone())
                    } else {
                        Err(err.to_string())
                    };
                    self.resolve(id.as_i64().unwrap_or(0), result);
                }
                [kind, method, args] if kind == 2 => {
                    let method = method.as_str().unwrap_or_default().to_string();
                    let _ = tx.send(Incoming::Notification {
                        method,
                        args: args.clone(),
                    });
                }
                _ => error!(LOG, "malformed message: {msg:?}"),
            }
        }
    }

    fn read_json(&self, stdin: impl BufRead, tx: mpsc::UnboundedSender<Incoming>) {
        for line in stdin.lines() {
            let Ok(line) = line else { return };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(Value::Array(msg)) = serde_json::from_str::<Value>(&line) else {
                error!(LOG, "invalid data from vim: {line}");
                continue;
            };
            let (Some(id), Some(body)) = (msg.first().and_then(Value::as_i64), msg.get(1)) else {
                continue;
            };
            let method = || {
                body.get(0)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            match id {
                0 => {
                    let args = body.get(1).cloned().unwrap_or(Value::Null);
                    let _ = tx.send(Incoming::Notification {
                        method: method(),
                        args,
                    });
                }
                id if id > 0 => {
                    let _ = tx.send(Incoming::Request {
                        id,
                        method: method(),
                    });
                }
                // responses to our requests carry the negative id we sent
                id => {
                    let result = match body {
                        Value::Array(pair) if pair.first().is_none_or(Value::is_null) => {
                            Ok(pair.get(1).cloned().unwrap_or(Value::Null))
                        }
                        Value::Array(pair) => Err(pair[0].to_string()),
                        err => Err(err.to_string()),
                    };
                    self.resolve(id, result);
                }
            }
        }
    }

    fn resolve(&self, id: i64, result: Result<Value, String>) {
        let sender = self.0.pending.lock().unwrap().remove(&id);
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    fn write_msgpack(&self, msg: rmpv::Value) {
        let mut buf = Vec::new();
        if rmpv::encode::write_value(&mut buf, &msg).is_ok() {
            self.write(&buf);
        }
    }

    fn write(&self, bytes: &[u8]) {
        let mut writer = self.0.writer.lock().unwrap();
        if let Err(err) = writer.write_all(bytes).and_then(|_| writer.flush()) {
            error!(LOG, "write error: {err}");
        }
    }

    /// Calls an `nvim_*` API method and waits for the result.
    pub async fn request(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let seq = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        match self.0.kind {
            Kind::Nvim => {
                self.0.pending.lock().unwrap().insert(seq, tx);
                let args = args.into_iter().map(to_msgpack).collect();
                self.write_msgpack(rmpv::Value::Array(vec![
                    0.into(),
                    seq.into(),
                    method.into(),
                    rmpv::Value::Array(args),
                ]));
            }
            Kind::Vim => {
                // vim expects negative ids for requests made by the job
                self.0.pending.lock().unwrap().insert(-seq, tx);
                let name = method.strip_prefix("nvim_").unwrap_or(method);
                let msg = json!(["call", "nvim#api#call", [name, args], -seq]);
                self.write(format!("{msg}\n").as_bytes());
            }
        }
        rx.await
            .map_err(|_| "editor connection closed".to_string())?
    }

    /// Replies to a request from the editor with `nil`.
    pub fn respond(&self, id: i64) {
        match self.0.kind {
            Kind::Nvim => self.write_msgpack(rmpv::Value::Array(vec![
                1.into(),
                id.into(),
                rmpv::Value::Nil,
                rmpv::Value::Nil,
            ])),
            // mkdp#rpc#request unpacks the reply as [errmsg, result]
            Kind::Vim => self.write(format!("{}\n", json!([id, [null, null]])).as_bytes()),
        }
    }

    pub async fn call(&self, func: &str, args: Vec<Value>) -> Result<Value, String> {
        self.request("nvim_call_function", vec![func.into(), Value::Array(args)])
            .await
    }

    /// Calls a vimscript function without waiting for it to finish.
    pub fn call_detached(&self, func: &str, args: Vec<Value>) {
        let editor = self.clone();
        let func = func.to_string();
        tokio::spawn(async move {
            if let Err(err) = editor.call(&func, args).await {
                error!(LOG, "call {func} failed: {err}");
            }
        });
    }

    /// Reads `g:{name}`, returning `Null` if it is not defined.
    pub async fn get_var(&self, name: &str) -> Value {
        self.request("nvim_get_var", vec![name.into()])
            .await
            .unwrap_or(Value::Null)
    }

    pub async fn set_var(&self, name: &str, value: Value) {
        if let Err(err) = self.request("nvim_set_var", vec![name.into(), value]).await {
            error!(LOG, "set g:{name} failed: {err}");
        }
    }

    pub fn echo_error(&self, msg: &str) {
        let lines: Vec<Value> = msg.lines().map(Value::from).collect();
        self.call_detached(
            "mkdp#util#echo_messages",
            vec!["Error".into(), lines.into()],
        );
    }
}

fn to_json(value: rmpv::Value) -> Value {
    use rmpv::Value as M;
    match value {
        M::Nil => Value::Null,
        M::Boolean(b) => b.into(),
        M::Integer(i) => i
            .as_i64()
            .map(Value::from)
            .or_else(|| i.as_u64().map(Value::from))
            .unwrap_or(Value::Null),
        M::F32(f) => f.into(),
        M::F64(f) => f.into(),
        M::String(s) => String::from_utf8_lossy(s.as_bytes()).into_owned().into(),
        M::Binary(b) => String::from_utf8_lossy(&b).into_owned().into(),
        M::Array(items) => items.into_iter().map(to_json).collect(),
        M::Map(entries) => entries
            .into_iter()
            .map(|(k, v)| {
                let key = match to_json(k) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                (key, to_json(v))
            })
            .collect::<serde_json::Map<_, _>>()
            .into(),
        // buffer/window/tabpage handles: their payload is a msgpack integer
        M::Ext(_, data) => rmpv::decode::read_value(&mut data.as_slice())
            .map(to_json)
            .unwrap_or(Value::Null),
    }
}

fn to_msgpack(value: Value) -> rmpv::Value {
    use rmpv::Value as M;
    match value {
        Value::Null => M::Nil,
        Value::Bool(b) => b.into(),
        Value::Number(n) => n
            .as_i64()
            .map(M::from)
            .or_else(|| n.as_u64().map(M::from))
            .or_else(|| n.as_f64().map(M::from))
            .unwrap_or(M::Nil),
        Value::String(s) => s.into(),
        Value::Array(items) => M::Array(items.into_iter().map(to_msgpack).collect()),
        Value::Object(map) => M::Map(
            map.into_iter()
                .map(|(k, v)| (k.into(), to_msgpack(v)))
                .collect(),
        ),
    }
}

#[cfg(test)]
#[path = "editor_test.rs"]
pub mod tests;
