<h1 align="center"> ✨ Markdown Preview for (Neo)vim ✨ </h1>

Preview Markdown in your browser with synchronised scrolling, math, diagrams and
flexible configuration.

![animation of Markdown Preview with its own README.md](https://user-images.githubusercontent.com/5492542/47603494-28e90000-da1f-11e8-9079-30646e551e7a.gif)

## Features

- Live updates and synchronised scrolling as you type.
- Cross platform (macOS, Linux, Windows, FreeBSD), no Node.js required.
- [Math](https://mkdp.sammaji.com/features/markdown#math) with KaTeX, including chemistry via
  mhchem.
- [Diagrams](https://mkdp.sammaji.com/features/diagrams): Mermaid (with a full-screen viewer and
  the ELK layout), PlantUML, Graphviz, flowchart.js, js-sequence-diagrams and
  Chart.js.
- [GitHub-flavoured extras](https://mkdp.sammaji.com/features/markdown): alerts, tables of
  contents, task lists, footnotes, emoji, front matter, local images with
  sizes.
- [Themes](https://mkdp.sammaji.com/features/themes): any
  [shadcn/ui](https://ui.shadcn.com/themes) or [tweakcn](https://tweakcn.com)
  theme with your own fonts, or your own CSS.
- [Share the preview](https://mkdp.sammaji.com/features/browser) with a phone or another
  machine, safely.

## Installation

Requires Neovim or Vim 8.1+. The plugin downloads a pre-built server binary for
macOS (x64, arm64), Linux (x64, arm64), FreeBSD (x64) and Windows (x64). If the
binary is missing or out of date, `:MarkdownPreview` downloads it first, so the
build hooks below only make the first preview faster.

### [lazy.nvim](https://github.com/folke/lazy.nvim)

```lua
{
  "sammaji/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  ft = { "markdown" },
  opts = {},
}
```

No `build` is needed: lazy.nvim runs the plugin's `build.lua` on install and
update.

### [packer.nvim](https://github.com/wbthomason/packer.nvim)

```lua
use({
  "sammaji/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  ft = { "markdown" },
  run = function() vim.fn["mkdp#util#install_sync"]() end,
})
```

### [vim-plug](https://github.com/junegunn/vim-plug)

```vim
Plug 'sammaji/markdown-preview.nvim', { 'do': { -> mkdp#util#install_sync() }, 'for': ['markdown', 'vim-plug'] }
```

### Other plugin managers

- [mini.deps](https://mkdp.sammaji.com/installation#minideps)
- [vim.pack (Neovim 0.12+)](https://mkdp.sammaji.com/installation#vimpack-neovim-012)
- [dein.vim](https://mkdp.sammaji.com/installation#deinvim)
- [Native packages, without a plugin manager](https://mkdp.sammaji.com/installation#native-packages-without-a-plugin-manager)
- [Moving from iamcco/markdown-preview.nvim](https://mkdp.sammaji.com/installation#moving-from-iamccomarkdown-previewnvim)

### Building from source

On a platform without a pre-built binary, or to run your own build:

```sh
cargo build --release
```

in the plugin directory. This needs Rust 1.86+ and Node.js 20.9+ with pnpm or
npx. A `target/release` build is always used before a downloaded binary. Run
`:checkhealth mkdp` to see which binary is used.

See [Installation](https://mkdp.sammaji.com/installation) for the details of each.

## Usage

| Command                  | Description                            |
| ------------------------ | -------------------------------------- |
| `:MarkdownPreview`       | Open the preview of the current buffer |
| `:MarkdownPreviewStop`   | Stop the preview                       |
| `:MarkdownPreviewToggle` | Open or stop the preview               |

Each command has a `<Plug>` mapping of the same name, e.g.
`<Plug>MarkdownPreviewToggle`. To map a key with lazy.nvim:

```lua
{
  "sammaji/markdown-preview.nvim",
  -- ...
  keys = {
    { "<leader>mp", "<cmd>MarkdownPreviewToggle<cr>", ft = "markdown", desc = "Markdown preview" },
  },
}
```

To see every feature, open [`examples/features.md`](examples/features.md) and
preview it. See [Quickstart](https://mkdp.sammaji.com/quickstart).

## Configuration

In Neovim, pass options to `setup()`, or to lazy.nvim's `opts`, named like the
`g:mkdp_*` variables without the prefix:

```lua
{
  "sammaji/markdown-preview.nvim",
  -- ...
  opts = {
    -- "dark" or "light"; by default the page follows the system
    theme = "dark",
    -- a browser name, or a command with arguments; the URL is appended
    browser = { "firefox", "--new-window" },
    -- keep the page open when you switch to another buffer
    auto_close = false,
    -- a shadcn/ui or tweakcn theme
    theme_css = vim.fn.expand("~/.config/nvim/mkdp-theme.css"),
    preview_options = {
      -- "middle", "top" or "relative"
      sync_scroll_type = "top",
      -- YAML front matter: "hide", "panel" or "raw"
      front_matter = "panel",
    },
  },
}
```

In Vim, set the variables before the plugin loads:

```vim
let g:mkdp_theme = 'dark'
let g:mkdp_browser = ['firefox', '--new-window']
let g:mkdp_auto_close = 0
let g:mkdp_preview_options = { 'sync_scroll_type': 'top' }
```

See the [configuration reference](https://mkdp.sammaji.com/configuration) for every option, and
[Theming](https://mkdp.sammaji.com/features/themes) for styling the page.

## Documentation

The documentation is at [mkdp.sammaji.com](https://mkdp.sammaji.com).

- [Quickstart](https://mkdp.sammaji.com/quickstart).
- [Installation](https://mkdp.sammaji.com/installation).
- [Live preview](https://mkdp.sammaji.com/features/live-preview),
  [Markdown](https://mkdp.sammaji.com/features/markdown), [Diagrams](https://mkdp.sammaji.com/features/diagrams),
  [Theming](https://mkdp.sammaji.com/features/themes),
  [Browser and sharing](https://mkdp.sammaji.com/features/browser).
- [Configuration reference](https://mkdp.sammaji.com/configuration).
- [FAQ](https://mkdp.sammaji.com/faq).
- [Contributing](https://mkdp.sammaji.com/contributing).

## Buy me a coffee

[Buy me a coffee](https://buymeacoffee.com/sammaji15)
