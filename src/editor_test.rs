//! Tests of the editor connection, and [`FakeEditor`]: an editor for the
//! server's tests that records the requests sent to it and answers them.

use std::io::{self, BufReader, Read, Write};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::*;

/// A request the code under test sent to the editor.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    pub method: String,
    pub args: Vec<Value>,
}

type Answer = dyn Fn(&Call) -> Result<Value, String> + Send;

pub struct FakeEditor {
    pub editor: Editor,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl FakeEditor {
    /// An nvim connection whose requests are answered by `answer`.
    pub fn new(answer: impl Fn(&Call) -> Result<Value, String> + Send + 'static) -> Self {
        let (out_tx, out_rx) = std_mpsc::channel::<Vec<u8>>();
        let (in_tx, in_rx) = std_mpsc::channel::<Vec<u8>>();
        let editor = Editor::new(Kind::Nvim, Box::new(ChannelWriter(out_tx)));
        let calls = Arc::new(Mutex::new(Vec::new()));

        let recorded = calls.clone();
        let answer: Box<Answer> = Box::new(answer);
        std::thread::spawn(move || {
            for chunk in out_rx {
                let mut bytes = chunk.as_slice();
                while let Ok(msg) = rmpv::decode::read_value(&mut bytes) {
                    let Value::Array(msg) = to_json(msg) else {
                        panic!("editor sent a non-array message")
                    };
                    let [kind, id, method, Value::Array(args)] = msg.as_slice() else {
                        panic!("editor sent a malformed message: {msg:?}")
                    };
                    if kind != 0 {
                        continue;
                    }
                    let call = Call {
                        method: method.as_str().unwrap().to_string(),
                        args: args.clone(),
                    };
                    recorded.lock().unwrap().push(call.clone());
                    let (err, result) = match answer(&call) {
                        Ok(result) => (Value::Null, result),
                        Err(err) => (Value::from(vec![Value::from(0), err.into()]), Value::Null),
                    };
                    let reply = rmpv::Value::Array(vec![
                        1.into(),
                        to_msgpack(id.clone()),
                        to_msgpack(err),
                        to_msgpack(result),
                    ]);
                    let mut buf = Vec::new();
                    rmpv::encode::write_value(&mut buf, &reply).unwrap();
                    if in_tx.send(buf).is_err() {
                        return;
                    }
                }
            }
        });

        let reader = editor.clone();
        std::thread::spawn(move || {
            let (tx, _rx) = mpsc::unbounded_channel();
            reader.read(BufReader::new(ChannelReader::new(in_rx)), tx);
        });
        FakeEditor { editor, calls }
    }

    /// Every request made so far, oldest first.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    /// The `nvim_call_function` requests made for `func`, as argument lists.
    pub fn function_calls(&self, func: &str) -> Vec<Vec<Value>> {
        self.calls()
            .into_iter()
            .filter(|c| c.method == "nvim_call_function" && c.args[0] == func)
            .map(|c| c.args[1].as_array().cloned().unwrap_or_default())
            .collect()
    }
}

struct ChannelWriter(std_mpsc::Sender<Vec<u8>>);

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .send(buf.to_vec())
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reads the chunks sent on a channel; ends once every sender is gone.
struct ChannelReader {
    rx: std_mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl ChannelReader {
    fn new(rx: std_mpsc::Receiver<Vec<u8>>) -> Self {
        ChannelReader {
            rx,
            buf: Vec::new(),
            pos: 0,
        }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos == self.buf.len() {
            match self.rx.recv() {
                Ok(chunk) => (self.buf, self.pos) = (chunk, 0),
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// A writer whose output the test can inspect.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Output {
    fn take(&self) -> Vec<u8> {
        std::mem::take(&mut self.0.lock().unwrap())
    }

    fn take_string(&self) -> String {
        String::from_utf8(self.take()).unwrap()
    }

    /// Decodes everything written so far as msgpack messages.
    fn take_msgpack(&self) -> Vec<rmpv::Value> {
        let bytes = self.take();
        let mut rest = bytes.as_slice();
        let mut msgs = Vec::new();
        while !rest.is_empty() {
            msgs.push(rmpv::decode::read_value(&mut rest).unwrap());
        }
        msgs
    }
}

fn editor(kind: Kind) -> (Editor, Output) {
    let output = Output::default();
    (Editor::new(kind, Box::new(output.clone())), output)
}

fn msgpack(values: &[rmpv::Value]) -> Vec<u8> {
    let mut buf = Vec::new();
    for value in values {
        rmpv::encode::write_value(&mut buf, value).unwrap();
    }
    buf
}

fn arr(items: Vec<rmpv::Value>) -> rmpv::Value {
    rmpv::Value::Array(items)
}

/// Feeds `input` through the read loop and returns what it delivered.
fn read_all(editor: &Editor, input: &[u8]) -> Vec<Incoming> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    editor.read(input, tx);
    let mut incoming = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        incoming.push(msg);
    }
    incoming
}

/// Starts `editor.request(method, args)` and runs it until it has sent the
/// request and is waiting for the reply.
async fn start_request(
    editor: &Editor,
    method: &str,
    args: Vec<Value>,
) -> tokio::task::JoinHandle<Result<Value, String>> {
    let (editor, method) = (editor.clone(), method.to_string());
    let handle = tokio::spawn(async move { editor.request(&method, args).await });
    tokio::task::yield_now().await;
    handle
}

#[test]
fn nvim_delivers_requests_and_notifications() {
    let (editor, _) = editor(Kind::Nvim);
    let bufnr = rmpv::Value::Map(vec![("bufnr".into(), 3.into())]);
    let input = msgpack(&[
        arr(vec![
            0.into(),
            7.into(),
            "close_all_pages".into(),
            arr(vec![]),
        ]),
        arr(vec![2.into(), "refresh_content".into(), arr(vec![bufnr])]),
    ]);
    match read_all(&editor, &input).as_slice() {
        [Incoming::Request {
            id,
            method: request,
        }, Incoming::Notification { method, args }] => {
            assert_eq!((*id, request.as_str()), (7, "close_all_pages"));
            assert_eq!(method, "refresh_content");
            assert_eq!(args, &json!([{ "bufnr": 3 }]));
        }
        _ => panic!("expected a request and a notification"),
    }
}

#[test]
fn nvim_skips_malformed_messages() {
    let (editor, _) = editor(Kind::Nvim);
    let input = msgpack(&[
        5.into(),
        arr(vec![9.into(), 9.into()]),
        arr(vec![3.into(), "x".into(), arr(vec![])]),
        // a reply to a request that was never made
        arr(vec![1.into(), 99.into(), rmpv::Value::Nil, 1.into()]),
        arr(vec![2.into(), "open_browser".into(), arr(vec![])]),
    ]);
    let incoming = read_all(&editor, &input);
    assert_eq!(incoming.len(), 1);
    assert!(
        matches!(&incoming[0], Incoming::Notification { method, .. } if method == "open_browser")
    );
}

#[tokio::test]
async fn nvim_request_is_encoded_and_resolved_by_its_response() {
    let (editor, output) = editor(Kind::Nvim);
    let first = start_request(&editor, "nvim_get_var", vec!["mkdp_port".into()]).await;
    let second = start_request(&editor, "nvim_call_function", vec!["expand".into()]).await;
    assert_eq!(
        output.take_msgpack(),
        vec![
            arr(vec![
                0.into(),
                1.into(),
                "nvim_get_var".into(),
                arr(vec!["mkdp_port".into()])
            ]),
            arr(vec![
                0.into(),
                2.into(),
                "nvim_call_function".into(),
                arr(vec!["expand".into()])
            ]),
        ]
    );

    // replies may arrive in any order
    let input = msgpack(&[
        arr(vec![
            1.into(),
            2.into(),
            arr(vec![0.into(), "E117: Unknown function".into()]),
            rmpv::Value::Nil,
        ]),
        arr(vec![1.into(), 1.into(), rmpv::Value::Nil, 8888.into()]),
    ]);
    assert!(read_all(&editor, &input).is_empty());
    assert_eq!(first.await.unwrap(), Ok(json!(8888)));
    let err = second.await.unwrap().unwrap_err();
    assert!(err.contains("E117: Unknown function"), "{err}");
}

#[tokio::test]
async fn nvim_request_fails_when_the_editor_goes_away() {
    let (editor, _) = editor(Kind::Nvim);
    let request = start_request(&editor, "nvim_get_var", vec!["x".into()]).await;
    editor.0.pending.lock().unwrap().clear();
    assert_eq!(
        request.await.unwrap(),
        Err("editor connection closed".into())
    );
}

#[test]
fn nvim_respond_writes_a_nil_response() {
    let (editor, output) = editor(Kind::Nvim);
    editor.respond(42);
    assert_eq!(
        output.take_msgpack(),
        vec![arr(vec![
            1.into(),
            42.into(),
            rmpv::Value::Nil,
            rmpv::Value::Nil
        ])]
    );
}

#[test]
fn vim_delivers_requests_and_notifications() {
    let (editor, _) = editor(Kind::Vim);
    // what mkdp#rpc#notify and ch_evalexpr send
    let input = concat!(
        "[0,[\"open_browser\",{\"bufnr\":4}]]\n",
        "\n",
        "not json\n",
        "{\"an\":\"object\"}\n",
        "[3,[\"close_all_pages\",[]]]\n",
    );
    match read_all(&editor, input.as_bytes()).as_slice() {
        [Incoming::Notification { method, args }, Incoming::Request {
            id,
            method: request,
        }] => {
            assert_eq!(method, "open_browser");
            assert_eq!(args, &json!({ "bufnr": 4 }));
            assert_eq!((*id, request.as_str()), (3, "close_all_pages"));
        }
        _ => panic!("expected a notification and a request"),
    }
}

#[tokio::test]
async fn vim_request_is_encoded_and_resolved_by_its_response() {
    let (editor, output) = editor(Kind::Vim);
    let first = start_request(&editor, "nvim_get_var", vec!["mkdp_port".into()]).await;
    assert_eq!(
        output.take_string(),
        "[\"call\",\"nvim#api#call\",[\"get_var\",[\"mkdp_port\"]],-1]\n"
    );
    let second = start_request(
        &editor,
        "nvim_call_function",
        vec!["expand".into(), json!(["%"])],
    )
    .await;
    assert_eq!(
        output.take_string(),
        "[\"call\",\"nvim#api#call\",[\"call_function\",[\"expand\",[\"%\"]]],-2]\n"
    );

    // vim answers a "call" with [id, return value]; nvim#api#call returns
    // [error, result]
    let input = "[-2,[\"Vim:E117: Unknown function\",null]]\n[-1,[null,{\"a\":[1]}]]\n";
    assert!(read_all(&editor, input.as_bytes()).is_empty());
    assert_eq!(first.await.unwrap(), Ok(json!({ "a": [1] })));
    let err = second.await.unwrap().unwrap_err();
    assert!(err.contains("E117"), "{err}");
}

#[test]
fn vim_respond_writes_an_error_result_pair() {
    let (editor, output) = editor(Kind::Vim);
    editor.respond(5);
    // mkdp#rpc#request does `let [l:errmsg, res] = res`
    assert_eq!(output.take_string(), "[5,[null,null]]\n");
}

#[test]
fn ext_handles_become_integers() {
    use rmpv::Value as M;
    // nvim sends buffer handles as ext type 0 wrapping a msgpack integer
    let small = msgpack(&[3.into()]);
    let large = msgpack(&[300.into()]);
    assert_eq!(to_json(M::Ext(0, small)), json!(3));
    assert_eq!(to_json(M::Ext(1, large)), json!(300));
    assert_eq!(to_json(M::Ext(0, vec![])), Value::Null);
}

#[test]
fn msgpack_values_convert_to_json() {
    use rmpv::Value as M;
    let value = M::Map(vec![
        ("name".into(), M::Binary(b"a.md".to_vec())),
        (
            M::from(1),
            M::Array(vec![M::Nil, true.into(), M::Array(vec![1.5f64.into()])]),
        ),
        ("big".into(), u64::MAX.into()),
        ("neg".into(), (-4).into()),
        ("buf".into(), M::Ext(0, msgpack(&[2.into()]))),
    ]);
    assert_eq!(
        to_json(value),
        json!({
            "name": "a.md",
            "1": [null, true, [1.5]],
            "big": u64::MAX,
            "neg": -4,
            "buf": 2,
        })
    );
}

#[test]
fn json_values_convert_to_msgpack() {
    use rmpv::Value as M;
    let value = json!({ "list": [null, false, -1, u64::MAX, 0.5, "s"] });
    assert_eq!(
        to_msgpack(value),
        M::Map(vec![(
            "list".into(),
            M::Array(vec![
                M::Nil,
                false.into(),
                (-1).into(),
                u64::MAX.into(),
                0.5f64.into(),
                "s".into(),
            ])
        )])
    );
}
