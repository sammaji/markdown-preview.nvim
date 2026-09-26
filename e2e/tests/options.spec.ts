// Every g:mkdp_* option in docs/content/docs/configuration.mdx, each checked by what it changes in the
// page or the editor.
import { chmodSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import type { Editor, StartOptions } from "../lib/editor";
import { REPO } from "../lib/editor";
import { expect, preview, test, token } from "../lib/test";

const body = (page: Page) => page.locator(".markdown-body");

// Ports for these tests come from a range per worker, below the ones the OS
// hands out, so parallel tests cannot pick the same port: macOS lets one test
// listen on 127.0.0.1 and another on :: with the same port.
const PORTS_PER_WORKER = 500;

async function listen(port: number, host?: string): Promise<Server | undefined> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(undefined));
    server.listen(port, host, () => resolve(server));
  });
}

/** Occupies a free port until the test ends; all interfaces unless `host` is given. */
async function occupyPort(host?: string): Promise<{ port: number; server: Server }> {
  const base = 20_000 + test.info().parallelIndex * PORTS_PER_WORKER;
  // leave room for the server's fallback to the next 20 ports
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = base + Math.floor(Math.random() * (PORTS_PER_WORKER - 40));
    // free on every interface, whatever we then listen on
    const probe = await listen(port);
    if (!probe) continue;
    await new Promise((r) => probe.close(r));
    const server = await listen(port, host);
    if (server) return { port, server };
  }
  throw new Error("no free port for the test");
}

async function freePort(): Promise<number> {
  const { port, server } = await occupyPort();
  await new Promise((r) => server.close(r));
  return port;
}

function portOf(url: string) {
  return Number(new URL(url).port);
}

/** A document of numbered paragraphs, "Paragraph n." on line 2n + 1. */
function paragraphs(count: number) {
  return `# Top\n\n${Array.from({ length: count }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n")}\n`;
}

/** Vertical position of an element relative to the viewport, once scrolling settles. */
async function settledTop(locator: Locator) {
  let previous = Number.NaN;
  for (let i = 0; i < 40; i++) {
    const top = (await locator.boundingBox())?.y ?? Number.NaN;
    if (Math.abs(top - previous) < 1) return top;
    previous = top;
    await locator.page().waitForTimeout(100);
  }
  throw new Error("page kept scrolling");
}

test.describe("g:mkdp_port", () => {
  test("is used when it is free", async ({ launch, page }) => {
    const port = await freePort();
    const editor = await launch({ vars: { mkdp_port: String(port) } });
    const url = await preview(editor, page, "note.md", "# Port\n");
    expect(portOf(url)).toBe(port);
    await expect(body(page).locator("h1")).toContainText("Port");
  });

  test("falls back to the next port when it is taken", async ({ launch, page }) => {
    const { port, server } = await occupyPort("127.0.0.1");
    try {
      const editor = await launch({ vars: { mkdp_port: port } });
      const url = await preview(editor, page, "note.md", "# Taken\n");
      expect(portOf(url)).toBeGreaterThan(port);
      expect(portOf(url)).toBeLessThan(port + 20);
      await expect(body(page).locator("h1")).toContainText("Taken");
    } finally {
      server.close();
    }
  });

  // A dev server listening on all interfaces, as Node does by default. The
  // preview only binds 127.0.0.1, which macOS allows next to it, but the URL
  // says localhost and browsers try ::1 first: they get the other server.
  test("a port another program listens on is not used", async ({ launch, page }) => {
    // Node listens on `::`, which macOS lets the server bind 127.0.0.1 next to
    const { port, server } = await occupyPort();
    try {
      const editor = await launch({ vars: { mkdp_port: port } });
      const title = token();
      const url = await preview(editor, page, "note.md", `# ${title}\n`);
      await expect(body(page).locator("h1")).toContainText(title);
      expect(portOf(url)).not.toBe(port);
    } finally {
      server.close();
    }
  });

  test("two editors with the same port each get a working preview", async ({ launch, page, context }) => {
    const port = await freePort();
    const first = await launch({ vars: { mkdp_port: port } });
    const second = await launch({ vars: { mkdp_port: port } });
    const a = token();
    const b = token();
    const urlA = await preview(first, page, "a.md", `# ${a}\n`);
    const other = await context.newPage();
    const urlB = await preview(second, other, "b.md", `# ${b}\n`);
    expect(portOf(urlA)).not.toBe(portOf(urlB));
    await expect(body(page).locator("h1")).toContainText(a);
    await expect(body(other).locator("h1")).toContainText(b);
  });
});

