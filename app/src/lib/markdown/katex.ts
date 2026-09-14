// $inline$ and $$block$$ math rendered with KaTeX.
// Forked from https://github.com/waylonflinn/markdown-it-katex
import katex, { type KatexOptions } from "katex";
import "katex/contrib/mhchem";
import type { MarkdownIt, StateBlock, StateInline } from "markdown-it";

import { escapeHtml } from "./utils";

// Whether a `$` at `pos` can open and/or close a math span.
function delimiterAt(state: StateInline, pos: number) {
  const prev = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
  const next = pos + 1 <= state.posMax ? state.src.charCodeAt(pos + 1) : -1;
  const isBlank = (code: number) => code === 0x20 || code === 0x09;
  return {
    canOpen: !isBlank(next),
    // "$5 and $6" must not become math
    canClose: !isBlank(prev) && !(next >= 0x30 && next <= 0x39),
  };
}

function mathInline(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "$") return false;

  if (!delimiterAt(state, state.pos).canOpen) {
    if (!silent) state.pending += "$";
    state.pos += 1;
    return true;
  }

  // find the closing `$`, skipping escaped ones
  const start = state.pos + 1;
  let match = start;
  while ((match = state.src.indexOf("$", match)) !== -1) {
    let pos = match - 1;
    while (state.src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) break;
    match += 1;
  }

  if (match === -1) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (match === start) {
    if (!silent) state.pending += "$$";
    state.pos = start + 1;
    return true;
  }
  if (!delimiterAt(state, match).canClose) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

function mathBlock(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "$$") return false;
  if (silent) return true;

  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = "";
  let found = false;
  if (firstLine.trim().slice(-2) === "$$") {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }

  let next = start;
  while (!found) {
    next++;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    // a non-empty line with negative indent ends the enclosing list
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
      lastLine = state.src.slice(pos, state.src.slice(0, max).lastIndexOf("$$"));
      found = true;
    }
  }

  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content =
    (firstLine.trim() ? `${firstLine}\n` : "") +
    state.getLines(start + 1, next, state.tShift[start], true) +
    (lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = "$$";
  return true;
}

export default function katexPlugin(md: MarkdownIt, options: KatexOptions = {}) {
  const render = (latex: string, displayMode: boolean) => {
    try {
      return katex.renderToString(latex, { displayMode, ...options });
    } catch (error) {
      if (options.throwOnError) console.error(error);
      return escapeHtml(latex);
    }
  };

  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens, idx) => render(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) => `<p>${render(tokens[idx].content, true)}</p>\n`;
}
