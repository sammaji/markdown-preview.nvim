function! health#mkdp#check() abort
  lua vim.health.info("Platform: " .. vim.fn['mkdp#util#get_platform']())
  lua vim.health.info('Nvim Version: ' .. string.gsub(vim.fn.system('nvim --version'), '^%s*(.-)%s*$', '%1'))
  lua vim.health.info('Plugin version: ' .. vim.fn['mkdp#util#version']())
  let l:mkdp_server = mkdp#util#server_binary()
  if l:mkdp_server !=# ''
    lua vim.health.info('Server binary: ' .. vim.fn['mkdp#util#server_binary']())
    lua vim.health.info('Server version: ' .. string.gsub(vim.fn.system({vim.fn['mkdp#util#server_binary'](), '--version'}), '^%s*(.-)%s*$', '%1'))
    lua vim.health.ok('Server binary found')
  else
    lua vim.health.error('Server binary not found', { 'Run :call mkdp#util#install() to download a pre built binary', 'or run `cargo build --release` in the plugin directory' })
  endif
endfunction
