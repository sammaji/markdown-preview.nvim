// The preview page itself: every feature of examples/features.md drawn in a real
// browser, diagrams included, plus the page's own controls.
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { REPO } from "../lib/editor";
import { expect, preview, test, token } from "../lib/test";

// diagram libraries are loaded on demand and draw after the text
const DRAWN = { timeout: 20_000 };

const body = (page: Page) => page.locator(".markdown-body");

test.describe("examples/features.md", () => {
  test.beforeEach(async ({ editor, page }) => {
    cpSync(join(REPO, "examples/images"), join(editor.dir, "images"), { recursive: true });
    await preview(editor, page, "features.md", readFileSync(join(REPO, "examples/features.md"), "utf8"));
    await expect(body(page).locator("h1")).toContainText("Feature tour");
  });

  test("text, lists, tables, code, emoji and footnotes", async ({ page }) => {
    const md = body(page);
    // front matter
    await expect(md).not.toContainText("This front matter is hidden");
    await expect(md.locator("strong").first()).toHaveText("bold");
    await expect(md.locator("s, del").first()).toHaveText("strikethrough");
    await expect(md.locator("kbd")).toHaveText(["Ctrl", "C"]);
    await expect(md.locator('a[href="https://neovim.io"]')).toHaveText("https://neovim.io");
    // typographer
    await expect(md).toContainText("“smart quotes”");
    await expect(md).toContainText("—");
    await expect(md.locator("blockquote blockquote")).toContainText("can be nested");

    await expect(md.locator("ol:not(.footnotes-list) > li")).toHaveCount(2);
    await expect(md.locator("ol li ul li")).toHaveText(["nested", "items"]);
    const tasks = md.locator("li.task-list-item input[type=checkbox]");
    await expect(tasks).toHaveCount(3);
    await expect(md.locator("li.task-list-item input[type=checkbox]:checked")).toHaveCount(2);
    await expect(md.locator("dl dt")).toHaveText(["Preview", "Sync scroll"]);

    await expect(md.locator("table tbody tr")).toHaveCount(4);
    await expect(md.locator("table th").nth(1)).toHaveCSS("text-align", "center");
    await expect(md.locator("table th").nth(2)).toHaveCSS("text-align", "right");

    // highlight.js: keywords of each language are marked
    await expect(md.locator("pre.hljs")).toHaveCount(3);
    await expect(md.locator("pre.hljs .hljs-keyword", { hasText: "fn" })).toHaveCount(1);
    await expect(md.locator("pre.hljs .hljs-keyword", { hasText: "let" })).toHaveCount(1);
    await expect(md.locator("pre.hljs .hljs-deletion")).toHaveCount(1);

    await expect(md).toContainText("🚀");
    await expect(md).not.toContainText(":rocket:");
    await expect(md.locator(".footnotes li")).toHaveCount(1);
    await expect(md.locator("sup.footnote-ref")).toHaveCount(2);
    await expect(md.locator("details summary")).toContainText("Raw HTML is allowed");

    // GitHub alerts, in order, each with its title
    const alerts = md.locator(".markdown-alert");
    await expect(alerts).toHaveCount(5);
    for (const [i, kind] of ["note", "tip", "important", "warning", "caution"].entries()) {
      await expect(alerts.nth(i)).toHaveClass(new RegExp(`markdown-alert-${kind}`));
    }
    await expect(alerts.first().locator(".markdown-alert-title")).toHaveText("Note");
    await expect(md).not.toContainText("[!NOTE]");
    await expect(md.locator("details strong")).toHaveText("HTML blocks");
  });

  test("table of contents and heading anchors", async ({ page }) => {
    const links = body(page).locator('.table-of-contents a[href^="#"], nav a[href^="#"]');
    expect(await links.count()).toBeGreaterThanOrEqual(10);
    // every entry points at a heading that exists
    const missing = await links.evaluateAll((as) =>
      as
        .map((a) => decodeURIComponent(a.getAttribute("href")!.slice(1)))
        .filter((id) => !document.getElementById(id)?.matches("h1, h2, h3, h4, h5, h6")),
    );
    expect(missing).toEqual([]);
    await expect(body(page).locator("h2#mermaid a.anchor svg.octicon-link")).toHaveCount(1);

    await body(page).locator('.table-of-contents a[href="#graphviz"], nav a[href="#graphviz"]').click();
    await expect(body(page).locator("h2#graphviz")).toBeInViewport();
  });

  test("math", async ({ page }) => {
    const md = body(page);
    await expect(md.locator(".katex-display")).toHaveCount(2);
    // inline: two in "Inline math", two mhchem
    await expect(md.locator(".katex:not(.katex-display .katex)")).toHaveCount(4);
    await expect(md.locator(".katex-error")).toHaveCount(0);
    await expect(md.locator(".katex-display .katex-html").first()).toContainText("π");
    // mhchem drew the reaction arrow; the TeX source is only in the MathML annotation
    const reaction = md.locator(".katex-html", { hasText: "CO" }).first();
    await expect(reaction.locator("svg")).not.toHaveCount(0);
    await expect(md.locator(".katex-html", { hasText: "\\ce" })).toHaveCount(0);
  });

  test("local images", async ({ page }) => {
    const images = body(page).locator('img[src*="markdown.svg"]');
    await expect(images).toHaveCount(3);
    for (const img of await images.all()) {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }
    await expect(images.nth(1)).toHaveAttribute("width", "104");
    expect((await images.nth(1).boundingBox())?.width).toBeCloseTo(104, 0);
    expect((await images.nth(2).boundingBox())?.width).toBeCloseTo(52, 0);
  });

  test("diagrams", async ({ page }) => {
    const md = body(page);
    // flowchart, sequence, gantt, and the fence without a language
    await expect(md.locator(".mermaid > svg")).toHaveCount(5, DRAWN);
    await expect(md.locator(".mermaid > svg").first()).toContainText("Rust server");
    await expect(md.locator(".mermaid > svg").nth(2)).toContainText("Release plan");
    await expect(md.locator(".mermaid > svg").nth(3)).toContainText("ELK layout");
    await expect(md.locator(".mermaid > svg").nth(4)).toContainText("Write markdown");
    // every drawn diagram can open in the viewer
    await expect(md.locator(".mermaid .diagram-open")).toHaveCount(5);
    await expect(md.locator("div.flowchart svg")).toContainText("Run MarkdownPreview", DRAWN);
    await expect(md.locator("div.sequence-diagrams svg")).toContainText("open_browser", DRAWN);
    await expect(md.locator("div.dot svg")).toContainText("markdown-it", DRAWN);

    // the chart drew something: some pixel of the canvas is not transparent
    const canvas = md.locator(".chartjs canvas");
    await expect
      .poll(
        () =>
          canvas.evaluate((el: HTMLCanvasElement) =>
            el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data.some((v, i) => i % 4 === 3 && v > 0),
          ),
        DRAWN,
      )
      .toBe(true);

    // plantuml is drawn by a remote server; check the request, not the picture
    const uml = md.locator('img[src^="https://www.plantuml.com/plantuml/"]');
    await expect(uml).toHaveCount(2);

    await expect(md.locator(".diagram-error")).toHaveCount(0);
  });

  test("no errors in the page", async ({ page, consoleLog }) => {
    await expect(body(page).locator(".mermaid > svg")).toHaveCount(5, DRAWN);
    await expect(body(page).locator("div.dot svg")).toHaveCount(1, DRAWN);
    const errors = consoleLog.filter(
      // plantuml images need the network, which tests do not rely on
      (line) => /^\[(error|pageerror)\]/.test(line) && !line.includes("plantuml.com"),
    );
    expect(errors).toEqual([]);
  });
});

