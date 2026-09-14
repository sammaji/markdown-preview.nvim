// Tags block elements with the source line they start on, which the sync
// scroll uses to find the element under the editor cursor.
// Based on https://github.com/digitalmoksha/markdown-it-inject-linenumbers
import type { MarkdownIt, RendererRule } from "markdown-it";

const injectLineNumber: RendererRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.map) {
    token.attrJoin("class", "source-line");
    token.attrSet("data-source-line", String(token.map[0]));
  }
  return self.renderToken(tokens, idx, options);
};

export default function lineNumbersPlugin(md: MarkdownIt) {
  for (const rule of ["paragraph_open", "heading_open", "list_item_open", "table_open"]) {
    md.renderer.rules[rule] = injectLineNumber;
  }
}
