// PlantUML diagrams, rendered as images by a PlantUML server. Supports both
// ```plantuml fences (see fence.ts) and bare @startuml ... @enduml blocks.
import type { MarkdownIt, StateBlock } from "markdown-it";
import { encode } from "plantuml-encoder";

export interface UmlOptions {
  server?: string;
  imageFormat?: string;
  openMarker?: string;
  closeMarker?: string;
}

export function plantumlUrl(code: string, options: UmlOptions): string {
  const server = options.server || "https://www.plantuml.com/plantuml";
  return `${server}/${options.imageFormat || "img"}/${encode(code)}`;
}

export default function plantumlPlugin(md: MarkdownIt, options: UmlOptions = {}) {
  const openMarker = options.openMarker || "@startuml";
  const closeMarker = options.closeMarker || "@enduml";

  function uml(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (!state.src.startsWith(openMarker, start)) return false;
    if (silent) return true;

    let nextLine = startLine;
    let closed = false;
    while (++nextLine < endLine) {
      const pos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      // a non-empty line with negative indent ends the enclosing list
      if (pos < lineMax && state.sCount[nextLine] < state.blkIndent) break;
      if (
        state.sCount[nextLine] <= state.sCount[startLine] &&
        state.src.startsWith(closeMarker, pos) &&
        state.skipSpaces(pos + closeMarker.length) >= lineMax
      ) {
        closed = true;
        break;
      }
    }

    const contents = state.src.split("\n").slice(startLine + 1, nextLine).join("\n");
    const params = state.src.slice(start + openMarker.length, max);
    const token = state.push("uml_diagram", "img", 0);
    token.attrs = [
      ["src", plantumlUrl(contents, options)],
      ["alt", params.trim() || "uml diagram"],
    ];
    token.block = true;
    token.map = [startLine, nextLine];
    token.markup = openMarker;
    state.line = nextLine + (closed ? 1 : 0);
    return true;
  }

  md.block.ruler.before("fence", "uml_diagram", uml, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.uml_diagram = (tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts);
}