test.describe("g:mkdp_open_ip", () => {
  test.use({ mkdpVars: { mkdp_open_ip: "127.0.0.1" } });

  test("is the host of the preview URL", async ({ editor, page }) => {
    const url = await preview(editor, page, "note.md", "# IP\n");
    expect(new URL(url).hostname).toBe("127.0.0.1");
    await expect(body(page).locator("h1")).toContainText("IP");
  });
});

test.describe("g:mkdp_open_to_the_world", () => {
  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

  for (const open of [0, 1]) {
    test.describe(`= ${open}`, () => {
      test.use({ mkdpVars: { mkdp_open_to_the_world: open } });

      test(open ? "listens on the network" : "listens on localhost only", async ({ editor, page }) => {
        test.skip(!lanIp, "this machine has no network address to connect to");
        const url = await preview(editor, page, "note.md", "# World\n");
        await expect(body(page).locator("h1")).toContainText("World");
        const status = (path: string) =>
          fetch(`http://${lanIp}:${portOf(url)}${path}`).then(
            (r) => r.status,
            () => "refused",
          );
        const token = new URL(url).searchParams.get("token");
        expect(await status(`/page/1?token=${token}`)).toBe(open ? 200 : "refused");
        // without the token from the editor, the network sees nothing
        expect(await status("/page/1")).toBe(open ? 401 : "refused");
        expect(await status("/page/1?token=guess")).toBe(open ? 401 : "refused");
        if (open) expect(token).toMatch(/^[0-9a-f]{32}$/);
        else expect(token).toBeNull();
        if (open) expect(new URL(url).hostname).toBe(lanIp);
      });
    });
  }
});

test.describe("opening the browser", () => {
  /** An editor whose PATH starts with fake `open`, `xdg-open` and `fakebrowser` that record their arguments. */
  async function withFakeOpener(launch: (o: StartOptions) => Promise<Editor>, vars: Record<string, unknown> = {}) {
    const editor = await launch({ vars: { mkdp_browserfunc: "", ...vars } });
    const log = join(editor.dir, "opened");
    for (const name of ["open", "xdg-open", "fakebrowser"]) {
      chmodSync(editor.write(`bin/${name}`, `#!/bin/sh\necho "${name} $*" >> '${log}'\n`), 0o755);
    }
    // the server inherits the editor's environment
    await editor.command(`let $PATH = '${join(editor.dir, "bin")}:' . $PATH`);
    return { editor, log };
  }

  test("uses the system opener by default", async ({ launch }) => {
    test.skip(process.platform === "win32", "cmd.exe cannot be faked");
    const { editor, log } = await withFakeOpener(launch);
    await editor.open("note.md", "# Open\n");
    await editor.command("MarkdownPreview");
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const line = await readWhenPresent(log);
    expect(line).toMatch(new RegExp(`^${opener} http://localhost:\\d+/page/\\d+$`));
  });

  test("g:mkdp_browser names the browser", async ({ launch }) => {
    test.skip(process.platform === "win32", "cmd.exe cannot be faked");
    const { editor, log } = await withFakeOpener(launch, { mkdp_browser: "fakebrowser" });
    await editor.open("note.md", "# Browser\n");
    await editor.command("MarkdownPreview");
    const line = await readWhenPresent(log);
    // macOS passes the browser to `open -a`, other systems run it directly
    expect(line).toMatch(
      process.platform === "darwin"
        ? /^open -a fakebrowser http:\/\/localhost:\d+\/page\/\d+$/
        : /^fakebrowser http:\/\/localhost:\d+\/page\/\d+$/,
    );
  });

  test("g:mkdp_browser as a list runs that command with its arguments (#55)", async ({ launch }) => {
    test.skip(process.platform === "win32", "the fake browser is a shell script");
    const { editor, log } = await withFakeOpener(launch, { mkdp_browser: ["fakebrowser", "-P", "work profile"] });
    await editor.open("note.md", "# Argv\n");
    await editor.command("MarkdownPreview");
    const line = await readWhenPresent(log);
    expect(line).toMatch(/^fakebrowser -P work profile http:\/\/localhost:\d+\/page\/\d+$/);
  });

  test("a missing browser is reported in the editor", async ({ launch }) => {
    test.skip(process.platform === "darwin", "`open -a` reports a missing app itself");
    const editor = await launch({ vars: { mkdp_browserfunc: "", mkdp_browser: "no-such-browser-mkdp" } });
    await editor.open("note.md", "# Missing\n");
    await editor.command("MarkdownPreview");
    await expect.poll(() => editor.messages(), { timeout: 10_000 }).toContain("Can not open browser");
  });
});

