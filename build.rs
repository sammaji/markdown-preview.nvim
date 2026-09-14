//! Builds the preview page (the Next.js app in `app/`) into `app/out`, which
//! src/server.rs embeds into the binary. Requires Node.js and pnpm (or npx to
//! fetch pnpm).
//!
//! Set `MKDP_SKIP_PAGE_BUILD=1` to use an existing `app/out` as is.

use std::env;
use std::path::Path;
use std::process::{Command, Stdio};

const PAGE_INPUTS: &[&str] = &[
    "src",
    "public",
    "package.json",
    "pnpm-lock.yaml",
    "next.config.ts",
    "tsconfig.json",
];

fn main() {
    let app = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("app");
    for input in PAGE_INPUTS {
        println!("cargo:rerun-if-changed=app/{input}");
    }
    println!("cargo:rerun-if-env-changed=MKDP_SKIP_PAGE_BUILD");

    if env::var_os("MKDP_SKIP_PAGE_BUILD").is_some() {
        if !app.join("out/index.html").exists() {
            panic!("MKDP_SKIP_PAGE_BUILD is set but app/out has not been built");
        }
        return;
    }

    if !app.join("node_modules").exists() {
        pnpm(&app, &["install", "--frozen-lockfile"]);
    }
    pnpm(&app, &["run", "build"]);
}

fn pnpm(dir: &Path, args: &[&str]) {
    let (program, prefix): (&str, &[&str]) = if runs("pnpm") {
        ("pnpm", &[])
    } else if runs("npx") {
        ("npx", &["--yes", "pnpm@10"])
    } else {
        panic!("building the preview page needs Node.js with pnpm or npx on PATH");
    };
    let status = command(program)
        .args(prefix)
        .args(args)
        .current_dir(dir)
        .status()
        .unwrap_or_else(|err| panic!("failed to run {program}: {err}"));
    if !status.success() {
        panic!(
            "`{program} {}` in app/ failed with {status}",
            args.join(" ")
        );
    }
}

fn runs(program: &str) -> bool {
    command(program)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

// npm's shims are .cmd scripts on Windows, which only cmd can run
fn command(program: &str) -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/C", program]);
        command
    } else {
        Command::new(program)
    }
}
