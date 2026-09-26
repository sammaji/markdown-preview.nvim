function! mkdp#init_command() abort
  command! -buffer MarkdownPreview call mkdp#util#open_preview_page()
  command! -buffer MarkdownPreviewStop call mkdp#util#stop_preview()
  command! -buffer MarkdownPreviewToggle call mkdp#util#toggle_preview()
  " mapping for user
  noremap <buffer> <silent> <Plug>MarkdownPreview :MarkdownPreview<CR>
  inoremap <buffer> <silent> <Plug>MarkdownPreview <Esc>:MarkdownPreview<CR>a
  noremap <buffer> <silent> <Plug>MarkdownPreviewStop :MarkdownPreviewStop<CR>
  inoremap <buffer> <silent> <Plug>MarkdownPreviewStop <Esc>:MarkdownPreviewStop<CR>a
  nnoremap <buffer> <silent> <Plug>MarkdownPreviewToggle :MarkdownPreviewToggle<CR>
  inoremap <buffer> <silent> <Plug>MarkdownPreviewToggle <Esc>:MarkdownPreviewToggle<CR>
endfunction

function! s:is_previewable() abort
  return g:mkdp_command_for_global || index(g:mkdp_filetypes, &filetype) !=# -1
endfunction

function! mkdp#init() abort
  augroup mkdp_init
    autocmd!
    if g:mkdp_command_for_global
      autocmd BufEnter * :call mkdp#init_command()
    else
      autocmd BufEnter,FileType * if index(g:mkdp_filetypes, &filetype) !=# -1 | call mkdp#init_command() | endif
    endif
    if g:mkdp_auto_start
      execute 'autocmd BufEnter *.{md,mkd,mdown,mkdn,mdwn,' . join(g:mkdp_filetypes, ',') . '} call mkdp#util#open_preview_page()'
    endif
    if g:mkdp_combine_preview && g:mkdp_combine_preview_auto_refresh
      execute 'autocmd BufEnter *.{md,mkd,mdown,mkdn,mdwn,' . join(g:mkdp_filetypes, ',') . '} call mkdp#util#combine_preview_refresh()'
    endif
  augroup END
  " the current buffer was entered before this ran, e.g. when a plugin
  " manager loads the plugin on its filetype
  if s:is_previewable()
    call mkdp#init_command()
  endif
endfunction
