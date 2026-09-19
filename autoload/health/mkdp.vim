function! health#mkdp#check() abort
  lua vim.health.info("Platform: " .. vim.fn['mkdp#util#get_platform']())
  lua vim.health.info('Nvim Version: ' .. string.gsub(vim.fn.system('nvim --version'), '^%s*(.-)%s*$', '%1'))
  lua vim.health.info('Plugin version: ' .. vim.fn['mkdp#util#version']())
  let l:mkdp_server = mkdp#util#server_binary()
  if l:mkdp_server !=# ''
    lua vim.health.info('Server binary: ' .. vim.fn['mkdp#util#server_binary']())
    lua vim.health.info('Server version: ' .. string.gsub(vim.fn.system({vim.fn['mkdp#util#server_binary'](), '--version'}), '^%s*(.-)%s*$', '%1'))
    if mkdp#util#server_ready()
      lua vim.health.ok('Server binary found')
    else
      lua vim.health.warn('Server binary does not match the plugin version', { 'It is replaced on the next :MarkdownPreview' })
    endif
  else
    lua vim.health.error('Server binary not found', { 'It is downloaded on the first :MarkdownPreview', 'or run :call mkdp#util#install() to download it now', 'or run `cargo build --release` in the plugin directory' })
  endif
endfunction