test("broken diagrams show an error in their place", async ({ editor, page }) => {
  const after = token();
  await preview(
    editor,
    page,
    "broken.md",
    [
      "# Broken",
      "```mermaid\ngraph TD\n  A --> \n```",
      '```chart\n{"type": "bar", "data": \n```',
      "```dot\ndigraph { a -> }\n```",
      after,
    ].join("\n\n"),
  );
  const errors = body(page).locator(".diagram-error");
  await expect(errors).toHaveCount(3, DRAWN);
  await expect(errors.nth(0)).toContainText("Mermaid");
  await expect(errors.nth(1)).toContainText("JSON");
  await expect(errors.nth(2)).toContainText("Graphviz");
  // the rest of the page still renders
  await expect(body(page).locator("p").last()).toHaveText(after);
});

test.describe("theme", () => {
  test.describe("g:mkdp_theme = 'dark'", () => {
    test.use({ mkdpVars: { mkdp_theme: "dark" } });

    test("is used, and the toggle switches it", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Theme\n\n```mermaid\ngraph TD\n  A --> B\n```\n");
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-theme", "dark");
      // shadcn themes style .dark
      await expect(html).toHaveClass(/\bdark\b/);
      const mermaid = body(page).locator(".mermaid > svg");
      await expect(mermaid).toHaveCount(1, DRAWN);
      const darkSvg = await mermaid.innerHTML();

      // the toggle is shown without hovering the header
      const toggle = page.getByRole("button", { name: "Switch to light theme" });
      await page.mouse.move(5, 500);
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveCSS("opacity", "1");

      await toggle.click();
      await expect(html).toHaveAttribute("data-theme", "light");
      await expect(html).not.toHaveClass(/\bdark\b/);
      // diagrams are redrawn with the other theme's colors
      await expect.poll(async () => (await mermaid.count()) === 1 && (await mermaid.innerHTML()) !== darkSvg, DRAWN).toBe(true);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      // the choice survives updates from the editor
      const typed = token();
      await editor.keys(`Go${typed}<Esc>`);
      await expect(body(page)).toContainText(typed);
      await expect(html).toHaveAttribute("data-theme", "light");
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
    });
  });

  test.describe("g:mkdp_theme = 'light'", () => {
    test.use({ mkdpVars: { mkdp_theme: "light" }, colorScheme: "dark" });

    test("wins over a dark system theme", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Theme\n");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  });

  for (const colorScheme of ["dark", "light"] as const) {
    test.describe(`no g:mkdp_theme, ${colorScheme} system theme`, () => {
      test.use({ colorScheme });

      test("follows the system", async ({ editor, page }) => {
        await preview(editor, page, "note.md", "# Theme\n");
        await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      });
    });
  }

  test("dark and light look different", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Theme\n");
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const before = await background();
    await page.locator(".theme-toggle").click();
    await expect.poll(background).not.toBe(before);
  });
});

test("names with spaces and non-ASCII characters", async ({ editor, page }) => {
  editor.write(
    "my images/图 1.svg",
    '<svg xmlns="http://www.w3.org/2000/svg" width="41" height="19"><rect width="41" height="19"/></svg>',
  );
  const text = token();
  await preview(editor, page, "笔记 notes.md", `# 你好 ${text}\n\n![pic](<my images/图 1.svg>)\n`);
  await expect(body(page).locator("h1")).toContainText(`你好 ${text}`);
  await expect(page).toHaveTitle("「笔记 notes」");
  const img = body(page).locator("img[alt=pic]");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(41);
});

test("a large document renders and follows the cursor", async ({ editor, page }) => {
  const sections = Array.from(
    { length: 400 },
    (_, i) => `## Section ${i}\n\nSome **text** with \`code\` and $x^${i}$.\n\n- a\n- b\n\n\`\`\`js\nconst x = ${i};\n\`\`\``,
  );
  const last = token();
  const started = Date.now();
  await preview(editor, page, "big.md", `# Big\n\n${sections.join("\n\n")}\n\n${last}\n`);
  await expect(body(page)).toContainText(last);
  expect(Date.now() - started).toBeLessThan(15_000);

  await editor.keys("G");
  await expect(page.getByText(last)).toBeInViewport();
  const edited = token();
  await editor.keys(`O${edited}<Esc>`);
  await expect(body(page)).toContainText(edited);
});
