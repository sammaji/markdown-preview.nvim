// Page features beyond examples/features.md: GitHub alerts, the front matter
// panel, and the mermaid viewer, fallback and ELK layout.
import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, preview, test, token } from "../lib/test";

// diagram libraries are loaded on demand and draw after the text
const DRAWN = { timeout: 20_000 };

const body = (page: Page) => page.locator(".markdown-body");

test("GitHub alerts", async ({ editor, page }) => {
  const [note, caution] = [token(), token()];
  await preview(editor, page, "alerts.md", `# Alerts\n\n> [!NOTE]\n> ${note}\n\n> [!CAUTION]\n> ${caution}\n`);
  const noteBox = body(page).locator(".markdown-alert.markdown-alert-note");
  await expect(noteBox).toContainText(note);
  await expect(noteBox.locator(".markdown-alert-title")).toHaveText("Note");
  await expect(noteBox.locator(".markdown-alert-title svg")).toBeVisible();
  await expect(body(page).locator(".markdown-alert-caution")).toContainText(caution);
  await expect(body(page)).not.toContainText("[!NOTE]");
  // styled: a coloured left border, not the plain blockquote
  await expect(noteBox).toHaveCSS("border-left-color", "rgb(9, 105, 218)");
  await expect(body(page).locator(".markdown-alert-caution")).toHaveCSS("border-left-color", "rgb(209, 36, 47)");
});

test.describe("front matter panel", () => {
  test.use({ mkdpVars: { mkdp_preview_options: { front_matter: "panel" } } });

  test("is collapsed and opens on click, and stays open while typing", async ({ editor, page }) => {
    const [meta, after] = [token(), token()];
    await preview(editor, page, "meta.md", `---\ntitle: ${meta}\n---\n\n# Body\n`);
    const panel = body(page).locator("details.front-matter");
    await expect(panel).toHaveCount(1);
    await expect(panel.locator("code")).toContainText(`title: ${meta}`);
    await expect(panel.locator("code")).toBeHidden();
    await panel.locator("summary").click();
    await expect(panel.locator("code")).toBeVisible();

    await editor.keys(`Go${after}<Esc>`);
    await expect(body(page)).toContainText(after);
    await expect(panel.locator("code")).toBeVisible();
  });
});

test.describe("mermaid", () => {
  test("a broken edit keeps the last drawing", async ({ editor, page }) => {
    const [good, broken] = [token(), token()];
    await preview(editor, page, "maid.md", `# Maid\n\n\`\`\`mermaid\ngraph TD\n  A[${good}] --> B\n\`\`\`\n`);
    const diagram = body(page).locator(".mermaid");
    await expect(diagram.locator("svg").first()).toContainText(good, DRAWN);

    // turn the diagram into a syntax error
    await editor.keys(`4Gccgraph TD ${broken} --><Esc>`);
    await expect(diagram.locator(".diagram-error")).toContainText("last diagram that rendered", DRAWN);
    await expect(diagram.locator("svg").first()).toContainText(good);
    await expect(diagram).toHaveClass(/diagram-stale/);
  });

  test("the viewer zooms, pans, downloads and closes", async ({ editor, page }) => {
    const label = token();
    await preview(editor, page, "maid.md", `# Maid\n\n\`\`\`mermaid\ngraph LR\n  A[${label}] --> B\n\`\`\`\n`);
    const diagram = body(page).locator(".mermaid");
    await expect(diagram.locator("svg").first()).toContainText(label, DRAWN);

    await diagram.hover();
    await diagram.locator("button.diagram-open").click();
    const viewer = page.locator(".diagram-viewer");
    await expect(viewer).toBeVisible();
    const copy = viewer.locator(".diagram-viewer-stage > svg");
    await expect(copy).toContainText(label);

    const scale = async () => Number(await viewer.getAttribute("data-scale"));
    const fitted = await scale();
    await page.keyboard.press("+");
    await expect.poll(scale).toBeCloseTo(fitted * 1.25);
    await viewer.locator('button[data-action="zoomOut"]').click();
    await expect.poll(scale).toBeCloseTo(fitted);
    const stage = viewer.locator(".diagram-viewer-stage");
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await expect.poll(scale).toBeGreaterThan(fitted * 2);

    const before = await copy.evaluate((svg) => svg.getBoundingClientRect().left);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    const after = await copy.evaluate((svg) => svg.getBoundingClientRect().left);
    expect(after - before).toBeCloseTo(80, 0);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      viewer.locator('button[data-action="download"]').click(),
    ]);
    expect(download.suggestedFilename()).toBe("diagram.svg");
    const file = readFileSync((await download.path())!, "utf8");
    expect(file).toMatch(/^<\?xml[^>]*>\n<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(file).toContain(label);

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });

  test("the ELK layout draws", async ({ editor, page }) => {
    // mermaid bundles ELK and loads it only for diagrams laid out with it
    const elk: string[] = [];
    page.on("response", async (response) => {
      if (!response.url().endsWith(".js")) return;
      if ((await response.text().catch(() => "")).includes("org.eclipse.elk.alg")) elk.push(response.url());
    });
    const label = token();
    const src = `---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A[${label}] --> B & C --> D`;
    await preview(editor, page, "elk.md", `# Elk\n\n\`\`\`mermaid\n${src}\n\`\`\`\n`);
    const diagram = body(page).locator(".mermaid");
    await expect(diagram.locator("svg").first()).toContainText(label, DRAWN);
    await expect(diagram.locator(".diagram-error")).toHaveCount(0);
    await expect.poll(() => elk.length).toBeGreaterThan(0);
  });
});
