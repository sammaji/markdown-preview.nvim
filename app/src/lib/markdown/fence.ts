// Code fences that become diagrams. The fence is rendered as a placeholder
// element holding the source; diagrams.ts draws them after the HTML is in
// the page.
import type { MarkdownIt } from "markdown-it";

import { plantumlUrl, type UmlOptions } from "./plantuml";
import { escapeHtml } from "./utils";

// mermaid code in fences without a language
const MERMAID_FIRST_LINE = /^(gantt|sequenceDiagram|erDiagram|graph (TB|BT|RL|LR|TD);?)$/;

function placeholder(className: string, code: string) {
  return `<div class="${className}">${escapeHtml(code)}</div>\n`;
}

export default function fencePlugin(md: MarkdownIt, umlOptions: UmlOptions = {}) {
  const fallback = md.renderer.rules.fence!;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim();
    const code = token.content.trim();

    switch (lang) {
      case "dot":
      case "graphviz":
        return placeholder("dot", code);
      case "flowchart":
        return placeholder("flowchart", code);
      case "sequence-diagrams":
        return placeholder("sequence-diagrams", code);
      case "mermaid":
        return placeholder("mermaid", code);
      case "chart":
        try {
          const config = JSON.stringify(JSON.parse(code));
          return `<div class="chartjs"><canvas data-config="${escapeHtml(config)}"></canvas></div>\n`;
        } catch (error) {
          return `<pre class="diagram-error">${escapeHtml(String(error))}</pre>\n`;
        }
    }
    if (MERMAID_FIRST_LINE.test(code.split("\n", 1)[0].trim())) {
      return placeholder("mermaid", code);
    }
    if (lang.includes("plantuml")) {
      return `<img src="${escapeHtml(plantumlUrl(code, umlOptions))}" alt="" />\n`;
    }
    return fallback(tokens, idx, options, env, self);
  };
}
