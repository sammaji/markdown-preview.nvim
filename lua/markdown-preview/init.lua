local M = {}

local OPTIONS = {
	auto_start = "boolean",
	auto_close = "boolean",
	refresh_slow = "boolean",
	command_for_global = "boolean",
	open_to_the_world = "boolean",
	open_ip = "string",
	browser = { "string", "table" },
	browserfunc = "string",
	echo_preview_url = "boolean",
	preview_options = "table",
	markdown_css = "string",
	highlight_css = "string",
	theme_css = "string",
	port = { "string", "number" },
	page_title = "string",
	theme = "string",
	filetypes = "table",
	images_path = "string",
	combine_preview = "boolean",
	combine_preview_auto_refresh = "boolean",
	on_start = { "function", "string" },
	on_stop = { "function", "string" },
}

local function accepts(expected, value)
	if type(expected) == "string" then
		expected = { expected }
	end
	for _, t in ipairs(expected) do
		-- 0 and 1 are the Vimscript way to write booleans
		if type(value) == t or (t == "boolean" and (value == 0 or value == 1)) then
			return true
		end
	end
	return false
end

local function warn(msg)
	vim.notify("markdown-preview.nvim: " .. msg, vim.log.levels.WARN)
end

---@param opts table|nil options named like g:mkdp_* without the prefix
function M.setup(opts)
	opts = opts or {}
	for name, value in pairs(opts) do
		local expected = OPTIONS[name]
		if not expected then
			warn(("unknown option %q"):format(name))
		elseif not accepts(expected, value) then
			warn(
				("option %q should be a %s, got a %s"):format(
					name,
					type(expected) == "table" and table.concat(expected, " or ") or expected,
					type(value)
				)
			)
		else
			if type(value) == "boolean" then
				value = value and 1 or 0
			elseif name == "preview_options" then
				-- keep the defaults for the keys that are not given
				value = vim.tbl_deep_extend("force", vim.g.mkdp_preview_options or {}, value)
			end
			vim.g["mkdp_" .. name] = value
		end
	end
	if vim.g.mkdp_filetypes ~= nil then
		vim.fn["mkdp#init"]()
	end
end

return M
