local root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h")

vim.opt.runtimepath:prepend(root)

vim.fn["mkdp#util#install_sync"](true)

if vim.fn["mkdp#util#server_ready"]() ~= 1 then
	error(
		"markdown-preview.nvim: could not install the server binary. "
			.. "The next :MarkdownPreview will try again, or run "
			.. "`cargo build --release` in "
			.. root
	)
end
