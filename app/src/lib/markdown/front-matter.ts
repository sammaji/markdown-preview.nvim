// Hides a YAML front matter block (`---` ... `---` or `...`) at the top of
// the document.
import type { MarkdownIt, StateBlock } from "markdown-it";

const OPEN = /^---\s*$/;
const CLOSE = /^(---|\.\.\.)\s*$/;

function line(state: StateBlock, n: number) {
  return state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
}

function frontMatter(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  if (start !== 0 || state.tShift[0] !== 0 || !OPEN.test(line(state, 0))) return false;

  let next = start + 1;
  while (next < end && !CLOSE.test(line(state, next))) next++;
  if (next >= end) return false;
  if (silent) return true;

  state.line = next + 1;
  return true;
}

export default function frontMatterPlugin(md: MarkdownIt) {
  md.block.ruler.before("table", "front_matter", frontMatter);
}
