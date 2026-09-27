import type { MarkdownIt, StateBlock } from "markdown-it";

import { escapeHtml } from "./utils";

export type FrontMatterMode = "hide" | "panel" | "raw";

const OPEN = /^---\s*$/;
const CLOSE = /^(---|\.\.\.)\s*$/;

function line(state: StateBlock, n: number) {
  return state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
}

function frontMatter(
  state: StateBlock,
  start: number,
  end: number,
  silent: boolean,
): boolean {
  if (start !== 0 || state.tShift[0] !== 0 || !OPEN.test(line(state, 0)))
    return false;

  let next = start + 1;
  while (next < end && !CLOSE.test(line(state, next))) next++;
  if (next >= end) return false;
  if (silent) return true;

  const token = state.push("front_matter", "", 0);
  token.block = true;
  token.hidden = true;
  token.map = [start, next + 1];
  token.content =
    next > start + 1 ? state.getLines(start + 1, next, 0, false) : "";
  state.line = next + 1;
  return true;
}

export default function frontMatterPlugin(
  md: MarkdownIt,
  mode: Exclude<FrontMatterMode, "raw"> = "hide",
) {
  md.block.ruler.before("table", "front_matter", frontMatter);
  md.renderer.rules.front_matter = (tokens, idx, options) => {
    if (mode !== "panel") return "";
    const yaml = tokens[idx].content.replace(/\n$/, "");
    const code =
      options.highlight?.(yaml, "yaml", "") ||
      `<pre><code>${escapeHtml(yaml)}</code></pre>`;
    return (
      `<details class="front-matter source-line" data-source-line="0">\n` +
      `<summary>Front matter</summary>\n${code}</details>\n`
    );
  };
}

export function frontMatterMode(options: {
  front_matter?: string;
  hide_yaml_meta?: number;
}): FrontMatterMode {
  switch (options.front_matter) {
    case "hide":
    case "panel":
    case "raw":
      return options.front_matter;
  }
  return (options.hide_yaml_meta ?? 1) === 1 ? "hide" : "raw";
}
