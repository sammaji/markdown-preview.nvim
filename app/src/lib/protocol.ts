// Messages exchanged with the preview server over the /ws WebSocket.
import type { KatexOptions } from "katex";
import type { MarkdownItOptions } from "markdown-it";

import type { UmlOptions } from "./markdown/plantuml";

/** `g:mkdp_preview_options` */
export interface PreviewOptions {
  mkit?: MarkdownItOptions;
  katex?: KatexOptions;
  uml?: UmlOptions;
  maid?: Record<string, unknown>;
  disable_sync_scroll?: number | boolean;
  sync_scroll_type?: "middle" | "top" | "relative";
  hide_yaml_meta?: number;
  sequence_diagrams?: Record<string, unknown>;
  flowchart_diagrams?: Record<string, unknown>;
  content_editable?: number | boolean;
  disable_filename?: number | boolean;
  toc?: Record<string, unknown>;
}

/** Built by `mkdp#util#preview_data()` */
export interface PreviewData {
  options: PreviewOptions;
  isActive: number | boolean;
  winline: number;
  winheight: number;
  /** `getpos('.')`: [bufnum, lnum, col, off] */
  cursor: [number, number, number, number];
  pageTitle: string;
  theme: string;
  name: string;
  content: string[];
}

export type ServerMessage =
  | { type: "refresh_content"; data: PreviewData }
  | { type: "close_page" }
  | { type: "change_bufnr"; bufnr: number };
