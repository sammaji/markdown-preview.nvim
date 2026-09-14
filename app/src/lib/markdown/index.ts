import hljs from "highlight.js";
import markdownIt, { type MarkdownIt, type MarkdownItOptions } from "markdown-it";
import anchor from "markdown-it-anchor";
import deflist from "markdown-it-deflist";
import { full as emoji } from "markdown-it-emoji";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import toc from "markdown-it-toc-done-right";

import type { PreviewOptions } from "../protocol";
import fence from "./fence";
import frontMatter from "./front-matter";
import images from "./images";
import katex from "./katex";
import lineNumbers from "./line-numbers";
import plantuml from "./plantuml";
import { escapeHtml } from "./utils";

const ANCHOR_SYMBOL =
  '<svg class="octicon octicon-link" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill-rule="evenodd" d="M4 9h1v1H4c-1.5 0-3-1.69-3-3.5S2.55 3 4 3h4c1.45 0 3 1.69 3 3.5 0 1.41-.91 2.72-2 3.25V8.59c.58-.45 1-1.27 1-2.09C10 5.22 8.98 4 8 4H4c-.98 0-2 1.22-2 2.5S3 9 4 9zm9-3h-1v1h1c1 0 2 1.22 2 2.5S13.98 12 13 12H9c-.98 0-2-1.22-2-2.5 0-.83.42-1.64 1-2.09V6.25c-1.09.53-2 1.84-2 3.25C6 11.31 7.55 13 9 13h4c1.45 0 3-1.69 3-3.5S14.5 6 13 6z"></path></svg>';

const DEFAULT_MKIT: MarkdownItOptions = {
  html: true,
  xhtmlOut: true,
  breaks: false,
  langPrefix: "language-",
  linkify: true,
  typographer: true,
  quotes: "“”‘’",
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
        return `<pre class="hljs"><code>${value}</code></pre>`;
      } catch {
        // fall through to plain text
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
};

/** Builds the markdown renderer configured by `g:mkdp_preview_options`. */
export function createRenderer(options: PreviewOptions): MarkdownIt {
  const md = markdownIt({ ...DEFAULT_MKIT, ...options.mkit });

  if ((options.hide_yaml_meta ?? 1) === 1) {
    md.use(frontMatter);
  }
  md.use(katex, { throwOnError: false, errorColor: " #cc0000", ...options.katex })
    .use(plantuml, options.uml)
    .use(emoji)
    .use(taskLists)
    .use(deflist)
    .use(footnote)
    .use(images)
    .use(lineNumbers)
    .use(fence, options.uml)
    .use(anchor, {
      permalink: anchor.permalink.linkInsideHeader({
        symbol: ANCHOR_SYMBOL,
        placement: "before",
        class: "anchor",
        ariaHidden: true,
      }),
    })
    .use(toc, { listType: "ul", ...options.toc });

  return md;
}
