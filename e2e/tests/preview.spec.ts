// The flow a user goes through: open a preview, edit, move around, stop it.
// Every assertion looks for content that only exists if the feature worked,
// usually a random token typed into the buffer, never just "no error".
import { expect, preview, test, token } from "../lib/test";

test("renders the buffer in the page the server opens", async ({ editor, page }) => {
  const title = token();
  const body = token();
  await editor.open("note.md", `# ${title}\n\nsome *${body}* text\n`);
  await editor.command("MarkdownPreview");

  const url = await editor.previewUrl();
  // named after the file, relative to the editor's working directory
  expect(url).toMatch(/^http:\/\/localhost:\d+\/files\/note\.md$/);
  await page.goto(url);

  await expect(page.locator(".markdown-body h1")).toContainText(title);
  await expect(page.locator(".markdown-body em")).toHaveText(body);
  // g:mkdp_page_title defaults to 「${name}」
  await expect(page).toHaveTitle("「note」");
  await expect(page.locator("#page-header h3")).toHaveText("note");
});

test("shows edits while typing, without saving", async ({ editor, page }) => {
  await editor.open("note.md", "# Title\n");
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl());
  await expect(page.locator(".markdown-body h1")).toContainText("Title");

  const first = token();
  await editor.keys(`Go<CR>## ${first}`);
  await expect(page.locator(".markdown-body h2")).toContainText(first);

  const second = token();
  await editor.keys(`<Esc>o<CR>- ${second}<Esc>`);
  await expect(page.locator(".markdown-body li")).toHaveText(second);
  // nothing was written to disk
  expect(await editor.eval<number>("&modified")).toBe(1);
});

test("scrolls the page to follow the cursor", async ({ editor, page }) => {
  const last = token();
  const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}.`);
  await editor.open("long.md", `# Top\n\n${paragraphs.join("\n\n")}\n\n${last}\n`);
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl());
  await expect(page.locator(".markdown-body")).toContainText(last);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await editor.keys("G");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1_000);
  await expect(page.getByText(last)).toBeInViewport();

  await editor.keys("gg");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("shows images next to the markdown file", async ({ editor, page }) => {
  // an unusual size, so a broken image or the wrong file cannot match it
  editor.write(
    "images/pic.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="37" height="23"><rect width="37" height="23" fill="red"/></svg>',
  );
  await editor.open("note.md", "# Images\n\n![pic](images/pic.svg)\n");
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl());

  const img = page.locator(".markdown-body img[alt=pic]");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(37);
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(23);
});

test(":MarkdownPreviewStop stops the server and tells the page", async ({ editor, page }) => {
  await editor.open("note.md", "# Title\n");
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl());
  await expect(page.locator(".markdown-body h1")).toContainText("Title");
  expect(await editor.eval<number>("mkdp#rpc#get_server_status()")).toBe(1);

  await editor.command("MarkdownPreviewStop");
  await expect(page.locator("#page-header .status")).toHaveText("Preview stopped");
  expect(await editor.eval<number>("mkdp#rpc#get_server_status()")).toBe(-1);

  // edits no longer reach the page
  const after = token();
  await editor.keys(`Go${after}<Esc>`);
  await page.waitForTimeout(1_000);
  await expect(page.locator(".markdown-body")).not.toContainText(after);
});

test(":MarkdownPreviewToggle opens, stops and reopens the preview", async ({ editor, page }) => {
  const title = token();
  await editor.open("note.md", `# ${title}\n`);

  await editor.command("MarkdownPreviewToggle");
  await page.goto(await editor.previewUrl(1));
  await expect(page.locator(".markdown-body h1")).toContainText(title);

  await editor.command("MarkdownPreviewToggle");
  await expect(page.locator("#page-header .status")).toHaveText("Preview stopped");
  expect(await editor.eval<number>("mkdp#rpc#get_server_status()")).toBe(-1);

  await editor.command("MarkdownPreviewToggle");
  const reopened = await page.context().newPage();
  await reopened.goto(await editor.previewUrl(2));
  await expect(reopened.locator(".markdown-body h1")).toContainText(title);
  await expect(reopened.locator("#page-header .status")).toHaveCount(0);
});

test.describe("file urls", () => {
  test("a file in a folder has its path in the url", async ({ editor, page }) => {
    const title = token();
    await preview(editor, page, "docs/my notes.md", `# ${title}\n`);
    await expect(page).toHaveURL(/\/files\/docs\/my%20notes\.md$/);
    await expect(page.locator(".markdown-body h1")).toContainText(title);
  });

  test("a file outside the working directory keeps /page/<bufnr>", async ({ editor, page }) => {
    const title = token();
    editor.write("outside/note.md", `# ${title}\n`);
    editor.write("work/.keep", "");
    await editor.command("cd work");
    await editor.command("edit ../outside/note.md");
    await editor.command("MarkdownPreview");
    const bufnr = await editor.eval<number>("bufnr('%')");
    const url = await editor.previewUrl();
    expect(url).toMatch(new RegExp(`/page/${bufnr}$`));
    await page.goto(url);
    await expect(page.locator(".markdown-body h1")).toContainText(title);
  });

  test("a link to another markdown file opens it from disk (#58)", async ({ editor, page }) => {
    const title = token();
    editor.write("docs/other.md", `# ${title}\n\n![logo](img/logo.svg)\n`);
    editor.write(
      "docs/img/logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await preview(editor, page, "note.md", "# Note\n\n[other](docs/other.md)\n");
    await page.locator(".markdown-body a", { hasText: "other" }).click();

    await expect(page).toHaveURL(/\/files\/docs\/other\.md$/);
    await expect(page.locator(".markdown-body h1")).toContainText(title);
    await expect(page.locator("#page-header h3")).toHaveText("other");
    // images are relative to the linked file
    await expect(page.locator(".markdown-body img")).toHaveJSProperty("naturalWidth", 10);
    // the file was not opened in the editor
    expect(await editor.eval<number>("bufnr('docs/other.md')")).toBe(-1);
  });

  test("a linked file open in the editor shows its buffer", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Note\n\n[other](other.md)\n");
    editor.write("other.md", "# On disk\n");
    await editor.command("split other.md");
    const typed = token();
    await editor.keys(`Go${typed}<Esc>`);
    await editor.command("wincmd p");

    await page.locator(".markdown-body a", { hasText: "other" }).click();
    await expect(page).toHaveURL(/\/files\/other\.md$/);
    // unsaved edits come from the buffer, not the file
    await expect(page.locator(".markdown-body")).toContainText(typed);
  });

  test("urls cannot reach files outside the working directory", async ({ editor, page }) => {
    // the working directory is work/, secret.md is next to it
    const secret = editor.write("secret.md", "# secret\n");
    editor.write("work/note.md", "# Note\n");
    await editor.command("cd work");
    await editor.command("edit note.md");
    await editor.command("MarkdownPreview");
    const url = await editor.previewUrl();
    await page.goto(url);
    await expect(page.locator(".markdown-body h1")).toContainText("Note");

    const origin = new URL(url).origin;
    for (const path of ["/files/..%2Fsecret.md", "/files/..%5Csecret.md", `/files/${encodeURIComponent(secret)}`]) {
      const res = await page.request.get(origin + path);
      expect(res.status(), path).toBe(404);
    }
  });
});
