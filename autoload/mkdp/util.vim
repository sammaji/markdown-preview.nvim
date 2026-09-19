let s:mkdp_root_dir = expand('<sfile>:h:h:h')
let s:pre_build = s:mkdp_root_dir . '/app/bin/markdown-preview-'
let s:exe = has('win32') || has('win64') ? '.exe' : ''
let s:local_build = s:mkdp_root_dir . '/target/release/markdown-preview' . s:exe
" a download is in flight, or one failed and is not retried until the next
" explicit mkdp#util#install()
let s:installing = 0
let s:install_error = ''

" echo message
function! mkdp#util#echo_messages(hl, msgs)
  if empty(a:msgs) | return | endif
  execute 'echohl '.a:hl
  if type(a:msgs) ==# 1
    echomsg a:msgs
  else
    for msg in a:msgs
      echom msg
    endfor
  endif
  echohl None
endfunction

" echo url
function! mkdp#util#echo_url(url)
  let l:url = 'Preview page: ' . a:url
  call mkdp#util#echo_messages('Type', l:url)
endfunction

" try open preview page
function! s:try_open_preview_page(timer_id) abort
  let l:server_status = mkdp#rpc#get_server_status()
  if l:server_status !=# 1
    let s:try_id = ''
    call mkdp#rpc#stop_server()
    call mkdp#rpc#start_server()
  endif
endfunction

" open preview page, downloading the server binary first when it is missing or
" does not match the plugin version
function! mkdp#util#open_preview_page() abort
  if get(s:, 'try_id', '') !=# ''
    return
  endif
  if mkdp#util#server_ready()
    call s:open_preview_page()
  else
    call s:install_server(bufnr('%'))
  endif
endfunction

function! s:open_preview_page() abort
  let l:server_status = mkdp#rpc#get_server_status()
  if l:server_status ==# -1
    call mkdp#rpc#start_server()
  elseif l:server_status ==# 0
    let s:try_id = timer_start(1000, function('s:try_open_preview_page'))
  else
    call mkdp#util#open_browser()
  endif
endfunction

" auto refetch combine preview
function! mkdp#util#combine_preview_refresh() abort
  if g:mkdp_clients_active && !g:mkdp_auto_start
    call mkdp#util#open_browser()
  endif
endfunction

" open browser
function! mkdp#util#open_browser() abort
  call mkdp#rpc#open_browser()
  call mkdp#autocmd#init()
endfunction

function! mkdp#util#stop_preview() abort
  let g:mkdp_clients_active = 0
  " TODO: delete autocmd
  call mkdp#rpc#stop_server()
endfunction

function! mkdp#util#get_platform() abort
  if has('win32') || has('win64')
    return 'win'
  elseif has('mac') || has('macvim')
    if system('arch') =~? 'arm64'
      return 'macos-arm64'
    endif
    return 'macos'
  endif
  return 'linux'
endfunction

function! s:on_exit(autoclose, bufnr, Callback, job_id, status, ...)
  let content = join(getbufline(a:bufnr, 1, '$'), "\n")
  if a:status == 0 && a:autoclose == 1
    execute 'silent! bd! '.a:bufnr
  endif
  if !empty(a:Callback)
    call call(a:Callback, [a:status, a:bufnr, content])
  endif
endfunction

function! mkdp#util#open_terminal(opts) abort
  if get(a:opts, 'position', 'bottom') ==# 'bottom'
    let p = '5new'
  else
    let p = 'vnew'
  endif
  execute 'belowright '.p.' +setl\ buftype=nofile '
  setl buftype=nofile
  setl winfixheight
  setl norelativenumber
  setl nonumber
  setl bufhidden=wipe
  let cmd = get(a:opts, 'cmd', '')
  let autoclose = get(a:opts, 'autoclose', 1)
  if empty(cmd)
    throw 'command required!'
  endif
  let cwd = get(a:opts, 'cwd', '')
  if !empty(cwd) | execute 'lcd '.cwd | endif
  let keepfocus = get(a:opts, 'keepfocus', 0)
  let bufnr = bufnr('%')
  let Callback = get(a:opts, 'Callback', v:null)
  if has('nvim')
    call termopen(cmd, {
          \ 'on_exit': function('s:on_exit', [autoclose, bufnr, Callback]),
          \})
  else
    call term_start(cmd, {
          \ 'exit_cb': function('s:on_exit', [autoclose, bufnr, Callback]),
          \ 'curwin': 1,
          \})
  endif
  if keepfocus
    wincmd p
  endif
  return bufnr
