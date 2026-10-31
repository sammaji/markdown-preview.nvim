//! `markdown-preview [OPTIONS] <FILE>...`: previews markdown files without an
//! editor. A local [`Editor`] plays the part of (neo)vim: each file is a
//! buffer read from disk, the options are its `g:mkdp_*` variables, and saving
//! a file refreshes its pages.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::editor::{Editor, Incoming};
use crate::server;

const USAGE: &str = "\
Preview markdown files in the browser, refreshing the page when a file is saved

Usage: markdown-preview [OPTIONS] <FILE>...

Options:
      --port <PORT>            Port to listen on, the next free one when taken
      --open-to-the-world      Listen on every interface, not only localhost
      --open-ip <HOST>         Host name or IP to put in the preview url
      --browser <BROWSER>      Browser to open the preview in
      --no-browser             Print the preview url without opening it
      --theme <THEME>          Page theme: light or dark
      --markdown-css <FILE>    CSS file to use instead of the default style
      --highlight-css <FILE>   CSS file for code highlighting
      --theme-css <FILE>       shadcn/ui theme (globals.css) to style the page
      --images-path <DIR>      Directory relative image paths are resolved from
      --page-title <TITLE>     Page title, ${name} is the file name
      --preview-options <JSON> g:mkdp_preview_options as a JSON object
  -h, --help                   Print this help
  -V, --version                Print the version
";

#[derive(Debug, PartialEq)]
pub enum Command {
    /// No arguments: talk to (neo)vim over stdio.
    Editor,
    Help,
    Version,
    Preview(Options),
}

#[derive(Debug, PartialEq)]
pub struct Options {
    pub files: Vec<PathBuf>,
    /// The `g:mkdp_*` variables, without the prefix.
    pub vars: Map<String, Value>,
}

/// The defaults of plugin/mkdp.vim that the server reads.
fn default_vars() -> Map<String, Value> {
    let vars = json!({
        "open_to_the_world": 0,
        "open_ip": "",
        "echo_preview_url": 1,
        "browserfunc": "",
        "browser": "",
        "preview_options": {
            "mkit": {},
            "katex": {},
            "uml": {},
            "maid": {},
            "disable_sync_scroll": 0,
            "sync_scroll_type": "middle",
            "hide_yaml_meta": 1,
            "sequence_diagrams": {},
            "flowchart_diagrams": {},
            "content_editable": false,
            "disable_filename": 0,
            "toc": {},
        },
        "markdown_css": "",
        "highlight_css": "",
        "theme_css": "",
        "port": "",
        "page_title": "「${name}」",
        "images_path": "",
        "combine_preview": 0,
        "theme": "",
    });
    match vars {
        Value::Object(vars) => vars,
        _ => unreachable!(),
    }
}

