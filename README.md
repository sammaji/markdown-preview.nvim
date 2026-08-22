<h1 align="center"> ✨ Markdown Preview for (Neo)vim ✨ </h1>

Preview Markdown in your browser with synchronised scrolling, math, diagrams and
flexible configuration.

![animation of Markdown Preview with its own README.md](https://user-images.githubusercontent.com/5492542/47603494-28e90000-da1f-11e8-9079-30646e551e7a.gif)

## Features

- Cross platform (macOS, Linux, Windows), no Node.js required
- Live updates and synchronised scrolling as you type
- Math with [KaTeX](https://katex.org), including chemistry via mhchem
- Diagrams: [Mermaid](https://mermaid.js.org), [PlantUML](https://plantuml.com),
  [Graphviz](https://graphviz.org), [flowchart.js](https://flowchart.js.org),
  [js-sequence-diagrams](https://bramp.github.io/js-sequence-diagrams) and
  [Chart.js](https://www.chartjs.org) charts
- Syntax highlighting, table of contents, task lists, footnotes, definition
  lists and emoji
- Local images, with an optional size: `![logo](./logo.png =200x100)`
- Light and dark themes, custom CSS

See [`test/features.md`](test/features.md) for a document that uses every
feature; open it and run `:MarkdownPreview`.

## Installation

Requires Neovim or Vim 8.1+. The plugin downloads a pre-built server binary for
macOS (x64, arm64), Linux (x64) and Windows (x64). On other platforms, or to
build from source, use `cargo build --release` instead (needs
[Rust](https://rustup.rs) 1.86+ and Node.js 20.9+ with pnpm or npx).

### [lazy.nvim](https://github.com/folke/lazy.nvim)

```lua
{
  "sammaji/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  ft = { "markdown" },
  build = function() vim.fn["mkdp#util#install"]() end,
  -- or build from source:
  -- build = "cargo build --release",
}
```

### [packer.nvim](https://github.com/wbthomason/packer.nvim)

```lua
use({
  "sammaji/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  ft = { "markdown" },
  run = function() vim.fn["mkdp#util#install"]() end,
  -- or build from source:
  -- run = "cargo build --release",
})
```

### [vim-plug](https://github.com/junegunn/vim-plug)

```vim
Plug 'sammaji/markdown-preview.nvim', { 'do': { -> mkdp#util#install() }, 'for': ['markdown', 'vim-plug'] }
" or build from source:
" Plug 'sammaji/markdown-preview.nvim', { 'do': 'cargo build --release' }
```

Adding `vim-plug` to `for` loads the plugin in vim-plug's window, so the install
hook can run; see
[iamcco/markdown-preview.nvim#50](https://github.com/iamcco/markdown-preview.nvim/issues/50).

Run `:checkhealth mkdp` to check which server binary is used.

## Usage

| Command                  | Description                             |
| ------------------------ | --------------------------------------- |
| `:MarkdownPreview`       | Open the preview of the current buffer  |
| `:MarkdownPreviewStop`   | Stop the preview server                 |
| `:MarkdownPreviewToggle` | Open or stop the preview                |

The commands are available in buffers with a filetype from `g:mkdp_filetypes`.
Each has a `<Plug>` mapping of the same name, e.g. `<Plug>MarkdownPreviewToggle`.
To map a key with lazy.nvim:

```lua
{
  "sammaji/markdown-preview.nvim",
  -- ...
  keys = {
    { "<leader>mp", "<cmd>MarkdownPreviewToggle<cr>", ft = "markdown", desc = "Markdown preview" },
  },
}
```

## Configuration

Set options in the `init` function of the plugin spec, so they are defined
before the plugin loads. All options are optional; the values below are the
defaults unless noted.

```lua
{
  "sammaji/markdown-preview.nvim",
  -- ...
  init = function()
    -- open the preview when entering a markdown buffer
    vim.g.mkdp_auto_start = 0

    -- close the preview when switching from the markdown buffer to another one
    vim.g.mkdp_auto_close = 1

    -- 1: refresh only when saving or leaving insert mode
    -- 0: refresh as you edit or move the cursor
    vim.g.mkdp_refresh_slow = 0

    -- make the preview commands available in all buffers, not just markdown ones
    vim.g.mkdp_command_for_global = 0

    -- filetypes that get the preview commands
    vim.g.mkdp_filetypes = { "markdown" }

    -- listen on all interfaces so others in your network can open the preview;
    -- by default the server only listens on 127.0.0.1
    vim.g.mkdp_open_to_the_world = 0

    -- IP used in the preview URL, e.g. when editing on a remote machine and
    -- previewing in a local browser (see iamcco/markdown-preview.nvim#9)
    vim.g.mkdp_open_ip = ""

    -- port of the preview server; empty picks a random one. If the port is
    -- taken (e.g. by another (neo)vim instance), the next free port is used
    vim.g.mkdp_port = ""

    -- browser to open the preview in; empty uses the system default
    vim.g.mkdp_browser = ""

    -- name of a Vimscript function that opens the preview URL, instead of
    -- g:mkdp_browser (see FAQS.md)
    vim.g.mkdp_browserfunc = ""

    -- echo the preview URL when opening the preview
    vim.g.mkdp_echo_preview_url = 0

    -- page title, ${name} is replaced with the file name
    vim.g.mkdp_page_title = "「${name}」"

    -- "dark" or "light"; by default the theme follows the system preference
    vim.g.mkdp_theme = ""

    -- absolute paths of custom stylesheets for the markdown and code highlighting
    vim.g.mkdp_markdown_css = ""
    vim.g.mkdp_highlight_css = ""

    -- directory local images are resolved against; empty uses the directory
    -- of the markdown file
    vim.g.mkdp_images_path = ""

    -- reuse the open preview page when previewing another markdown buffer;
    -- set g:mkdp_auto_close = 0 when enabling this
    vim.g.mkdp_combine_preview = 0

    -- with g:mkdp_combine_preview, switch the preview page to a markdown
    -- buffer when entering it
    vim.g.mkdp_combine_preview_auto_refresh = 1

    -- rendering options
    vim.g.mkdp_preview_options = {
      -- markdown-it options: https://github.com/markdown-it/markdown-it#init-with-presets-and-options
      mkit = vim.empty_dict(),
      -- KaTeX options: https://katex.org/docs/options
      katex = vim.empty_dict(),
      -- PlantUML: { server = "https://www.plantuml.com/plantuml", imageFormat = "img" }
      uml = vim.empty_dict(),
      -- Mermaid options: https://mermaid.js.org/config/schema-docs/config.html
      maid = vim.empty_dict(),
      -- js-sequence-diagrams options, e.g. { theme = "simple" }
      sequence_diagrams = vim.empty_dict(),
      -- flowchart.js options: https://flowchart.js.org
      flowchart_diagrams = vim.empty_dict(),
      -- markdown-it-toc-done-right options
      toc = vim.empty_dict(),
      disable_sync_scroll = 0,
      -- "middle": keep the cursor line in the middle of the page
      -- "top": keep the top line of the editor window at the top of the page
      -- "relative": keep the cursor line at the same relative position as in the editor
      sync_scroll_type = "middle",
      -- hide YAML front matter
      hide_yaml_meta = 1,
      -- make the preview page editable
      content_editable = false,
      -- hide the file name header
      disable_filename = 0,
    }
  end,
}
```

> [!NOTE]
> Empty Lua tables are converted to Vim lists, so use `vim.empty_dict()` for
> empty option tables, or leave them out.

## FAQ

See [FAQS.md](FAQS.md) for answers to common questions, like fixing lagging
scroll or opening the preview in a new browser window.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Buy me a coffee

[Buy me a coffee](https://buymeacoffee.com/sammaji15)
