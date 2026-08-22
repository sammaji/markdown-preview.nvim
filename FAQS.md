# Frequently asked questions

## Why is the synchronised scrolling lagging?

Part of the refreshes are triggered by `CursorHold`, which waits `updatetime`
milliseconds after the cursor stops. Set it to a lower value:

```lua
vim.opt.updatetime = 100
```

## How do I change between the dark and light theme?

The theme follows your system preference, or `g:mkdp_theme` if it is set. To
switch it in the page, hover the header and click the theme button.

## How do I open the preview in a new browser window?

Point `g:mkdp_browserfunc` at a Vimscript function that opens the URL with the
options you want.

Linux:

```lua
vim.cmd([[
  function! OpenMarkdownPreview(url)
    execute "silent ! firefox --new-window " . a:url
  endfunction
]])
vim.g.mkdp_browserfunc = "OpenMarkdownPreview"
```

Replace `firefox` with `chrome` if you prefer; both support `--new-window`.

macOS:

```lua
vim.cmd([[
  function! OpenMarkdownPreview(url)
    execute "silent ! open -a Firefox -n --args --new-window " . a:url
  endfunction
]])
vim.g.mkdp_browserfunc = "OpenMarkdownPreview"
```

Replace `Firefox` with `Google\ Chrome` or `Brave\ Browser` if you prefer; they
all support `--new-window`.

## The browser does not open in WSL 2

Install `xdg-utils`, e.g. `sudo apt-get install -y xdg-utils` on Ubuntu. See
[iamcco/markdown-preview.nvim#199](https://github.com/iamcco/markdown-preview.nvim/issues/199)
for details.

## My Chart.js charts stopped rendering after upgrading

Charts use Chart.js 4. Configs written for Chart.js 2 need to be migrated, see
the [Chart.js migration guide](https://www.chartjs.org/docs/latest/migration/v3-migration.html).