/// `g:mkdp_browserfunc` for `--no-browser`: answered with nothing.
const NO_BROWSER: &str = "mkdp#cli#no_browser";

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
    let mut args = args.into_iter();
    let mut files = Vec::new();
    let mut vars = default_vars();
    let mut any = false;
    while let Some(arg) = args.next() {
        any |= arg != "--path";
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value)),
            _ => (arg.clone(), None),
        };
        let mut value = || match inline {
            Some(value) => Ok(value.to_string()),
            None => args.next().ok_or(format!("{flag} needs a value")),
        };
        let path = |value: String| -> Result<Value, String> {
            let path = Path::new(&value)
                .canonicalize()
                .map_err(|err| format!("{value}: {err}"))?;
            Ok(path.to_string_lossy().into_owned().into())
        };
        let (name, value): (&str, Value) = match flag.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            // older plugin scripts pass `--path <app/server.js>`
            "--path" if !any => {
                value()?;
                continue;
            }
            "--port" => {
                let port = value()?;
                match port.parse::<u16>() {
                    Ok(port) if port != 0 => ("port", port.into()),
                    _ => return Err(format!("invalid port: {port}")),
                }
            }
            "--open-to-the-world" => ("open_to_the_world", 1.into()),
            "--open-ip" => ("open_ip", value()?.into()),
            "--browser" => ("browser", value()?.into()),
            "--no-browser" => ("browserfunc", NO_BROWSER.into()),
            "--theme" => match value()?.as_str() {
                theme @ ("light" | "dark") => ("theme", theme.into()),
                theme => return Err(format!("invalid theme: {theme}, expected light or dark")),
            },
            "--markdown-css" => ("markdown_css", path(value()?)?),
            "--highlight-css" => ("highlight_css", path(value()?)?),
            "--theme-css" => ("theme_css", path(value()?)?),
            "--images-path" => ("images_path", path(value()?)?),
            "--page-title" => ("page_title", value()?.into()),
            "--preview-options" => {
                let Ok(Value::Object(options)) = serde_json::from_str(&value()?) else {
                    return Err("--preview-options must be a JSON object".into());
                };
                let Some(Value::Object(defaults)) = vars.get_mut("preview_options") else {
                    unreachable!()
                };
                defaults.extend(options);
                continue;
            }
            "--" => {
                files.extend(args.by_ref().map(PathBuf::from));
                continue;
            }
            flag if flag.starts_with('-') && flag != "-" => {
                return Err(format!("unknown option: {flag}"));
            }
            _ => {
                files.push(PathBuf::from(arg));
                continue;
            }
        };
        vars.insert(name.into(), value);
    }
    if !any {
        return Ok(Command::Editor);
    }
    if files.is_empty() {
        return Err("no file to preview".into());
    }
    let files = files
        .into_iter()
        .map(|file| match file.canonicalize() {
            Ok(path) if path.is_file() => Ok(path),
            Ok(_) => Err(format!("{}: not a file", file.display())),
            Err(err) => Err(format!("{}: {err}", file.display())),
        })
        .collect::<Result<_, _>>()?;
    Ok(Command::Preview(Options { files, vars }))
}

pub fn usage() -> &'static str {
    USAGE
}

/// What the local editor knows: its variables and buffers, buffer `n` being
/// `files[n - 1]`.
struct State {
    vars: Mutex<Map<String, Value>>,
    files: Vec<PathBuf>,
    cwd: String,
    incoming: mpsc::UnboundedSender<Incoming>,
}

impl State {
    fn file(&self, bufnr: &Value) -> Option<&PathBuf> {
        let index = usize::try_from(bufnr.as_i64()?.checked_sub(1)?).ok()?;
        self.files.get(index)
    }

    fn notify(&self, method: &str, bufnr: usize) {
        let _ = self.incoming.send(Incoming::Notification {
            method: method.into(),
            args: json!([{ "bufnr": bufnr + 1 }]),
        });
    }

    fn handle(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        let mut args = args.into_iter();
        let mut arg = || args.next().unwrap_or(Value::Null);
        match method {
            "nvim_get_var" => {
                let name = arg();
                let name = name.as_str().unwrap_or_default();
                let vars = self.vars.lock().unwrap();
                Ok(name
                    .strip_prefix("mkdp_")
                    .and_then(|name| vars.get(name))
                    .cloned()
                    .unwrap_or(Value::Null))
            }
            "nvim_set_var" => {
                let (name, value) = (arg(), arg());
                if let Some(name) = name.as_str().and_then(|n| n.strip_prefix("mkdp_")) {
                    self.vars.lock().unwrap().insert(name.into(), value);
                }
                Ok(Value::Null)
            }
            "nvim_call_function" => {
                let func = arg();
                let Value::Array(args) = arg() else {
                    return Err("arguments must be a list".into());
                };
                self.call(func.as_str().unwrap_or_default(), &args)
            }
            _ => Err(format!("{method} is not supported without an editor")),
        }
    }