async function readWhenPresent(file: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  let content = "";
  await expect
    .poll(
      () => {
        try {
          content = readFileSync(file, "utf8").trim();
        } catch {
          content = "";
        }
        return content;
      },
      { timeout: 10_000 },
    )
    .not.toBe("");
  return content;
}

test.describe("g:mkdp_echo_preview_url", () => {
  test.use({ mkdpVars: { mkdp_echo_preview_url: 1 } });

  test("echoes the URL", async ({ editor }) => {
    await editor.open("note.md", "# Echo\n");
    await editor.command("MarkdownPreview");
    const url = await editor.previewUrl();
    await expect.poll(() => editor.messages()).toContain(`Preview page: ${url}`);
  });
});

test.describe("g:mkdp_on_start and g:mkdp_on_stop", () => {
  test("are called with the preview URL and when the preview stops", async ({ launch, page }) => {
    const editor = await launch({
      vars: { mkdp_on_start: "MkdpStarted", mkdp_on_stop: "MkdpStopped" },
      init: [
        "let g:started = [] | let g:stopped = 0",
        "function! MkdpStarted(url) abort",
        "  call add(g:started, a:url)",
        "endfunction",
        "function! MkdpStopped() abort",
        "  let g:stopped += 1",
        "endfunction",
      ],
    });
    const url = await preview(editor, page, "note.md", "# Hooks\n");
    await expect.poll(() => editor.eval<string[]>("g:started")).toEqual([url]);
    expect(await editor.eval("g:stopped")).toBe(0);
    await editor.command("MarkdownPreviewStop");
    await expect.poll(() => editor.eval("g:stopped")).toBe(1);
    // stopping again with no server running is not a stop
    await editor.command("MarkdownPreviewStop");
    expect(await editor.eval("g:stopped")).toBe(1);
  });

  test("a failing hook is reported", async ({ launch, page }) => {
    const editor = await launch({ vars: { mkdp_on_start: "NoSuchMkdpHook" } });
    await preview(editor, page, "note.md", "# Hooks\n");
    await expect.poll(() => editor.messages()).toContain("g:mkdp_on_start failed");
  });
});

test.describe("require('markdown-preview').setup()", () => {
  test("sets the options, hooks included", async ({ launch, page, editorKind }) => {
    test.skip(editorKind === "vim", "Lua configuration is Neovim only");
    const title = token();
    const editor = await launch({
      init: [
        "lua << EOF",
        "require('markdown-preview').setup({",
        `  page_title = '${title} \${name}',`,
        "  preview_options = { disable_filename = 1 },",
        "  on_start = function(url) vim.g.lua_started = url end,",
        "})",
        "EOF",
      ],
    });
    const url = await preview(editor, page, "note.md", "# Setup\n");
    await expect(page).toHaveTitle(`${title} note`);
    await expect.poll(() => editor.eval("get(g:, 'lua_started', '')")).toBe(url);
    // the defaults of the other preview options are kept
    expect(await editor.eval("g:mkdp_preview_options.sync_scroll_type")).toBe("middle");
    expect(await editor.eval("g:mkdp_preview_options.disable_filename")).toBe(1);
  });

  test("warns about unknown and mistyped options", async ({ launch, editorKind }) => {
    test.skip(editorKind === "vim", "Lua configuration is Neovim only");
    const editor = await launch({
      init: ["lua require('markdown-preview').setup({ prot = 8080, auto_start = 'yes' })"],
    });
    const messages = await editor.messages();
    expect(messages).toContain('unknown option "prot"');
    expect(messages).toContain('option "auto_start" should be a boolean, got a string');
    expect(await editor.eval("g:mkdp_auto_start")).toBe(0);
  });
});