endfunction

function! s:markdown_preview_installed(status, ...) abort
  let s:installing = 0
  if a:status != 0
    call mkdp#util#echo_messages('Error', '[markdown-preview]: install fail')
    return
  endif
  echo '[markdown-preview.nvim]: install completed'
endfunction

function! s:trim(str) abort
  " [[:space:]] also covers the \r of a Windows binary's --version output
  return substitute(a:str, '\v^[[:space:]]*|[[:space:]]*$', '', 'g')
endfunction

" version of the plugin, read from Cargo.toml
function! mkdp#util#version() abort
  for l:line in readfile(s:mkdp_root_dir . '/Cargo.toml')
    let l:match = matchlist(l:line, '\v^version\s*\=\s*"([^"]+)"')
    if !empty(l:match)
      return l:match[1]
    endif
  endfor
  return ''
endfunction

" path of the server binary: a local `cargo build --release` takes precedence
" over the pre built binary downloaded by mkdp#util#install()
function! mkdp#util#server_binary() abort
  if executable(s:local_build)
    return s:local_build
  endif
  let l:pre_build = s:pre_build . mkdp#util#get_platform() . s:exe
  if executable(l:pre_build)
    return l:pre_build
  endif
  return ''
endfunction

" everything the preview page needs to render a buffer, in one round trip
function! mkdp#util#preview_data(bufnr) abort
  if !bufexists(a:bufnr)
    return v:null
  endif
  return {
        \ 'options': get(g:, 'mkdp_preview_options', {}),
        \ 'isActive': bufnr('%') ==# a:bufnr,
        \ 'winline': winline(),
        \ 'winheight': winheight(0),
        \ 'cursor': getpos('.'),
        \ 'pageTitle': get(g:, 'mkdp_page_title', ''),
        \ 'theme': get(g:, 'mkdp_theme', ''),
        \ 'name': fnamemodify(bufname(a:bufnr), ':p'),
        \ 'content': getbufline(a:bufnr, 1, '$'),
        \ }
endfunction

" 1 when a server binary matching the plugin version is available, so
" :MarkdownPreview can start it without downloading anything
function! mkdp#util#server_ready() abort
  " a local cargo build (see mkdp#util#server_binary) is used as is
  if executable(s:local_build)
    return 1
  endif
  let l:version = mkdp#util#version()
  if l:version ==# ''
    " no version to compare against, use whatever is installed
    return mkdp#util#server_binary() !=# ''
  endif
  return s:trim(mkdp#util#pre_build_version()) ==# l:version
endfunction

function! s:install_cmd(version) abort
  return (mkdp#util#get_platform() ==# 'win' ? 'install.cmd' : './install.sh') . ' v' . a:version
endfunction

" download the server binary and, once it is there, open the preview of
" a:bufnr. The download runs in a terminal, so it blocks neither Vim nor Neovim.
function! s:install_server(bufnr) abort
  if s:installing
    return
  endif
  if s:install_error !=# ''
    " a failed download is not retried until :call mkdp#util#install()
    call mkdp#util#echo_messages('Error', s:install_error)
    return
  endif
  let l:version = mkdp#util#version()
  if l:version ==# ''
    call mkdp#util#echo_messages('Error', '[markdown-preview.nvim]: cannot read the plugin version from Cargo.toml')
    return
  endif
  let s:installing = 1
  call mkdp#util#echo_messages('Type', '[markdown-preview.nvim]: downloading server binary v' . l:version . ' ...')
  call mkdp#util#open_terminal({
        \ 'cmd': s:install_cmd(l:version),
        \ 'cwd': s:mkdp_root_dir . '/app',
        \ 'keepfocus': 1,
        \ 'Callback': function('s:server_installed', [a:bufnr])
        \})
