// The flow a user goes through: open a preview, edit, move around, stop it.
// Every assertion looks for content that only exists if the feature worked,
// usually a random token typed into the buffer, never just "no error".
import { expect, test, token } from "../lib/test";

test("renders the buffer in the page the server opens", async ({ editor, page }) => {
  const title = token();
  const body = token();
  await editor.open("note.md", `# ${title}\n\nsome *${body}* text\n`);
  await editor.command("MarkdownPreview");

  const url = await editor.previewUrl();
  expect(url).toMatch(/^http:\/\/localhost:\d+\/page\/\d+$/);
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