test.describe("g:mkdp_page_title", () => {
  test.use({ mkdpVars: { mkdp_page_title: "${name} | preview" } });

  test("sets the page title", async ({ editor, page }) => {
    await preview(editor, page, "my-notes.md", "# Title\n");
    await expect(page).toHaveTitle("my-notes | preview");
  });
});

test.describe("g:mkdp_preview_options", () => {
  test.describe("disable_filename", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { disable_filename: 1 } } });

    test("hides the file name header", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Shown\n");
      await expect(body(page).locator("h1")).toContainText("Shown");
      await expect(page.locator("#page-header")).toHaveCount(0);
    });
  });

  test.describe("content_editable", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { content_editable: true } } });

    test("makes the page editable", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Editable\n\nchange me\n");
      await expect(page.locator("#page-ctn")).toHaveAttribute("contenteditable", "true");
      await body(page).locator("p").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" typed in the browser");
      await expect(body(page).locator("p")).toHaveText("change me typed in the browser");
    });
  });

  test("the page is not editable by default", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Fixed\n");
    await expect(body(page).locator("h1")).toContainText("Fixed");
    await expect(page.locator("#page-ctn")).not.toHaveAttribute("contenteditable", "true");
  });

  test.describe("hide_yaml_meta = 0", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { hide_yaml_meta: 0 } } });

    test("shows the front matter", async ({ editor, page }) => {
      const meta = token();
      await preview(editor, page, "note.md", `---\ntitle: ${meta}\n---\n\n# Body\n`);
      await expect(body(page).locator("h1")).toContainText("Body");
      await expect(body(page)).toContainText(meta);
    });
  });

  test("front matter is hidden by default", async ({ editor, page }) => {
    const meta = token();
    await preview(editor, page, "note.md", `---\ntitle: ${meta}\n---\n\n# Body\n`);
    await expect(body(page).locator("h1")).toContainText("Body");
    await expect(body(page)).not.toContainText(meta);
  });

  test.describe("mkit", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { mkit: { breaks: true, html: false } } } });

    test("configures markdown-it", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Mkit\n\nfirst\nsecond\n\n<b>raw</b>\n");
      await expect(body(page).locator("p").first().locator("br")).toHaveCount(1);
      await expect(body(page)).toContainText("<b>raw</b>");
      await expect(body(page).locator("b")).toHaveCount(0);
    });
  });

  test.describe("katex", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { katex: { macros: { "\\mkdp": "\\Omega" } } } } });

    test("configures KaTeX", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Math\n\n$\\mkdp$\n");
      await expect(body(page).locator(".katex-html")).toHaveText("Ω");
    });
  });

  test.describe("toc", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { toc: { listType: "ol" } } } });

    test("configures the table of contents", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "${toc}\n\n# One\n\n## Two\n");
      await expect(body(page).locator("ol a")).toHaveText(["One", "Two"]);
    });
  });

  test.describe("uml", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { uml: { server: "http://uml.invalid", imageFormat: "png" } } } });

    test("configures the PlantUML server", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Uml\n\n```plantuml\nA -> B\n```\n");
      await expect(body(page).locator("img").first()).toHaveAttribute("src", /^http:\/\/uml\.invalid\/png\//);
    });
  });

  test.describe("maid", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { maid: { theme: "forest" } } } });

    test("configures mermaid", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Maid\n\n```mermaid\ngraph TD\n  A --> B\n```\n");
      const svg = body(page).locator(".mermaid > svg");
      await expect(svg).toHaveCount(1, { timeout: 20_000 });
      // the forest theme's node fill
      expect(await svg.innerHTML()).toContain("#cde498");
    });
  });
});

