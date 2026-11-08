//! Runs the binary as a standalone CLI: no editor, a markdown file on disk.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

const BIN: &str = env!("CARGO_BIN_EXE_markdown-preview");
const TIMEOUT: Duration = Duration::from_secs(10);

struct Preview {
    child: Child,
    dir: PathBuf,
    url: String,
}

impl Drop for Preview {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Starts `markdown-preview --no-browser a.md` in a new directory holding
/// a.md with `content`, and waits for the url it prints.
fn start(content: &str) -> Preview {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("mkdp-cli-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.md"), content).unwrap();
    let mut child = Command::new(BIN)
        .args(["--no-browser", "a.md"])
        .current_dir(&dir)
        .env("NVIM_MKDP_LOG_FILE", dir.join("mkdp.log"))
        .env_remove("NVIM_MKDP_LOG_LEVEL")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let url = line
        .trim()
        .strip_prefix("Preview page: ")
        .unwrap_or_else(|| panic!("no preview url in {line:?}"))
        .to_string();
    Preview { child, dir, url }
}

async fn next_content<S>(ws: &mut S) -> Vec<String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .expect("no message")
            .expect("socket closed")
            .unwrap();
        if let Message::Text(text) = msg {
            let msg: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(msg["type"], "refresh_content");
            return serde_json::from_value(msg["data"]["content"].clone()).unwrap();
        }
    }
}

#[test]
fn prints_the_page_of_the_file() {
    let preview = start("# hello\n");
    assert!(
        preview.url.starts_with("http://localhost:") && preview.url.ends_with("/files/a.md"),
        "{}",
        preview.url
    );
}

#[tokio::test]
async fn saving_the_file_refreshes_the_page() {
    let preview = start("# hello\n");
    let (host, path) = preview.url["http://".len()..].split_once('/').unwrap();
    let url = format!("ws://{host}/ws?path=/{path}");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    assert_eq!(next_content(&mut ws).await, ["# hello"]);

    // a different size, so the change shows even within the mtime resolution
    std::fs::write(preview.dir.join("a.md"), "# hello\n\nworld\n").unwrap();
    assert_eq!(next_content(&mut ws).await, ["# hello", "", "world"]);
}

#[test]
fn usage_errors_exit_with_2() {
    let output = Command::new(BIN).arg("missing.md").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("missing.md"), "{stderr}");
}
