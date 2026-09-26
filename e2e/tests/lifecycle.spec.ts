// The server process over the life of an editor session.
import { readFileSync } from "node:fs";

import type { Editor } from "../lib/editor";
import { expect, preview, test, token, waitFor } from "../lib/test";

/** pid of the server, from its log. */
function serverPid(editor: Editor): Promise<number> {
  return waitFor("the server to log its pid", () => {
    const match = /\(pid:(\d+)\)/.exec(readFileSync(editor.logFile, "utf8"));
    return match ? Number(match[1]) : undefined;
  });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("quitting the editor stops the server", async ({ launch, page }) => {
  const editor = await launch();
  const url = await preview(editor, page, "note.md", "# Quit\n");
  await expect(page.locator(".markdown-body h1")).toContainText("Quit");
  const pid = await serverPid(editor);
  expect(alive(pid)).toBe(true);

  await editor.stop({ keepDir: true });
  await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
  await expect(page.locator("#page-header .status")).not.toHaveCount(0);
  expect(await fetch(url).then(() => "answered", () => "refused")).toBe("refused");
});

test("a crashed server shows as disconnected in the page", async ({ editor, page }) => {
  await preview(editor, page, "note.md", "# Crash\n");
  await expect(page.locator(".markdown-body h1")).toContainText("Crash");
  process.kill(await serverPid(editor), "SIGKILL");
  await expect(page.locator("#page-header .status")).toHaveText("Disconnected");
  // the last render stays readable
  await expect(page.locator(".markdown-body h1")).toContainText("Crash");
});

test("a new preview after a crash works", async ({ editor, page }) => {
  await preview(editor, page, "note.md", "# Before\n");
  await expect(page.locator(".markdown-body h1")).toContainText("Before");
  const first = await serverPid(editor);
  process.kill(first, "SIGKILL");
  await expect.poll(() => editor.eval<number>("mkdp#rpc#get_server_status()")).toBe(-1);

  const typed = token();
  await editor.keys(`Go${typed}<Esc>`);
  await editor.command("MarkdownPreview");
  const reopened = await page.context().newPage();
  await reopened.goto(await editor.previewUrl(2));
  await expect(reopened.locator(".markdown-body")).toContainText(typed);
});

test("each buffer has its own page", async ({ editor, page, context }) => {
  const a = token();
  const b = token();
  await preview(editor, page, "a.md", `# ${a}\n`);
  // a.md stays loaded and previewed while b.md is previewed in a split
  editor.write("b.md", `# ${b}\n`);
  await editor.command("split b.md");
  await editor.command("MarkdownPreview");
  const other = await context.newPage();
  await other.goto(await editor.previewUrl(2));
  await expect(page.locator(".markdown-body h1")).toContainText(a);
  await expect(other.locator(".markdown-body h1")).toContainText(b);

  // typing in b only changes b's page
  const typed = token();
  await editor.keys(`Go${typed}<Esc>`);
  await expect(other.locator(".markdown-body")).toContainText(typed);
  await expect(page.locator(".markdown-body")).not.toContainText(typed);
  await expect(page.locator(".markdown-body h1")).toContainText(a);

  // and back in a, a's page follows
  const inA = token();
  await editor.command("wincmd j");
  await editor.keys(`Go${inA}<Esc>`);
  await expect(page.locator(".markdown-body")).toContainText(inA);
  await expect(other.locator(".markdown-body")).not.toContainText(inA);
});

test("one server serves every preview of the editor", async ({ editor, page }) => {
  await preview(editor, page, "a.md", "# A\n");
  const pid = await serverPid(editor);
  editor.write("b.md", "# B\n");
  await editor.command("split b.md");
  await editor.command("MarkdownPreview");
  const urls = await waitFor("a second URL", async () => ((await editor.urls()).length === 2 ? editor.urls() : undefined));
  expect(new URL(urls[0]).port).toBe(new URL(urls[1]).port);
  const pids = new Set([...readFileSync(editor.logFile, "utf8").matchAll(/\(pid:(\d+)\)/g)].map((m) => Number(m[1])));
  expect([...pids]).toEqual([pid]);
});

test("reloading the page shows the current buffer", async ({ editor, page }) => {
  await preview(editor, page, "note.md", "# Reload\n");
  const typed = token();
  await editor.keys(`Go${typed}<Esc>`);
  await expect(page.locator(".markdown-body")).toContainText(typed);
  await page.reload();
  await expect(page.locator(".markdown-body")).toContainText(typed);
});

test("pages for unknown buffers stay empty", async ({ editor, page }) => {
  const url = await preview(editor, page, "note.md", "# Known\n");
  const other = await page.context().newPage();
  await other.goto(url.replace(/\/page\/\d+$/, "/page/999"));
  await expect(other.locator(".markdown-body")).toBeAttached();
  await other.waitForTimeout(1_000);
  await expect(other.locator(".markdown-body")).toBeEmpty();
});

test("the old /<bufnr> URL redirects to the page", async ({ editor, page }) => {
  const url = await preview(editor, page, "note.md", "# Old\n");
  const old = url.replace("/page/", "/");
  await page.goto(old);
  await expect(page).toHaveURL(url);
  await expect(page.locator(".markdown-body h1")).toContainText("Old");
});

test.describe(":checkhealth", () => {
  test("reports the server binary", async ({ editor, editorKind }) => {
    test.skip(editorKind === "vim", ":checkhealth is Neovim only");
    const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(`${__dirname}/../../Cargo.toml`, "utf8"))![1];
    await editor.command("checkhealth mkdp");
    const report = await editor.eval<string>("join(getline(1, '$'), \"\\n\")");
    expect(report).toContain(`Plugin version: ${version}`);
    expect(report).toContain(`Server version: ${version}`);
    expect(report).toMatch(/OK.*Server binary found/);
    expect(report).not.toMatch(/ERROR/);
  });
});