test.describe("sync scroll", () => {
  const line = (n: number) => 2 * n + 1;

  test("middle (default) keeps the cursor line in the middle", async ({ editor, page }) => {
    await preview(editor, page, "long.md", paragraphs(200));
    await editor.keys(`${line(120)}G`);
    const target = body(page).getByText("Paragraph 120.", { exact: true });
    await expect(target).toBeInViewport();
    const viewport = page.viewportSize()!.height;
    expect(Math.abs((await settledTop(target)) - viewport / 2)).toBeLessThan(60);
  });

  test.describe("top", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { sync_scroll_type: "top" } } });

    test("keeps the top line of the window at the top", async ({ editor, page }) => {
      await preview(editor, page, "long.md", paragraphs(200));
      await editor.keys(`${line(120)}Gzt`);
      const target = body(page).getByText("Paragraph 120.", { exact: true });
      await expect(target).toBeInViewport();
      expect(Math.abs(await settledTop(target))).toBeLessThan(40);
    });
  });

  test.describe("relative", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { sync_scroll_type: "relative" } } });

    test("keeps the cursor line at the same height as in the window", async ({ editor, page }) => {
      await preview(editor, page, "long.md", paragraphs(200));
      await editor.keys(`${line(120)}Gzb`);
      const target = body(page).getByText("Paragraph 120.", { exact: true });
      await expect(target).toBeInViewport();
      // the cursor is on the last line of the window, so near the bottom
      const viewport = page.viewportSize()!.height;
      expect(await settledTop(target)).toBeGreaterThan(viewport * 0.75);
    });
  });

  test.describe("disable_sync_scroll", () => {
    test.use({ mkdpVars: { mkdp_preview_options: { disable_sync_scroll: 1 } } });

    test("leaves the scroll position alone", async ({ editor, page }) => {
      await preview(editor, page, "long.md", paragraphs(200));
      const typed = token();
      await editor.keys(`GO${typed}<Esc>`);
      // the page did get the update, it just did not scroll to it
      await expect(body(page)).toContainText(typed);
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });
  });
});

test.describe("g:mkdp_refresh_slow", () => {
  test.use({ mkdpVars: { mkdp_refresh_slow: 1 } });

  test("refreshes on leaving insert mode, not while typing", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Slow\n");
    await expect(body(page).locator("h1")).toContainText("Slow");
    const typed = token();
    await editor.keys(`Go${typed}`);
    await expect.poll(() => editor.eval<string>("getline('$')")).toBe(typed);
    await page.waitForTimeout(1_000);
    await expect(body(page)).not.toContainText(typed);

    await editor.keys("<Esc>");
    await expect(body(page)).toContainText(typed);
  });

  test("refreshes on saving", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Slow\n");
    // CursorHold refreshes too; keep it from firing. Vim keeps the timeout
    // of a wait that has already started, so type a key to start a new one
    await editor.command("set updatetime=100000");
    await editor.keys("0");
    await page.waitForTimeout(300);
    const typed = token();
    await editor.command(`call setline(2, '${typed}')`);
    await page.waitForTimeout(1_000);
    await expect(body(page)).not.toContainText(typed);
    await editor.command("write");
    await expect(body(page)).toContainText(typed);
  });
});

test.describe("g:mkdp_auto_close", () => {
  test("= 1 (default) stops the preview when leaving the buffer", async ({ editor, page }) => {
    // Vim's default 'nohidden' unloads the buffer (BufUnload), Neovim's
    // 'hidden' hides it (BufHidden)
    await preview(editor, page, "note.md", "# Close\n");
    await expect(body(page).locator("h1")).toContainText("Close");
    editor.write("other.md", "# Other\n");
    await editor.command("edit other.md");
    await expect(page.locator("#page-header .status")).toHaveText("Preview stopped");
  });

  test.describe("= 0", () => {
    test.use({ mkdpVars: { mkdp_auto_close: 0 } });

    test("keeps the preview when leaving the buffer", async ({ editor, page }) => {
      await preview(editor, page, "note.md", "# Stay\n");
      await expect(body(page).locator("h1")).toContainText("Stay");
      editor.write("other.md", "# Other\n");
      await editor.command("edit other.md");
      await editor.command("edit note.md");
      const typed = token();
      await editor.keys(`Go${typed}<Esc>`);
      await expect(body(page)).toContainText(typed);
      await expect(page.locator("#page-header .status")).toHaveCount(0);
    });
  });
});

