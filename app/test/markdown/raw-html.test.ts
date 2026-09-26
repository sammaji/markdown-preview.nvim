import { describe, expect, test } from "vitest";

import { render } from "../render";

// g:mkdp_preview_options.mkit is passed to markdown-it, so {'html': v:false}
// is the switch for previewing markdown you don't trust
describe("raw HTML", () => {
  const SRC = "<div class=raw>kept</div>\n\nText with <b>inline</b> and <img src=x onerror=alert(1)>";

  test("is rendered by default", () => {
    const root = render(SRC);
    expect(root.querySelector("div.raw")?.textContent).toBe("kept");
    expect(root.querySelector("b")?.textContent).toBe("inline");
    expect(root.querySelector("img[onerror]")).not.toBeNull();
  });

  test("is shown as text with mkit.html = false", () => {
    const root = render(SRC, { mkit: { html: false } });
    expect(root.querySelector("div.raw")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain('<div class=raw>kept</div>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  test("markdown still renders with mkit.html = false", () => {
    const root = render("# Title\n\n**bold** and `code`", { mkit: { html: false } });
    expect(root.querySelector("h1")?.textContent?.trim()).toBe("Title");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
  });
});
