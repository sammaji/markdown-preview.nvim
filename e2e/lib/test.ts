import { randomBytes } from "node:crypto";

import { test as base, type Page } from "@playwright/test";

import { Editor, type EditorKind, type StartOptions } from "./editor";

export { expect } from "@playwright/test";
export { waitFor } from "./editor";

/** A word that cannot be in the page unless it came from this test's buffer. */
export function token() {
  return `tok${randomBytes(6).toString("hex")}`;
}

export const test = base.extend<{
  /** which editor runs the plugin, set per project in playwright.config.ts */
  editorKind: EditorKind;
  /** `g:` variables for `editor`, set before the plugin loads */
  mkdpVars: Record<string, unknown>;
  /** starts more editors, stopped at the end of the test */
  launch: (options?: StartOptions) => Promise<Editor>;
  editor: Editor;
  /** browser console output and page errors, attached to failing tests */
  consoleLog: string[];
}>({
  editorKind: ["nvim", { option: true }],
  mkdpVars: [{}, { option: true }],
  consoleLog: async ({ context }, use) => {
    const log: string[] = [];
    const watch = (page: Page) => {
      page.on("console", (msg) => log.push(`[${msg.type()}] ${page.url()}: ${msg.text()}`));
      page.on("pageerror", (error) => log.push(`[pageerror] ${page.url()}: ${error.stack ?? error.message}`));
    };
    context.pages().forEach(watch);
    context.on("page", watch);
    await use(log);
  },
  launch: async ({ editorKind, consoleLog }, use, testInfo) => {
    const editors: Editor[] = [];
    try {
      await use(async (options) => {
        const editor = await Editor.start(editorKind, options);
        editors.push(editor);
        return editor;
      });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      for (const [i, editor] of editors.entries()) {
        if (failed) {
          await testInfo.attach(`editor ${i + 1}`, { body: await editor.diagnostics(), contentType: "text/plain" });
        }
        await editor.stop();
      }
      if (failed) {
        await testInfo.attach("page console", { body: consoleLog.join("\n"), contentType: "text/plain" });
      }
    }
  },
  editor: async ({ launch, mkdpVars }, use) => {
    await use(await launch({ vars: mkdpVars }));
  },
});

/** Opens `path` with `content`, starts the preview and loads it in `page`. */
export async function preview(editor: Editor, page: Page, path: string, content: string) {
  await editor.open(path, content);
  await editor.command("MarkdownPreview");
  const url = await editor.previewUrl();
  await page.goto(url);
  return url;
}