test.describe("g:mkdp_auto_start", () => {
  test.use({ mkdpVars: { mkdp_auto_start: 1 } });

  test("opens the preview when entering a markdown buffer", async ({ editor, page }) => {
    const title = token();
    await editor.open("note.md", `# ${title}\n`);
    await page.goto(await editor.previewUrl());
    await expect(body(page).locator("h1")).toContainText(title);
  });

  test("does not open it for other files", async ({ editor }) => {
    await editor.open("notes.txt", "# not markdown\n");
    await editor.command("sleep 1500m");
    expect(await editor.urls()).toEqual([]);
  });
});

test.describe("g:mkdp_combine_preview", () => {
  test.use({ mkdpVars: { mkdp_combine_preview: 1, mkdp_auto_close: 0 } });

  test("shows the entered markdown buffer in the open page", async ({ editor, page }) => {
    const a = token();
    const b = token();
    await preview(editor, page, "a.md", `# ${a}\n`);
    await expect(body(page).locator("h1")).toContainText(a);

    editor.write("b.md", `# ${b}\n`);
    await editor.command("edit b.md");
    await expect(body(page).locator("h1")).toContainText(b);
    const bufnr = await editor.eval<number>("bufnr('%')");
    await expect(page).toHaveURL(new RegExp(`/page/${bufnr}$`));
    // edits to the new buffer show up too
    const typed = token();
    await editor.keys(`Go${typed}<Esc>`);
    await expect(body(page)).toContainText(typed);
    // and no second browser was opened
    expect(await editor.urls()).toHaveLength(1);
  });
});

test.describe("g:mkdp_combine_preview_auto_refresh = 0", () => {
  test.use({ mkdpVars: { mkdp_combine_preview: 1, mkdp_combine_preview_auto_refresh: 0, mkdp_auto_close: 0 } });

  test("keeps the page on its buffer until :MarkdownPreview", async ({ editor, page }) => {
    const a = token();
    const b = token();
    await preview(editor, page, "a.md", `# ${a}\n`);
    await expect(body(page).locator("h1")).toContainText(a);
    editor.write("b.md", `# ${b}\n`);
    await editor.command("edit b.md");
    await page.waitForTimeout(1_000);
    await expect(body(page).locator("h1")).toContainText(a);

    await editor.command("MarkdownPreview");
    await expect(body(page).locator("h1")).toContainText(b);
    expect(await editor.urls()).toHaveLength(1);
  });
});

test.describe("preview commands", () => {
  const commands = ["MarkdownPreview", "MarkdownPreviewStop", "MarkdownPreviewToggle"];

  test("exist in markdown buffers only by default", async ({ editor }) => {
    await editor.open("notes.txt", "text\n");
    for (const cmd of commands) expect(await editor.eval<number>(`exists(':${cmd}')`), cmd).toBe(0);
    await editor.open("note.md", "# md\n");
    for (const cmd of commands) expect(await editor.eval<number>(`exists(':${cmd}')`), cmd).toBe(2);
  });

  test.describe("g:mkdp_command_for_global", () => {
    test.use({ mkdpVars: { mkdp_command_for_global: 1 } });

    test("adds them to every buffer", async ({ editor, page }) => {
      const text = token();
      await editor.open("notes.txt", `# ${text}\n`);
      await editor.command("MarkdownPreview");
      await page.goto(await editor.previewUrl());
      await expect(body(page).locator("h1")).toContainText(text);
    });
  });

  test.describe("g:mkdp_filetypes", () => {
    test.use({ mkdpVars: { mkdp_filetypes: ["markdown", "vimwiki"] } });

    test("adds them to the listed filetypes", async ({ editor, page }) => {
      const text = token();
      await editor.open("wiki.txt", `# ${text}\n`);
      expect(await editor.eval<number>("exists(':MarkdownPreview')")).toBe(0);
      await editor.command("set filetype=vimwiki");
      expect(await editor.eval<number>("exists(':MarkdownPreview')")).toBe(2);
      await editor.command("MarkdownPreview");
      await page.goto(await editor.previewUrl());
      await expect(body(page).locator("h1")).toContainText(text);
    });
  });

  test("<Plug> mappings run the commands", async ({ editor, page }) => {
    await editor.open("note.md", "# Mapped\n");
    await editor.command("nmap <buffer> <F5> <Plug>MarkdownPreviewToggle");
    await editor.keys("<F5>");
    await page.goto(await editor.previewUrl());
    await expect(body(page).locator("h1")).toContainText("Mapped");
    await editor.keys("<F5>");
    await expect(page.locator("#page-header .status")).toHaveText("Preview stopped");
  });
});

