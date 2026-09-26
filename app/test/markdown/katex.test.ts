import { describe, expect, test, vi } from "vitest";

import { render } from "../render";

// the TeX source KaTeX keeps in its MathML annotation
function tex(element: Element | null) {
  return element?.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
}

describe("KaTeX", () => {
  test("renders $inline$ math inside the paragraph", () => {
    const root = render("Energy $E = mc^2$ here");
    const p = root.querySelector("p")!;
    const math = p.querySelector(".katex");
    expect(math).not.toBeNull();
    expect(p.querySelector(".katex-display")).toBeNull();
    expect(tex(math)).toBe("E = mc^2");
    expect(p.firstChild?.textContent).toBe("Energy ");
    expect(p.lastChild?.textContent).toBe(" here");
    expect(p.textContent).not.toContain("$");
  });

  test("renders $$block$$ math in display mode", () => {
    const root = render("$$\n\\int_0^1 x \\, dx\n$$\n\nafter");
    const display = root.querySelector(".katex-display");
    expect(display).not.toBeNull();
    expect(display!.querySelector('math[display="block"]')).not.toBeNull();
    expect(tex(display)).toBe("\\int_0^1 x \\, dx");
    expect(root.querySelector("p.source-line")?.textContent).toBe("after");
  });

  test("renders single-line $$block$$ math", () => {
    const root = render("$$x^2$$");
    expect(tex(root.querySelector(".katex-display"))).toBe("x^2");
  });

  test("renders $$block$$ math inside a list item", () => {
    const root = render("- item\n\n  $$\n  y^2\n  $$\n- next");
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
});
