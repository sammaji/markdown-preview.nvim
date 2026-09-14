# `sammaji/markdown-preview.nvim` changelog

## v0.1.0

The preview server is rewritten in Rust and the preview page is rebuilt on
Next.js 16. **Node.js is no longer needed to use the plugin.**

#### Breaking changes
- The server is a single self-contained binary. Install it with
  `mkdp#util#install()` (downloads a pre-built binary for macOS x64/arm64,
  Linux x64 or Windows x64) or build it with `cargo build --release`.
  Build hooks such as `build = "npm install"` or `cd app && yarn install` no
  longer work and must be replaced.
- Building from source needs Rust 1.86+ and Node.js 20.9+ with pnpm (or npx);
  `cargo build` builds the preview page automatically.
- Charts use Chart.js 4. Chart configs written for Chart.js 2 need to be
  migrated, e.g. `options.scales.xAxes` becomes `options.scales.x`.
- The preview page talks to the server over a WebSocket at `/ws` instead of
  socket.io.

#### Added
- Starting a preview no longer fails when `g:mkdp_port` is taken; the next free
  port is used instead.
- The theme toggle redraws diagrams in the new theme.
- The page header shows when the page is disconnected from the editor or the
  preview was stopped, and the page reconnects automatically.
- Reloading the preview page works.
- `:checkhealth mkdp` shows the server binary in use and its version.
- A GitHub Actions workflow builds and publishes release binaries for tags.
- `test/features.md`, a sample document that uses every feature.

#### Changed
- The preview page is rebuilt with Next.js 16, React 19 and TypeScript, with
  updated renderers: markdown-it 15, KaTeX 0.18, Mermaid 12, highlight.js 11 and
  Graphviz through `@viz-js/viz`.
- Mermaid, Chart.js, flowchart, sequence diagram and Graphviz libraries are only
  loaded when a document uses them, cutting the initial page download from about
  8 MB to 1.5 MB.
- Buffer refreshes fetch everything from the editor in a single request, and
  bursts of cursor movement are coalesced into one refresh.
- Files are served with correct content types.

#### Fixed
- Opening previews from several vim or neovim instances with the same `g:mkdp_port`
  showed an uncaught exception (`processTicksAndRejections`) instead of a
  preview.
- `g:mkdp_clients_active` stayed set after preview pages disconnected.
- HTML in diagram sources and image alt texts could break the page.

#### Removed
- The Node.js server, including the `node app/index.js` fallback, and the
  vendored copies of KaTeX, Mermaid, viz.js, flowchart.js, Raphaël and TweenLite.

#### Authors
- [@sammaji](https://github.com/sammaji)

## v0.0.10
- Initial release mirroring the [original repository](https://github.com/iamcco/markdown-preview.nvim).

#### Authors
- [@sammaji](https://github.com/sammaji)
