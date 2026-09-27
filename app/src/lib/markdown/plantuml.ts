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

/** Page colors for PlantUML diagrams, as hex. */
export interface UmlColors {
  text: string;
  line: string;
  node: string;
  muted: string;
}

/** md.render env: the page's colors, which PlantUML diagrams are drawn with. */
export interface UmlEnv {
  umlColors?: UmlColors;
}

/**
 * PlantUML draws on the server, so CSS can't restyle it: the page's colors go
 * in the diagram's source instead, on a transparent background.
 */
export function plantumlStyle(c: UmlColors): string {
  return `skinparam backgroundColor transparent
<style>
root {
  FontColor ${c.text}
  LineColor ${c.line}
  BackGroundColor ${c.node}
}
document { BackGroundColor transparent }
arrow { LineColor ${c.line}; FontColor ${c.text} }
note { BackGroundColor ${c.muted}; LineColor ${c.line} }
group { BackGroundColor transparent }
groupHeader { BackGroundColor ${c.muted} }
</style>`;
}

// the style goes before the diagram's own skinparams and styles, which win
function withColors(code: string, colors: UmlColors | undefined): string {
  if (!colors) return code;
  const start = code.match(/^\s*@start\w*[^\n]*\n/)?.[0] ?? "";
  return `${start}${plantumlStyle(colors)}\n${code.slice(start.length)}`;
}

export function plantumlUrl(
  code: string,
  options: UmlOptions,
  colors?: UmlColors,
): string {
  const server = options.server || "https://www.plantuml.com/plantuml";
  return `${server}/${options.imageFormat || "img"}/${encode(withColors(code, colors))}`;
}

export default function plantumlPlugin(
  md: MarkdownIt,
  options: UmlOptions = {},
) {
  const openMarker = options.openMarker || "@startuml";
  const closeMarker = options.closeMarker || "@enduml";

  function uml(
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ): boolean {
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

    const contents = state.src
      .split("\n")
      .slice(startLine + 1, nextLine)
      .join("\n");
    const params = state.src.slice(start + openMarker.length, max);
    const token = state.push("uml_diagram", "img", 0);
    token.attrs = [
      [
        "src",
        plantumlUrl(
          contents,
          options,
          (state.env as UmlEnv | undefined)?.umlColors,
        ),
      ],
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
  md.renderer.rules.uml_diagram = (tokens, idx, opts, env, self) =>
    self.renderToken(tokens, idx, opts);
}