test.describe("custom CSS", () => {
  test("g:mkdp_markdown_css and g:mkdp_highlight_css replace the page styles", async ({ launch, page }) => {
    const editor = await launch();
    const markdownCss = editor.write("style/markdown.css", ".markdown-body h1 { color: rgb(1, 2, 3); }\n");
    const highlightCss = editor.write("style/highlight.css", ".hljs-keyword { color: rgb(4, 5, 6); }\n");
    await editor.command(`let g:mkdp_markdown_css = '${markdownCss}'`);
    await editor.command(`let g:mkdp_highlight_css = '${highlightCss}'`);
    await preview(editor, page, "note.md", "# Styled\n\n```js\nconst x = 1;\n```\n");
    await expect(body(page).locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(body(page).locator(".hljs-keyword")).toHaveCSS("color", "rgb(4, 5, 6)");
  });

  test("the built-in styles apply by default", async ({ editor, page }) => {
    await preview(editor, page, "note.md", "# Styled\n\n```js\nconst x = 1;\n```\n");
    await expect(body(page).locator("h1")).not.toHaveCSS("color", "rgb(0, 0, 0)");
    // app/public/_static/highlight.css colors keywords
    const color = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);
    expect(await color(body(page).locator(".hljs-keyword"))).not.toBe(await color(body(page).locator("pre code")));
  });
});

test.describe("g:mkdp_theme_css", () => {
  const link = "[link](https://example.com)";

  test("a shadcn theme restyles the page, in both themes", async ({ launch, page }) => {
    const editor = await launch();
    const theme = editor.write(
      "theme/globals.css",
      [
        '@import "tailwindcss";',
        ":root { --primary: rgb(10, 20, 30); --card: rgb(250, 250, 240); }",
        ".dark { --primary: rgb(200, 210, 220); --card: rgb(5, 6, 7); }",
        "@theme inline { --color-primary: var(--primary); }",
        "@layer base { * { @apply border-border; } }",
      ].join("\n"),
    );
    await editor.command(`let g:mkdp_theme_css = '${theme}'`);
    await preview(editor, page, "note.md", `# Themed\n\n${link}\n`);
    await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).waitFor({ state: "attached" });
    const toggle = page.locator(".theme-toggle");
    if ((await page.locator("html").getAttribute("data-theme")) === "dark") await toggle.click();

    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await expect(body(page).locator('a[href^="https"]')).toHaveCSS("color", "rgb(10, 20, 30)");
    await expect(body(page)).toHaveCSS("background-color", "rgb(250, 250, 240)");

    await toggle.click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(body(page).locator('a[href^="https"]')).toHaveCSS("color", "rgb(200, 210, 220)");
    await expect(body(page)).toHaveCSS("background-color", "rgb(5, 6, 7)");
  });

  test("a Tailwind v3 theme with bare HSL colors", async ({ launch, page }) => {
    const editor = await launch();
    const theme = editor.write(
      "theme.css",
      "@layer base {\n  :root {\n    --primary: 0 100% 50%;\n    --radius: 0rem;\n  }\n  .dark {\n    --primary: 0 100% 50%;\n  }\n}\n",
    );
    await editor.command(`let g:mkdp_theme_css = '${theme}'`);
    await preview(editor, page, "note.md", `# Themed\n\n${link}\n`);
    // the layered theme still wins over the built-in defaults
    await expect(body(page).locator('a[href^="https"]')).toHaveCSS("color", "rgb(255, 0, 0)");
    await expect(page.locator("#page-header")).toHaveCSS("border-top-left-radius", "0px");
  });

  test("fonts: a file next to the theme", async ({ launch, page }) => {
    const editor = await launch();
    const font = readFileSync(join(REPO, "app/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2"));
    editor.write("theme/fonts/Test Font.woff2", font);
    const theme = editor.write(
      "theme/globals.css",
      [
        '@font-face { font-family: "Mkdp Test"; src: url("fonts/Test%20Font.woff2") format("woff2"); }',
        ':root { --font-sans: "Mkdp Test", sans-serif; }',
      ].join("\n"),
    );
    await editor.command(`let g:mkdp_theme_css = '${theme}'`);
    const fontResponse = page.waitForResponse((r) => r.url().endsWith("/_theme/fonts/Test%20Font.woff2"));
    await preview(editor, page, "note.md", "# Font\n\ntext\n");
    expect((await fontResponse).status()).toBe(200);
    await expect(body(page)).toHaveCSS("font-family", '"Mkdp Test", sans-serif');
    const loaded = await page.evaluate(async () => (await document.fonts.load('16px "Mkdp Test"')).length);
    expect(loaded).toBe(1);
  });
});