    fn call(&self, func: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        match func {
            "getcwd" => Ok(self.cwd.clone().into()),
            "mkdp#util#open_browser" => {
                for i in 0..self.files.len() {
                    self.notify("open_browser", i);
                }
                Ok(Value::Null)
            }
            "mkdp#util#buffers" => Ok(self
                .files
                .iter()
                .enumerate()
                .map(|(i, file)| json!([i + 1, file.to_string_lossy()]))
                .collect()),
            "mkdp#util#preview_data" => Ok(self
                .file(arg(0))
                .and_then(|file| self.preview_data(file))
                .unwrap_or(Value::Null)),
            "mkdp#util#file_preview_data" => Ok(arg(0)
                .as_str()
                .and_then(|path| self.preview_data(Path::new(path)))
                .unwrap_or(Value::Null)),
            "bufexists" => Ok(i32::from(self.file(arg(0)).is_some()).into()),
            // only the `#<bufnr>:p:h` the server asks for: a buffer's directory
            "expand" => {
                let bufnr = arg(0)
                    .as_str()
                    .and_then(|s| s.strip_prefix('#')?.strip_suffix(":p:h"))
                    .and_then(|n| n.parse::<i64>().ok());
                Ok(bufnr
                    .and_then(|n| self.file(&n.into()))
                    .and_then(|file| file.parent())
                    .map(|dir| dir.to_string_lossy().into_owned())
                    .unwrap_or_default()
                    .into())
            }
            "mkdp#util#echo_url" => {
                println!("Preview page: {}", arg(0).as_str().unwrap_or_default());
                Ok(Value::Null)
            }
            "mkdp#util#echo_messages" => {
                match arg(1) {
                    Value::Array(lines) => lines
                        .iter()
                        .for_each(|line| eprintln!("{}", line.as_str().unwrap_or_default())),
                    line => eprintln!("{}", line.as_str().unwrap_or_default()),
                }
                Ok(Value::Null)
            }
            "mkdp#util#call_hook" | NO_BROWSER => Ok(Value::Null),
            _ => Err(format!("{func} is not supported without an editor")),
        }
    }

    /// What mkdp#util#file_preview_data returns for `path`.
    fn preview_data(&self, path: &Path) -> Option<Value> {
        let text = std::fs::read(path).ok()?;
        let text = String::from_utf8_lossy(&text);
        let vars = self.vars.lock().unwrap();
        let var = |name: &str| vars.get(name).cloned().unwrap_or(Value::Null);
        Some(json!({
            "options": var("preview_options"),
            "isActive": 0,
            "winline": 0,
            "winheight": 0,
            "cursor": [0, 0, 0, 0],
            "pageTitle": var("page_title"),
            "theme": var("theme"),
            "name": path.to_string_lossy(),
            "content": text.lines().collect::<Vec<_>>(),
        }))
    }
}

/// How often files are checked for changes.
const POLL: Duration = Duration::from_millis(200);

/// Serves the preview of `options.files` until the process is killed.
pub async fn run(options: Options) {
    let (tx, incoming) = mpsc::unbounded_channel();
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_default();
    let state = Arc::new(State {
        vars: Mutex::new(options.vars),
        files: options.files,
        cwd,
        incoming: tx,
    });
    tokio::spawn(watch(state.clone()));
    let handler = state.clone();
    let editor = Editor::local(move |method, args| handler.handle(method, args));
    server::run(editor, incoming).await;
}

/// Refreshes the pages of a file whenever its size or modification time
/// changes. Polling also sees editors that save by replacing the file.
async fn watch(state: Arc<State>) {
    let stamp = |path: &Path| -> Option<(SystemTime, u64)> {
        let meta = std::fs::metadata(path).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    };
    let mut stamps: Vec<_> = state.files.iter().map(|f| stamp(f)).collect();
    let mut interval = tokio::time::interval(POLL);
    loop {
        interval.tick().await;
        for (i, file) in state.files.iter().enumerate() {
            let now = stamp(file);
            if now != stamps[i] {
                stamps[i] = now;
                state.notify("refresh_content", i);
            }
        }
    }
}

#[cfg(test)]
#[path = "cli_test.rs"]
mod tests;
