//! Open a URL in the browser. Port of https://github.com/domenic/opener

use std::io;
use std::process::{Command, Stdio};

/// Spawns the platform's URL opener (or `browser`, if given).
///
/// On failure the returned error names the command that could not be run.
pub fn open(url: &str, browser: Option<&str>) -> Result<(), String> {
    let mut args: Vec<String> = Vec::new();
    let command = if cfg!(windows) || is_wsl() {
        args.extend(["/c", "start", "\"\""].map(String::from));
        if let Some(browser) = browser {
            args.push(browser.to_string());
        }
        // `start` treats `&` as a command separator
        args.push(url.replace('&', "^&"));
        "cmd.exe".to_string()
    } else if cfg!(target_os = "macos") {
        if let Some(browser) = browser {
            args.extend(["-a".to_string(), browser.to_string()]);
        }
        args.push(url.to_string());
        "open".to_string()
    } else {
        args.push(url.to_string());
        browser.unwrap_or("xdg-open").to_string()
    };

    let spawned = Command::new(&command)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            // reap the child so it doesn't linger as a zombie
            std::thread::spawn(move || child.wait());
            Ok(())
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(format!(
            "[markdown-preview.nvim]: Can not open browser by using {command} command"
        )),
        Err(err) => Err(format!("[markdown-preview.nvim]: {command}: {err}")),
    }
}

/// WSL reports itself as Linux, but `xdg-open` doesn't work there while the
/// Windows way of opening things through cmd.exe does.
fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|release| release.to_lowercase().contains("microsoft"))
            .unwrap_or(false)
}