endfunction

function! s:server_installed(bufnr, status, ...) abort
  let s:installing = 0
  " install.sh exits 0 on a platform without a pre built binary, so check that
  " the binary is really there rather than trusting the exit status alone
  if a:status != 0 || !mkdp#util#server_ready()
    let s:install_error = '[markdown-preview.nvim]: could not download the server binary, run :call mkdp#util#install() or `cargo build --release` in the plugin directory'
    call mkdp#util#echo_messages('Error', s:install_error)
    return
  endif
  call mkdp#util#echo_messages('Type', '[markdown-preview.nvim]: install completed')
  let l:wins = win_findbuf(a:bufnr)
  if empty(l:wins)
    return
  endif
  call win_gotoid(l:wins[0])
  call mkdp#rpc#stop_server()
  call s:open_preview_page()
endfunction

" Vim reports a tab local directory as haslocaldir() == 2, Neovim reports 0 and
" only tells about it when asked with the tab argument
function! s:has_tab_dir() abort
  return exists(':tcd') ==# 2 && haslocaldir() ==# 0 && haslocaldir(-1, 0) !=# 0
endfunction

function! mkdp#util#install(...)
  " an explicit install retries a download that failed earlier
  let s:install_error = ''
  if mkdp#util#server_ready()
    return
  endif
  let l:version = mkdp#util#version()
  if l:version ==# ''
    call mkdp#util#echo_messages('Error', '[markdown-preview.nvim]: cannot read the plugin version from Cargo.toml')
    return
  endif
  let cmd = s:install_cmd(l:version)
  if get(a:, '1', v:false) ==# v:true
    " blocking, so a plugin manager's build hook waits for the download. Restore
    " the window's directory afterwards: the hook runs in the user's window
    let l:cwd = getcwd()
    let l:localdir = haslocaldir()
    let l:tabdir = s:has_tab_dir()
    try
      execute 'lcd ' . fnameescape(s:mkdp_root_dir . '/app')
      execute '!' . cmd
    finally
      if l:localdir ==# 1
        execute 'lcd ' . fnameescape(l:cwd)
      elseif l:localdir ==# 2 || l:tabdir
        execute 'tcd ' . fnameescape(l:cwd)
      else
        execute 'cd ' . fnameescape(l:cwd)
      endif
    endtry
  else
    if s:installing
      return
    endif
    let s:installing = 1
    call mkdp#util#open_terminal({
          \ 'cmd': cmd,
          \ 'cwd': s:mkdp_root_dir . '/app',
          \ 'keepfocus': 1,
          \ 'Callback': function('s:markdown_preview_installed')
          \})
  endif
endfunction

function! mkdp#util#install_sync(...)
  if get(a:, '1', v:false) ==# v:true
    silent call mkdp#util#install(v:true)
  else
    call mkdp#util#install(v:true)
  endif
endfunction

function! mkdp#util#pre_build_version() abort
  let l:pre_build = s:pre_build . mkdp#util#get_platform() . s:exe
  if filereadable(l:pre_build)
    let l:info = system(shellescape(l:pre_build) . ' --version')
    if l:info ==# ''
      call mkdp#util#echo_messages('Type', "[markdown-preview.nvim]: Can not execute pre build binary bundle to get version, will download latest pre build binary bundle")
      return ''
    endif
    let l:info = split(l:info, '\n')
    return l:info[0]
  endif
  return ''
endfunction

function! mkdp#util#toggle_preview() abort
    if !get(b:, 'MarkdownPreviewToggleBool')
        call mkdp#util#open_preview_page()
        let b:MarkdownPreviewToggleBool=1
    else
        call mkdp#util#stop_preview()
        let b:MarkdownPreviewToggleBool=0
    endif
endfunction

