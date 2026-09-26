import { describe, expect, test } from "vitest";

import { render } from "../render";

const DOC = "---\ntitle: secret title\ntags: [a, b]\n---\n\n# Heading\n\nBody text";

describe("YAML front matter", () => {
  test("is hidden by default", () => {
    const root = render(DOC);
    expect(root.textContent).not.toContain("secret title");
    expect(root.querySelector("hr")).toBeNull();
    expect(root.querySelector("h1")?.textContent?.trim()).toBe("Heading");
    expect(root.querySelector("p")?.textContent).toBe("Body text");
  });

  test("is hidden with hide_yaml_meta: 1", () => {
    const root = render(DOC, { hide_yaml_meta: 1 });
    expect(root.textContent).not.toContain("secret title");
    expect(root.querySelector("hr")).toBeNull();
  });

  test("may be closed with `...`", () => {
    const root = render("---\ntitle: secret title\n...\n\nBody text");
    expect(root.textContent).not.toContain("secret title");
    expect(root.querySelector("p")?.textContent).toBe("Body text");
  });

  test("is shown with hide_yaml_meta: 0", () => {
    const root = render(DOC, { hide_yaml_meta: 0 });
    expect(root.textContent).toContain("title: secret title");
    expect(root.textContent).toContain("tags: [a, b]");
    // rendered as plain markdown: a thematic break and a setext heading
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.querySelector("h1")?.textContent?.trim()).toBe("Heading");
  });

  test("is only stripped at the top of the document", () => {
    const root = render("Intro\n\n---\ntitle: visible\n---\n\nBody");
    expect(root.textContent).toContain("title: visible");
    expect(root.querySelector("p")?.textContent).toBe("Intro");
  });

  test("only the block at the top is stripped", () => {
    const root = render("---\ntitle: secret title\n---\n\nBody\n\n---\nnot: meta\n---\n");
    expect(root.textContent).not.toContain("secret title");
    expect(root.textContent).toContain("Body");
    expect(root.textContent).toContain("not: meta");
  });

  test("is not stripped when indented", () => {
    const root = render(" ---\ntitle: visible\n---\n\nBody");
    expect(root.textContent).toContain("title: visible");
  });

  test("without a closing line is not stripped", () => {
    const root = render("---\ntitle: visible\n\nBody");
    expect(root.textContent).toContain("title: visible");
    expect(root.textContent).toContain("Body");
  });

  test("keeps the source lines of the content after it", () => {
    const root = render(DOC);
    // 0-based: the heading is on the 6th line
    expect(root.querySelector("h1")?.dataset.sourceLine).toBe("5");
    expect(root.querySelector("p")?.dataset.sourceLine).toBe("7");
  });
});

describe("front_matter option", () => {
  test('"hide" hides it, whatever hide_yaml_meta says', () => {
    const root = render(DOC, { front_matter: "hide", hide_yaml_meta: 0 });
    expect(root.textContent).not.toContain("secret title");
    expect(root.querySelector("details")).toBeNull();
  });

  test('"raw" renders it as markdown', () => {
    const root = render(DOC, { front_matter: "raw" });
    expect(root.textContent).toContain("title: secret title");
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.querySelector("details")).toBeNull();
  });

  test('"panel" shows it in a collapsed <details>', () => {
    const root = render(DOC, { front_matter: "panel", hide_yaml_meta: 0 });
    const panel = root.querySelector<HTMLDetailsElement>("details.front-matter")!;
    expect(panel).not.toBeNull();
    expect(panel.open).toBe(false);
    expect(panel.querySelector("summary")?.textContent).toBe("Front matter");
    expect(panel.querySelector("pre code")?.textContent).toBe("title: secret title\ntags: [a, b]");
    // highlighted as YAML
    expect(panel.querySelector("span.hljs-attr")?.textContent).toBe("title:");
    // not also rendered as markdown
    expect(root.querySelector("hr")).toBeNull();
    expect(root.querySelector("h1")?.textContent?.trim()).toBe("Heading");
    expect(root.firstElementChild).toBe(panel);
  });

  test('"panel" escapes the YAML', () => {
    const root = render('---\nx: "<img src=x onerror=alert(1)>"\n---\n', { front_matter: "panel" });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("details code")?.textContent).toContain("<img src=x");
  });

  test('"panel" keeps the source lines after it', () => {
    const root = render(DOC, { front_matter: "panel" });
    expect(root.querySelector<HTMLElement>("details")?.dataset.sourceLine).toBe("0");
    expect(root.querySelector("h1")?.dataset.sourceLine).toBe("5");
  });

  test("an empty block gives an empty panel", () => {
    const root = render("---\n---\n\nBody", { front_matter: "panel" });
    expect(root.querySelector("details.front-matter code")?.textContent).toBe("");
    expect(root.querySelector("p")?.textContent).toBe("Body");
  });

  test("an unknown value falls back to hide_yaml_meta", () => {
    // @ts-expect-error: invalid on purpose, it comes from the user's vimrc
    expect(render(DOC, { front_matter: "bogus" }).textContent).not.toContain("secret title");
    // @ts-expect-error: same
    expect(render(DOC, { front_matter: "bogus", hide_yaml_meta: 0 }).textContent).toContain("secret title");
  });
});
