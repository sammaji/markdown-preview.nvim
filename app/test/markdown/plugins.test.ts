import { describe, expect, test } from "vitest";

import { render } from "../render";

describe("headings", () => {
  test("get an id and a permalink with the octicon before the text", () => {
    const root = render("## Getting Started");
    const heading = root.querySelector("h2")!;
    expect(heading.id).toBe("getting-started");
    // the link comes first, then the heading text
    const anchor = heading.firstChild as Element;
    expect(anchor.nodeName).toBe("A");
    expect(heading.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(anchor.className).toBe("anchor");
    expect(anchor.getAttribute("href")).toBe("#getting-started");
    expect(anchor.getAttribute("aria-hidden")).toBe("true");
    expect(anchor.querySelector("svg.octicon.octicon-link > path")).not.toBeNull();
    expect(heading.textContent?.trim()).toBe("Getting Started");
  });

  test("repeated headings get unique ids", () => {
    const ids = [...render("# Same\n\n# Same").querySelectorAll("h1")].map((h) => h.id);
    expect(ids).toEqual(["same", "same-1"]);
  });
});

describe("table of contents", () => {
  const DOC = "${toc}\n\n# One\n\n## Two\n\n### Three\n\n# Four";

  test("${toc} becomes nested links to the headings", () => {
    const root = render(DOC);
    const nav = root.querySelector("nav.table-of-contents");
    expect(nav).not.toBeNull();
    const links = [...nav!.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.textContent?.trim()])).toEqual([
      ["#one", "One"],
      ["#two", "Two"],
      ["#three", "Three"],
      ["#four", "Four"],
    ]);
    // every link points at a heading on the page
    for (const a of links) {
      expect(root.querySelector(`[id="${a.getAttribute("href")!.slice(1)}"]`)?.tagName).toMatch(/^H\d$/);
    }
    expect(nav!.querySelector(":scope > ul > li > ul > li > ul > li > a")?.getAttribute("href")).toBe("#three");
    expect(root.textContent).not.toContain("${toc}");
  });

  test("uses the toc options", () => {
    const root = render(DOC, { toc: { listType: "ol" } });
    expect(root.querySelector("nav.table-of-contents > ol")).not.toBeNull();
    expect(root.querySelector("nav.table-of-contents ul")).toBeNull();

    const deep = render(DOC, { toc: { level: 2, containerClass: "toc" } });
    const hrefs = [...deep.querySelectorAll("nav.toc a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#two", "#three"]);
  });
});

describe("markdown-it plugins", () => {
  test("emoji shortcodes", () => {
    const p = render(":smile: :rocket: :+1: :not_an_emoji:").querySelector("p");
    expect(p?.textContent).toBe("😄 🚀 👍 :not_an_emoji:");
  });

  test("task lists", () => {
    const root = render("- [ ] todo\n- [x] done\n- plain");
    expect(root.querySelector("ul.contains-task-list")).not.toBeNull();
    const items = [...root.querySelectorAll("li")];
    const boxes = items.map((li) => li.querySelector<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes[0]?.checked).toBe(false);
    expect(boxes[1]?.checked).toBe(true);
    expect(boxes[2]).toBeNull();
    expect(boxes[0]?.disabled).toBe(true);
    expect(items[0].classList.contains("task-list-item")).toBe(true);
    expect(items.map((li) => li.textContent?.trim())).toEqual(["todo", "done", "plain"]);
  });

  test("definition lists", () => {
    const root = render("Preview\n: A browser page.\n\nSync scroll\n: Follows the cursor.");
    const dl = root.querySelector("dl");
    expect([...dl!.children].map((c) => [c.tagName, c.textContent])).toEqual([
      ["DT", "Preview"],
      ["DD", "A browser page."],
      ["DT", "Sync scroll"],
      ["DD", "Follows the cursor."],
    ]);
  });

  test("footnotes", () => {
    const root = render("Claim[^note].\n\n[^note]: The source.");
    const ref = root.querySelector("sup.footnote-ref > a");
    expect(ref?.getAttribute("href")).toBe("#fn1");
    const item = root.querySelector("section.footnotes li#fn1");
    expect(item?.textContent).toContain("The source.");
    expect(item?.querySelector("a.footnote-backref")?.getAttribute("href")).toBe(`#${ref?.id}`);
    expect(root.querySelector("p")?.textContent).toBe("Claim[1].");
  });

  test("linkify bare URLs", () => {
    const a = render("See https://neovim.io for more").querySelector("p > a");
    expect(a?.getAttribute("href")).toBe("https://neovim.io");
    expect(a?.textContent).toBe("https://neovim.io");
  });

  test("typographer quotes, dashes and symbols", () => {
    const p = render(`"double" 'single' en -- em --- (c) (tm) wait...`).querySelector("p");
    expect(p?.textContent).toBe("“double” ‘single’ en – em — © ™ wait…");
  });

  test("raw HTML is passed through", () => {
    const root = render("Press <kbd>Ctrl</kbd>\n\n<details>\n<summary>More</summary>\n\nHidden **text**\n\n</details>");
    expect(root.querySelector("p > kbd")?.textContent).toBe("Ctrl");
    expect(root.querySelector("details > summary")?.textContent).toBe("More");
    expect(root.querySelector("details strong")?.textContent).toBe("text");
  });

  test("strikethrough and tables", () => {
    const root = render("~~gone~~\n\n| a | b |\n| :-- | --: |\n| 1 | 2 |");
    expect(root.querySelector("s")?.textContent).toBe("gone");
    expect([...root.querySelectorAll("td")].map((td) => [td.textContent, td.style.textAlign])).toEqual([
      ["1", "left"],
      ["2", "right"],
    ]);
  });

  test("soft line breaks are not <br> by default", () => {
    expect(render("a\nb").querySelector("br")).toBeNull();
  });
});

describe("mkit options override the defaults", () => {
  test("breaks: true", () => {
    const p = render("a\nb", { mkit: { breaks: true } }).querySelector("p")!;
    expect(p.querySelector("br")).not.toBeNull();
  });

  test("html: false escapes HTML", () => {
    const root = render("x <kbd>Ctrl</kbd>\n\n<div>block</div>", { mkit: { html: false } });
    expect(root.querySelector("kbd")).toBeNull();
    expect(root.querySelector("div")).toBeNull();
    expect(root.textContent).toContain("<kbd>Ctrl</kbd>");
    expect(root.textContent).toContain("<div>block</div>");
  });

  test("linkify: false", () => {
    const root = render("See https://neovim.io", { mkit: { linkify: false } });
    expect(root.querySelector("a")).toBeNull();
  });

  test("typographer: false", () => {
    const p = render(`"q" -- (c)`, { mkit: { typographer: false } }).querySelector("p");
    expect(p?.textContent).toBe(`"q" -- (c)`);
  });

  test("other defaults are kept", () => {
    const root = render('"q" https://neovim.io', { mkit: { breaks: true } });
    expect(root.querySelector("a")).not.toBeNull();
    expect(root.querySelector("p")?.textContent).toContain("“q”");
  });
});
