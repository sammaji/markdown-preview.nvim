import { describe, expect, test, vi } from "vitest";

import { createRenderer } from "@/lib/markdown";

import { render } from "../render";

// the TeX source KaTeX keeps in its MathML annotation
function tex(element: Element | null) {
  return element?.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
}

describe("KaTeX", () => {
  test.each([
    ["$", "$"],
    ["\\(", "\\)"],
  ])("renders %sinline%s math inside the paragraph", (open, close) => {
    const root = render(`Energy ${open}E = mc^2${close} here`);
    const p = root.querySelector("p")!;
    const math = p.querySelector(".katex");
    expect(math).not.toBeNull();
    expect(p.querySelector(".katex-display")).toBeNull();
    expect(tex(math)).toBe("E = mc^2");
    expect(p.firstChild?.textContent).toBe("Energy ");
    expect(p.lastChild?.textContent).toBe(" here");
    expect(p.textContent).not.toContain("$");
  });

  test.each([
    ["$$", "$$"],
    ["\\[", "\\]"],
  ])("renders %sblock%s math in display mode", (open, close) => {
    const root = render(`${open}\n\\int_0^1 x \\, dx\n${close}\n\nafter`);
    const display = root.querySelector(".katex-display");
    expect(display).not.toBeNull();
    expect(display!.querySelector('math[display="block"]')).not.toBeNull();
    expect(tex(display)).toBe("\\int_0^1 x \\, dx");
    expect(root.querySelector("p.source-line")?.textContent).toBe("after");
  });

  test.each([
    ["$$", "$$"],
    ["\\[", "\\]"],
  ])("renders single-line %sblock%s math", (open, close) => {
    const root = render(`${open}x^2${close}`);
    expect(tex(root.querySelector(".katex-display"))).toBe("x^2");
  });

  test.each([
    ["$$", "$$"],
    ["\\[", "\\]"],
  ])("renders %sblock%s math inside a list item", (open, close) => {
    const root = render(`- item\n\n  ${open}\n  y^2\n  ${close}\n- next`);
    const items = root.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(tex(items[0].querySelector(".katex-display"))).toBe("y^2");
  });

  test("renders mhchem formulas", () => {
    const root = render("$\\ce{H2O}$");
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector(".katex-error")).toBeNull();
  });

  test("shows invalid TeX as an error instead of throwing", () => {
    const root = render("broken $\\frac{$ math");
    const error = root.querySelector(".katex-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toBe("\\frac{");
    expect(error!.getAttribute("title")).toContain("ParseError");
    expect((error as HTMLElement).style.color).toBe("rgb(204, 0, 0)");
    // the rest of the paragraph still renders
    expect(root.querySelector("p")?.textContent).toMatch(/^broken .* math$/);
  });

  test("passes the katex options through", () => {
    const macros = { "\\RR": "\\mathbb{R}" };
    const withMacro = render("$\\RR$", { katex: { macros } });
    expect(withMacro.querySelector(".katex .mathbb")?.textContent).toBe("R");

    const without = render("$\\RR$");
    expect(without.querySelector(".katex .mathbb")).toBeNull();
  });

  test("katex options override the defaults", () => {
    const colored = render("$\\frac{$", { katex: { errorColor: "#00ff00" } });
    expect((colored.querySelector(".katex-error") as HTMLElement).style.color).toBe("rgb(0, 255, 0)");

    // with throwOnError the error is logged and the source shown as text
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = render("$\\frac{$", { katex: { throwOnError: true } });
    expect(thrown.querySelector(".katex-error")).toBeNull();
    expect(thrown.querySelector("p")?.textContent).toBe("\\frac{");
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  test("leaves dollar amounts in prose alone", () => {
    for (const src of ["It costs $5 and $6 today", "costs $5 and $6", "$5 or $10", "$5/$10", "pay $1,$2 or $3"]) {
      const root = render(src);
      expect(root.querySelector(".katex"), src).toBeNull();
      expect(root.querySelector("p")?.textContent).toBe(src);
    }
  });

  test("does not open or close math next to a space", () => {
    const root = render("a $ x $ b and $y $ c");
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe("a $ x $ b and $y $ c");
  });

  test("escaped dollars are literal", () => {
    const root = render("\\$x\\$ and \\$5");
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe("$x$ and $5");
  });

  test("dollars inside inline code are not math", () => {
    const root = render("`$x$`");
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("code")?.textContent).toBe("$x$");
  });

  test("renders parenthesized math with surrounding spaces and a following digit", () => {
    const root = render(String.raw`a \( x^2 \)2 and \(y + z\)`);
    const math = root.querySelectorAll(".katex");
    expect(math).toHaveLength(2);
    expect(tex(math[0])).toBe("x^2");
    expect(tex(math[1])).toBe("y + z");
    expect(root.querySelector(".katex-display")).toBeNull();
  });

  test("supports dollar and backslash markers in the same document", () => {
    const root = render(String.raw`$x$ and \(y\)

$$z$$

\[w\]`);
    expect(Array.from(root.querySelectorAll(".katex"), tex)).toEqual(["x", "y", "z", "w"]);
    expect(root.querySelectorAll(".katex-display")).toHaveLength(2);
  });

  test("escaped backslash markers are literal", () => {
    const root = render(String.raw`\\(x\\) and \\[y\\]`);
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe(String.raw`\(x\) and \[y\]`);
  });

  test.each([String.raw`\(x`, String.raw`\(x\]`, String.raw`\(\)`])(
    "leaves unmatched or empty inline markers to Markdown: %s",
    (src) => {
      const root = render(src);
      expect(root.querySelector(".katex")).toBeNull();
      expect(root.querySelector("p")?.textContent).toBe(src.replaceAll("\\", ""));
    },
  );

  test("skips escaped inline closing markers", () => {
    const root = render(String.raw`\(a \\) b\) after`);
    expect(tex(root.querySelector(".katex"))).toBe(String.raw`a \\) b`);
    expect(root.querySelector("p")?.lastChild?.textContent).toBe(" after");
  });

  test("backslash markers inside code are not math", () => {
    const root = render("`\\(x\\)`\n\n```tex\n\\[\nx^2\n\\]\n```");
    expect(root.querySelector(".katex")).toBeNull();
    expect(root.querySelector("p code")?.textContent).toBe(String.raw`\(x\)`);
    expect(root.querySelector("pre code")?.textContent).toBe("\\[\nx^2\n\\]\n");
  });

  test.each([
    ["$", "$"],
    ["\\(", "\\)"],
  ])("does not consume a %s closer beyond the active inline range", (open, close) => {
    const md = createRenderer({});
    for (let end = open.length + 1; end < open.length + 1 + close.length; end++) {
      const state = new md.inline.State(`${open}x${close}`, md, {}, []);
      state.posMax = end;
      md.inline.tokenize(state);
      expect(state.tokens.some((token) => token.type === "math_inline")).toBe(false);
      expect(state.pos).toBeLessThanOrEqual(end);
    }
  });
});