test.describe("images", () => {
  const svg = (w: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="10"><rect width="${w}" height="10"/></svg>`;
  const width = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.naturalWidth);

  test("relative, rooted, HTML and sized images", async ({ editor, page }) => {
    editor.write("docs/pics/rel.svg", svg(11));
    // "/assets/root.svg" is looked up in the parent directories of the file
    editor.write("assets/root.svg", svg(13));
    editor.write("docs/pics/html.svg", svg(17));
    await preview(
      editor,
      page,
      "docs/note.md",
      [
        "# Images",
        "![rel](pics/rel.svg)",
        "![dot](./pics/rel.svg)",
        "![root](/assets/root.svg)",
        '<img alt="html" src="pics/html.svg">',
        "![sized](pics/rel.svg =30x20)",
      ].join("\n\n"),
    );
    const md = body(page);
    await expect.poll(() => width(md.locator("img[alt=rel]"))).toBe(11);
    await expect.poll(() => width(md.locator("img[alt=dot]"))).toBe(11);
    await expect.poll(() => width(md.locator("img[alt=root]"))).toBe(13);
    await expect.poll(() => width(md.locator("img[alt=html]"))).toBe(17);
    const sized = md.locator("img[alt=sized]");
    await expect.poll(async () => (await sized.boundingBox())?.width).toBe(30);
    expect((await sized.boundingBox())?.height).toBe(20);
  });

  test("an absolute path", async ({ editor, page }) => {
    const file = editor.write("elsewhere/abs.svg", svg(19));
    await preview(editor, page, "note.md", `# Abs\n\n![abs](${file})\n`);
    await expect.poll(() => width(body(page).locator("img[alt=abs]"))).toBe(19);
  });

  test("a missing image does not break the page", async ({ editor, page }) => {
    const after = token();
    await preview(editor, page, "note.md", `# Missing\n\n![gone](nope.svg)\n\n${after}\n`);
    await expect(body(page)).toContainText(after);
    const img = body(page).locator("img[alt=gone]");
    await expect(img).toHaveCount(1);
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 0)).toBe(true);
  });

  test.describe("g:mkdp_images_path", () => {
    test("resolves images against another directory", async ({ launch, page }) => {
      const editor = await launch();
      editor.write("assets/pic.svg", svg(23));
      await editor.command(`let g:mkdp_images_path = '${editor.dir}/assets'`);
      await preview(editor, page, "notes/note.md", "# Path\n\n![pic](pic.svg)\n");
      await expect.poll(() => width(body(page).locator("img[alt=pic]"))).toBe(23);
    });
  });
});
