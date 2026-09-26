"use client";

import type { MarkdownIt } from "markdown-it";
import { useCallback, useEffect, useRef, useState } from "react";

import { connect } from "@/lib/connection";
import { renderDiagrams, type Theme } from "@/lib/diagrams";
import { createRenderer } from "@/lib/markdown";
import type { PreviewData, PreviewOptions, ServerMessage } from "@/lib/protocol";
import { syncScroll } from "@/lib/scroll";

import { ThemeToggle } from "./theme-toggle";

interface Header {
  name: string;
  pageTitle: string;
  showFilename: boolean;
  editable: boolean;
}

// how long to wait for more keystrokes before re-rendering
const RENDER_DEBOUNCE_MS = 16;

export function bufnrFromUrl(): number {
  return Number(window.location.pathname.match(/\/page\/(\d+)/)?.[1] ?? NaN);
}

// file name without directory and extension
export function displayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function Preview() {
  const bodyRef = useRef<HTMLElement>(null);
  const [bufnr, setBufnr] = useState<number>();
  const [connected, setConnected] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [header, setHeader] = useState<Header>();
  // g:mkdp_theme until the user picks one with the toggle
  const [editorTheme, setEditorTheme] = useState<Theme>();
  const [chosenTheme, setChosenTheme] = useState<Theme>();
  const theme = chosenTheme ?? editorTheme;

  const md = useRef<MarkdownIt>(undefined);
  const options = useRef<PreviewOptions>({});
  const source = useRef<string>(undefined);
  const renderTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastScroll = useRef<() => void>(undefined);
  // read by the socket callback, which must not change on every toggle
  const chosenThemeRef = useRef(chosenTheme);
  useEffect(() => {
    chosenThemeRef.current = chosenTheme;
  }, [chosenTheme]);

  useEffect(() => setBufnr(bufnrFromUrl()), []);

  const render = useCallback(async (theme: Theme) => {
    const body = bodyRef.current;
    if (!body || !md.current || source.current === undefined) return;
    body.innerHTML = md.current.render(source.current);
    lastScroll.current?.();
    await renderDiagrams(body, options.current, theme);
    // diagrams change the height of the page
    lastScroll.current?.();
  }, []);

  const onRefresh = useCallback(
    (data: PreviewData) => {
      options.current = data.options ?? {};
      md.current ??= createRenderer(options.current);

      const nextEditorTheme = data.theme === "dark" || data.theme === "light" ? data.theme : systemTheme();
      setEditorTheme(nextEditorTheme);
      setHeader({
        name: displayName(data.name),
        pageTitle: data.pageTitle ?? "",
        showFilename: !data.options?.disable_filename,
        editable: Boolean(data.options?.content_editable),
      });

      lastScroll.current = () => {
        if (!data.isActive || data.options?.disable_sync_scroll) return;
        const scroll = syncScroll[data.options?.sync_scroll_type ?? "middle"] ?? syncScroll.middle;
        scroll({
          cursor: data.cursor[1],
          winline: data.winline,
          winheight: data.winheight,
          len: data.content.length,
        });
      };

      const text = data.content.join("\n");
      if (text === source.current) {
        lastScroll.current();
        return;
      }
      const firstRender = source.current === undefined;
      source.current = text;
      clearTimeout(renderTimer.current);
      const run = () => render(chosenThemeRef.current ?? nextEditorTheme);
      if (firstRender) {
        run();
      } else {
        renderTimer.current = setTimeout(run, RENDER_DEBOUNCE_MS);
      }
    },
    [render],
  );

  const onMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "refresh_content":
          onRefresh(message.data);
          break;
        case "close_page":
          setStopped(true);
          // only works for windows opened by a script
          window.close();
          break;
        case "change_bufnr":
          // g:mkdp_combine_preview: show another buffer in this page
          window.history.replaceState(null, "", `/page/${message.bufnr}`);
          source.current = undefined;
          setBufnr(message.bufnr);
          break;
      }
    },
    [onRefresh],
  );

  useEffect(() => {
    if (bufnr === undefined || Number.isNaN(bufnr)) return;
    return connect(bufnr, onMessage, setConnected);
  }, [bufnr, onMessage]);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (header) document.title = header.pageTitle.replace("${name}", header.name);
  }, [header]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setChosenTheme(next);
    // diagrams are drawn with theme colors
    render(next);
  };

  if (bufnr !== undefined && Number.isNaN(bufnr)) {
    return <p className="notice">Open this page with :MarkdownPreview.</p>;
  }

  return (
    <main>
      <div id="page-ctn" contentEditable={header?.editable} suppressContentEditableWarning>
        {header?.showFilename && (
          <header id="page-header">
            <h3>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M3 5h4v1H3V5zm0 3h4V7H3v1zm0 2h4V9H3v1zm11-5h-4v1h4V5zm0 2h-4v1h4V7zm0 2h-4v1h4V9zm2-6v9c0 .55-.45 1-1 1H9.5l-1 1-1-1H2c-.55 0-1-.45-1-1V3c0-.55.45-1 1-1h5.5l1 1 1-1H15c.55 0 1 .45 1 1zm-8 .5L7.5 3H2v9h6V3.5zm7-.5H9.5l-.5.5V12h6V3z"
                />
              </svg>
              {header.name}
            </h3>
            <div className="header-actions">
              {(stopped || !connected) && (
                <span className="status">{stopped ? "Preview stopped" : "Disconnected"}</span>
              )}
              <ThemeToggle theme={theme ?? "light"} onToggle={toggleTheme} />
            </div>
          </header>
        )}
        <section className="markdown-body" ref={bodyRef} />
      </div>
    </main>
  );
}
