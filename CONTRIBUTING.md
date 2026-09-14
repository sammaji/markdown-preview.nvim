# Contributing

Thanks for helping out! Bug reports, fixes and features are all welcome. For
larger changes, please open an issue first so we can agree on the approach.

## How it works

```
(neo)vim ──stdio──▶ server (Rust) ──HTTP + WebSocket──▶ preview page (browser)
```

| Path | What it is |
| --- | --- |
| `plugin/`, `autoload/mkdp/` | The Vim plugin: options, commands, autocmds, and starting the server. |
| `autoload/nvim/api.vim` | Emulates the Neovim API on top of Vim channels, for Vim support. |
| `src/` | The preview server. It talks to the editor over stdio (msgpack-rpc for Neovim, a JSON channel for Vim), serves the page and pushes buffer updates to it. |
| `app/` | The preview page, a Next.js app. Markdown is rendered in the browser. |
| `build.rs` | Builds `app/` into `app/out`, which is embedded into the server binary. |

The flow of a preview:

1. `:MarkdownPreview` starts the server binary as a job (`autoload/mkdp/rpc.vim`).
2. The server binds `g:mkdp_port` (or the next free port) and asks the editor to
   open `http://localhost:<port>/page/<bufnr>`.
3. The page connects to `/ws?bufnr=<bufnr>`.
4. On cursor movement and edits, the editor notifies the server
   (`refresh_content`). The server fetches the buffer with
   `mkdp#util#preview_data()` and sends it to the page, which renders it and
   scrolls to the cursor.

The WebSocket messages are defined in `app/src/lib/protocol.ts`.

## Setup

You need:

- [Rust](https://rustup.rs) 1.86 or newer
- Node.js 20.9 or newer with [pnpm](https://pnpm.io) (or npx, which fetches pnpm)
- Neovim, and Vim 8.1+ if you are touching Vim support

Build the server and the page:

```sh
git clone https://github.com/sammaji/markdown-preview.nvim.git
cd markdown-preview.nvim
cargo build --release
```

`cargo build` builds the page whenever a file in `app/` changed, and installs
its dependencies first if `app/node_modules` is missing. To skip the page build
and reuse the existing `app/out`, set `MKDP_SKIP_PAGE_BUILD=1`.

Then load your checkout instead of the published plugin. With lazy.nvim:

```lua
{
  dir = "~/path/to/markdown-preview.nvim",
  name = "markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  ft = { "markdown" },
  build = "cargo build --release",
}
```

A local build in `target/release` takes precedence over a downloaded binary.
`:checkhealth mkdp` shows which binary is used.

## Making changes

After changing the server or the page, run `cargo build --release` and restart
the preview with `:MarkdownPreviewStop` and `:MarkdownPreview`. Each editor
keeps its server running, so an open preview still uses the old binary.

Vim script changes take effect after restarting the editor.

### Checks

Run these before opening a pull request:

```sh
cargo fmt --check
cargo clippy --release

cd app
pnpm typecheck
pnpm build
```

### Testing

There are no automated tests yet, so please test your change manually:

- Open [`test/features.md`](test/features.md) and run `:MarkdownPreview`. Every
  section should render, and the page should follow the cursor.
- Check the browser console for errors.
- If you changed the server or the Vim scripts, also try:
  - two editor instances with the same `g:mkdp_port`
  - `:MarkdownPreviewStop` and `g:mkdp_auto_close`
  - `g:mkdp_combine_preview = 1`
  - Vim, if your change affects it

To see what the server does, start the editor with debug logging:

```sh
NVIM_MKDP_LOG_LEVEL=debug NVIM_MKDP_LOG_FILE=/tmp/mkdp.log nvim test/features.md
```

Without these variables, the log is written to `mkdp-nvim.log` in the system
temp directory.

The server communicates over stdout, so never print to stdout or stderr from
it; use the `info!`, `debug!` and `error!` macros from `src/logger.rs` instead.

## Pull requests

- Target the `master` branch.
- Keep pull requests focused on one change.
- Describe what you changed and how you tested it.
- Add an entry to [`CHANGELOG.md`](CHANGELOG.md) for user-facing changes.

## Releasing

For maintainers:

1. Bump `version` in `Cargo.toml` and update `CHANGELOG.md`.
2. Commit and push to `master`.
3. Run `./release.sh`. It tags the version from `Cargo.toml` and pushes the
   tag, and the release workflow builds the binaries and publishes the GitHub
   release.

`mkdp#util#install()` downloads the release matching the plugin's `Cargo.toml`
version, so the tag must exist before users update to the new version.
