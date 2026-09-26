//! Open a URL in the browser. Port of https://github.com/domenic/opener

use std::io;
use std::process::{Command, Stdio};

use serde_json::Value;

/// `g:mkdp_browser`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Browser {
    /// The system's default browser.
    Default,
    /// A browser name, run the way the platform's opener runs applications
    /// (`open -a` on macOS, `start` on Windows).
    Name(String),
    /// A command and its arguments, run as is with the URL appended, e.g.
    /// `['firefox', '-P', 'work']`.
    Command(Vec<String>),
}

impl Browser {
    pub fn from_var(value: &Value) -> Browser {
        match value {
            Value::String(name) if !name.trim().is_empty() => Browser::Name(name.clone()),
            Value::Array(items) => {
                let argv: Vec<String> = items
                    .iter()
                    .filter_map(|item| match item {
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })
                    .collect();
                if argv.first().is_some_and(|program| !program.is_empty()) {
                    Browser::Command(argv)
                } else {
                    Browser::Default
                }
            }
            _ => Browser::Default,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    /// Linux under the Windows Subsystem for Linux.
    Wsl,
    /// Linux, the BSDs and everything else with xdg-open.
    Unix,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else if is_wsl() {
            Os::Wsl
        } else {
            Os::Unix
        }
    }
}

/// The commands that can open `url`, in the order to try them: the first one
/// that starts wins.
pub fn commands(url: &str, browser: &Browser, os: Os) -> Vec<(String, Vec<String>)> {
    let cmd = |program: &str, browser: Option<&str>| {
        let mut args = vec!["/c".to_string(), "start".into(), "\"\"".into()];
        args.extend(browser.map(String::from));
        // `start` treats `&` as a command separator
        args.push(url.replace('&', "^&"));
        (program.to_string(), args)
    };
    let direct = |program: &str| (program.to_string(), vec![url.to_string()]);
    match (browser, os) {
        (Browser::Command(argv), _) => {
            let mut args = argv[1..].to_vec();
            args.push(url.to_string());
            vec![(argv[0].clone(), args)]
        }
        (Browser::Name(name), Os::Windows) => vec![cmd("cmd.exe", Some(name))],
        (Browser::Default, Os::Windows) => vec![cmd("cmd.exe", None)],
        (Browser::Name(name), Os::Mac) => vec![(
            "open".into(),
            vec!["-a".into(), name.clone(), url.to_string()],
        )],
        (Browser::Default, Os::Mac) => vec![direct("open")],
        // a Linux browser, or a Windows one through cmd.exe
        (Browser::Name(name), Os::Wsl) => vec![
            direct(name),
            cmd("cmd.exe", Some(name)),
            cmd(WSL_CMD, Some(name)),
        ],
        // wslview comes with wslu; cmd.exe is missing from PATH when
        // appendWindowsPath is off; xdg-open works with WSLg
        (Browser::Default, Os::Wsl) => vec![
            direct("wslview"),
            cmd("cmd.exe", None),
            cmd(WSL_CMD, None),
            direct("xdg-open"),
        ],
        (Browser::Name(name), Os::Unix) => vec![direct(name)],
        (Browser::Default, Os::Unix) => vec![direct("xdg-open")],
    }
}

const WSL_CMD: &str = "/mnt/c/Windows/System32/cmd.exe";

/// Spawns the first of [`commands`] that can be run.
///
/// On failure the returned error names the commands that were tried.
pub fn open(url: &str, browser: &Browser) -> Result<(), String> {
    let mut tried = Vec::new();
    for (program, args) in commands(url, browser, Os::current()) {
        let spawned = Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(mut child) => {
                // reap the child so it doesn't linger as a zombie
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => tried.push(program),
            Err(err) => tried.push(format!("{program} ({err})")),
        }
    }
    Err(format!(
        "[markdown-preview.nvim]: Can not open browser by using {} command, open {url} yourself",
        tried.join(", ")
    ))
}

/// WSL reports itself as Linux, but `xdg-open` often doesn't work there
/// while the Windows way of opening things does.
fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|release| release.to_lowercase().contains("microsoft"))
            .unwrap_or(false)
}

#[cfg(test)]
#[path = "opener_test.rs"]
mod tests;
