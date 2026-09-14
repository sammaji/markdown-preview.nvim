// Local images and the `![alt](src =WxH)` size syntax.
import type { MarkdownIt, StateInline, Token } from "markdown-it";

import { escapeHtml } from "./utils";

const REMOTE = /^(https?:|\/\/|data:)/;

// Relative and absolute file paths are served by the preview server, which
// resolves them against the directory of the buffer.
function localSrc(src: string): string {
  return REMOTE.test(src) ? src : `/_local_image_${encodeURIComponent(src)}`;
}

const HTML_IMG_SRC = /<img\s+([^>]*?)src\s*=\s*(["'])(.+?)\2([^>]*)>/gm;

function rewriteHtml(html: string): string {
  return html.replace(HTML_IMG_SRC, (match, before, quote, src, after) =>
    REMOTE.test(src) ? match : `<img ${before}src=${quote}${localSrc(src)}${quote}${after}>`,
  );
}

// `=300x200`, `=300x`, `=x200` or percentages, before the closing paren
const SIZE = /^([\s\S]*?)\s+=([\d%]*)x([\d%]*)\s*$/;

// Matches `![alt](src "title" =WxH)` and parses it as a regular image with
// the size spec removed.
function imageWithSize(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x21 /* ! */ || src.charCodeAt(pos + 1) !== 0x5b /* [ */) return false;
  const labelEnd = state.md.helpers.parseLinkLabel(state, pos + 1, false);
  if (labelEnd < 0 || src.charCodeAt(labelEnd + 1) !== 0x28 /* ( */) return false;
  const close = src.indexOf(")", labelEnd + 2);
  if (close < 0 || close >= state.posMax) return false;
  const size = SIZE.exec(src.slice(labelEnd + 2, close));
  if (!size || (!size[2] && !size[3])) return false;

  const tokens: Token[] = [];
  state.md.inline.parse(`${src.slice(pos, labelEnd + 2)}${size[1]})`, state.md, state.env, tokens);
  if (tokens.length !== 1 || tokens[0].type !== "image") return false;

  if (!silent) {
    const parsed = tokens[0];
    const token = state.push("image", "img", 0);
    token.attrs = parsed.attrs;
    token.children = parsed.children;
    token.content = parsed.content;
    if (size[2]) token.attrSet("width", size[2]);
    if (size[3]) token.attrSet("height", size[3]);
  }
  state.pos = close + 1;
  return true;
}

export default function imagesPlugin(md: MarkdownIt) {
  md.inline.ruler.before("image", "image_with_size", imageWithSize);

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const attrs = (token.attrs ?? [])
      .filter(([name]) => name !== "src" && name !== "alt")
      .map(([name, value]) => ` ${name}="${escapeHtml(String(value))}"`)
      .join("");
    const alt = self.renderInlineAsText(token.children ?? [], options, env);
    return `<img src="${escapeHtml(localSrc(String(token.attrGet("src") ?? "")))}" alt="${escapeHtml(alt)}"${attrs} />`;
  };
  md.renderer.rules.html_block = (tokens, idx) => rewriteHtml(tokens[idx].content);
  md.renderer.rules.html_inline = (tokens, idx) => rewriteHtml(tokens[idx].content);
}
