import { beforeEach, describe, expect, test, vi } from "vitest";

import { drawPage } from "@/components/preview";
import { forgetDiagrams, renderDiagrams, type Theme } from "@/lib/diagrams";
import type { PreviewOptions } from "@/lib/protocol";

// a mermaid that draws the source as the text of an SVG, and fails on "broken"
const run = vi.fn(async ({ nodes }: { nodes: HTMLElement[] }) => {
  for (const node of nodes) {
    const code = node.textContent ?? "";
    if (code.includes("broken")) throw new Error(`Parse error in ${code}`);
    node.innerHTML = `<svg viewBox="0 0 10 10"><text>${code}</text></svg>`;
  }
});
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), run } }));

// a Graphviz that draws the source as the text of an SVG
const renderSVGElement = vi.fn((code: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.textContent = code;
  return svg;
});
vi.mock("@viz-js/viz", () => ({ instance: async () => ({ renderSVGElement }) }));

function page(...sources: string[]) {
  const root = document.createElement("section");
  root.innerHTML = sources.map((s) => `<div class="mermaid">${s}</div>`).join("");
  return root;
}

const render = (root: HTMLElement) => renderDiagrams(root, {}, "light");

describe("mermaid", () => {
  beforeEach(() => forgetDiagrams());

  test("a broken diagram shows the error if it never rendered", async () => {
    const root = page("graph broken");
    await render(root);
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("pre.diagram-error")?.textContent).toBe("Mermaid: Parse error in graph broken");
  });

  test("a diagram broken by an edit keeps its last render", async () => {
    await render(page("graph good-one", "graph good-two"));

    const root = page("graph good-one", "graph broken two");
    await render(root);
    const [first, second] = root.querySelectorAll<HTMLElement>(".mermaid");
    expect(first.querySelector("svg text")?.textContent).toBe("graph good-one");
    expect(first.classList.contains("diagram-stale")).toBe(false);
    // the previous drawing of the second diagram, with the error on top
    expect(second.querySelector("svg text")?.textContent).toBe("graph good-two");
    expect(second.classList.contains("diagram-stale")).toBe(true);
    expect(second.querySelector("pre.diagram-error")?.textContent).toContain("Parse error in graph broken two");
    expect(second.querySelector("pre.diagram-error")?.textContent).toContain("last diagram that rendered");

    // fixed again: the new drawing, no error
    const fixed = page("graph good-one", "graph good-three");
    await render(fixed);
    const third = fixed.querySelectorAll(".mermaid")[1];
    expect(third.querySelector("svg text")?.textContent).toBe("graph good-three");
    expect(third.querySelector(".diagram-error")).toBeNull();
    expect(third.classList.contains("diagram-stale")).toBe(false);
  });

  test("the last render survives several broken edits", async () => {
    await render(page("graph good"));
    await render(page("graph broken 1"));
    const root = page("graph broken 2");
    await render(root);
    expect(root.querySelector("svg text")?.textContent).toBe("graph good");
  });

  test("forgetDiagrams drops the renders of the previous document", async () => {
    await render(page("graph good"));
    forgetDiagrams();
    const root = page("graph broken");
    await render(root);
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("pre.diagram-error")).not.toBeNull();
  });

  test("removed diagrams are forgotten", async () => {
    await render(page("graph a", "graph b"));
    await render(page("graph a"));
    const root = page("graph a", "graph broken");
    await render(root);
    // the second diagram is new, so there is no drawing to fall back to
    expect([...root.querySelectorAll("svg text")].map((t) => t.textContent)).toEqual(["graph a"]);
    expect(root.querySelector("pre.diagram-error")?.textContent).toContain("graph broken");
  });

  test("rendered diagrams get a button that opens the viewer", async () => {
    const root = page("graph good");
    document.body.append(root);
    await render(root);
    const button = root.querySelector<HTMLButtonElement>(".mermaid > button.diagram-open")!;
    expect(button).not.toBeNull();
    button.click();
    await vi.waitFor(() => expect(document.querySelector(".diagram-viewer svg text")?.textContent).toBe("graph good"));
    document.querySelector(".diagram-viewer")?.remove();
    root.remove();
  });
});

// #40: every refresh put each diagram back to its (much shorter) source text
// until it was drawn again, so the page scrolled up and back down
describe("refreshing the page", () => {
  const mermaid = (...sources: string[]) =>
    sources.map((s) => `<div class="mermaid">${s}</div>`).join("");
  const draw = (body: HTMLElement, html: string, theme: Theme = "light", options: PreviewOptions = {}) =>
    drawPage(body, html, options, theme, () => {});
  const svgs = (body: HTMLElement) => [...body.querySelectorAll(".mermaid > svg")];

  let body: HTMLElement;
  beforeEach(() => {
    body = document.createElement("section");
    run.mockClear();
    renderSVGElement.mockClear();
  });

  test("keeps unchanged diagrams instead of drawing them again", async () => {
    await draw(body, mermaid("graph a") + "<p>one</p>");
    const [svg] = svgs(body);

    await draw(body, mermaid("graph a") + "<p>two</p>");
    expect(run).toHaveBeenCalledTimes(1);
    expect(svgs(body)[0]).toBe(svg);
    expect(body.querySelectorAll("button.diagram-open")).toHaveLength(1);
  });

  test("the first scroll already sees the drawn diagram", async () => {
    const html = mermaid("graph a") + '<p data-source-line="5">below</p>';
    await draw(body, html);

    const seen: boolean[] = [];
    await drawPage(body, html.replace("below", "below, edited"), {}, "light", () =>
      seen.push(body.querySelector(".mermaid > svg") !== null),
    );
    // before the fix the first scroll ran against the source text placeholder
    expect(seen).toEqual([true, true]);
  });

  test("draws edited diagrams again", async () => {
    await draw(body, mermaid("graph a", "graph b"));
    const [first] = svgs(body);

    await draw(body, mermaid("graph a", "graph b2"));
    expect(run).toHaveBeenCalledTimes(3);
    expect(svgs(body)[0]).toBe(first);
    expect(svgs(body)[1].textContent).toBe("graph b2");
  });

  test("draws diagrams again in a new theme or with new options", async () => {
    await draw(body, mermaid("graph a"));
    await draw(body, mermaid("graph a"), "dark");
    await draw(body, mermaid("graph a"), "dark", { maid: { theme: "forest" } });
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("keeps each copy of a repeated diagram", async () => {
    await draw(body, mermaid("graph a", "graph a"));
    const before = svgs(body);

    await draw(body, mermaid("graph a", "graph a"));
    expect(run).toHaveBeenCalledTimes(2);
    expect(svgs(body)).toEqual(before);
    expect(svgs(body)[0]).not.toBe(svgs(body)[1]);
  });

  test("does not keep a broken diagram", async () => {
    await draw(body, mermaid("graph good"));
    await draw(body, mermaid("graph broken"));
    await draw(body, mermaid("graph broken"));
    expect(run).toHaveBeenCalledTimes(3);
    // still the last drawing that worked
    expect(body.querySelector(".mermaid.diagram-stale svg text")?.textContent).toBe("graph good");
  });

  test("a kept diagram is still the fallback when it breaks", async () => {
    await draw(body, mermaid("graph a", "graph b"));
    await draw(body, mermaid("graph a", "graph b"));
    await draw(body, mermaid("graph a", "graph broken"));
    const second = body.querySelectorAll(".mermaid")[1];
    expect(second.querySelector("svg text")?.textContent).toBe("graph b");
    expect(second.classList.contains("diagram-stale")).toBe(true);
  });

  test("keeps graphviz diagrams too", async () => {
    const dot = '<div class="dot">digraph { a -> b }</div>';
    await draw(body, dot);
    const svg = body.querySelector("div.dot > svg");

    await draw(body, dot);
    expect(renderSVGElement).toHaveBeenCalledTimes(1);
    expect(body.querySelector("div.dot > svg")).toBe(svg);
  });
});

// an edited diagram used to fall back to its source text until it was drawn
// again, so the page shrank and grew back
describe("editing a diagram", () => {
  const mermaid = (...sources: string[]) =>
    sources.map((s) => `<div class="mermaid">${s}</div>`).join("");
  // the drawings a reader sees: not hidden while they are being drawn
  const visible = (body: HTMLElement) =>
    [...body.querySelectorAll<HTMLElement>(".mermaid")]
      .filter((node) => node.style.visibility !== "hidden")
      // null for a diagram showing its source text
      .map((node) => node.querySelector("svg text")?.textContent ?? null);
  const settled = (body: HTMLElement) => {
    expect(body.querySelector("[data-outdated]")).toBeNull();
    expect(body.querySelector(".mermaid[style]")).toBeNull();
  };

  let body: HTMLElement;
  beforeEach(() => {
    forgetDiagrams();
    body = document.createElement("section");
    run.mockClear();
  });

  test("shows the previous drawing until the new one is drawn", async () => {
    await drawPage(body, mermaid("graph a"), {}, "light", () => {});

    const seen: (string | null)[][] = [];
    await drawPage(body, mermaid("graph b"), {}, "light", () => seen.push(visible(body)));
    expect(seen).toEqual([["graph a"], ["graph b"]]);
    expect(body.querySelectorAll(".mermaid")).toHaveLength(1);
    settled(body);
  });

  test("keeps the other diagrams where they are", async () => {
    await drawPage(body, mermaid("graph a", "graph b", "graph c"), {}, "light", () => {});

    const seen: (string | null)[][] = [];
    await drawPage(body, mermaid("graph a", "graph b2", "graph c"), {}, "light", () =>
      seen.push(visible(body)),
    );
    expect(seen).toEqual([
      ["graph a", "graph b", "graph c"],
      ["graph a", "graph b2", "graph c"],
    ]);
    settled(body);
  });

  test("a diagram broken by the edit still shows its last good drawing", async () => {
    await drawPage(body, mermaid("graph a"), {}, "light", () => {});
    await drawPage(body, mermaid("graph broken"), {}, "light", () => {});
    expect(body.querySelectorAll(".mermaid")).toHaveLength(1);
    expect(body.querySelector(".mermaid.diagram-stale svg text")?.textContent).toBe("graph a");
    settled(body);
  });

  test("a new theme shows the previous drawings until they are redrawn", async () => {
    await drawPage(body, mermaid("graph a"), {}, "light", () => {});
    const seen: (string | null)[][] = [];
    await drawPage(body, mermaid("graph a"), {}, "dark", () => seen.push(visible(body)));
    expect(seen).toEqual([["graph a"], ["graph a"]]);
    expect(run).toHaveBeenCalledTimes(2);
    settled(body);
  });

  test("a refresh while an edit is still being drawn", async () => {
    await drawPage(body, mermaid("graph a"), {}, "light", () => {});

    // hold the drawing of the first edit until the second one has started
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    run.mockImplementationOnce(async ({ nodes }) => {
      await gate;
      for (const node of nodes) node.innerHTML = `<svg><text>${node.textContent}</text></svg>`;
    });
    const first = drawPage(body, mermaid("graph b"), {}, "light", () => {});
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    const seen: (string | null)[][] = [];
    const second = drawPage(body, mermaid("graph c"), {}, "light", () => seen.push(visible(body)));
    release();
    await Promise.all([first, second]);

    // the second refresh still started from the drawing of graph a
    expect(seen).toEqual([["graph a"], ["graph c"]]);
    expect(body.querySelectorAll(".mermaid")).toHaveLength(1);
    settled(body);
  });
});

describe("review fixes", () => {
  const mermaid = (...sources: string[]) =>
    sources.map((s) => `<div class="mermaid">${s}</div>`).join("");
  const draw = (body: HTMLElement, html: string) => drawPage(body, html, {}, "light", () => {});

  let body: HTMLElement;
  beforeEach(() => {
    forgetDiagrams();
    body = document.createElement("section");
    run.mockClear();
  });

  test("a refresh stops the drawing of the page it replaced", async () => {
    await draw(body, mermaid("graph a", "graph b"));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    run.mockImplementationOnce(async ({ nodes }) => {
      await gate;
      for (const node of nodes) node.innerHTML = `<svg><text>${node.textContent}</text></svg>`;
    });
    const first = draw(body, mermaid("graph a2", "graph b2"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    const second = draw(body, mermaid("graph a3", "graph b3"));
    release();
    await Promise.all([first, second]);

    // graph b2 was replaced before its turn, so it is not drawn
    expect(run.mock.calls.map(([{ nodes }]) => nodes[0].textContent)).not.toContain("graph b2");
    expect([...body.querySelectorAll(".mermaid svg text")].map((t) => t.textContent)).toEqual([
      "graph a3",
      "graph b3",
    ]);
  });

  test("diagrams are drawn again when the page's colors change", async () => {
    // a canvas that turns each CSS color into a different red value
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () =>
        ({
          fillStyle: "",
          clearRect() {},
          fillRect() {},
          getImageData(this: { fillStyle: string }) {
            const value = this.fillStyle;
            return { data: [value.length * 7 + value.charCodeAt(value.length - 1), 0, 0, 255] };
          },
        }) as unknown as CanvasRenderingContext2D,
    );
    const root = document.documentElement;
    try {
      root.style.setProperty("--card", "#fff");
      root.style.setProperty("--foreground", "#000");
      await draw(body, mermaid("graph a") + "<p>one</p>");
      await draw(body, mermaid("graph a") + "<p>two</p>");
      expect(run).toHaveBeenCalledTimes(1);

      // e.g. a custom theme's media query
      root.style.setProperty("--foreground", "#123");
      await draw(body, mermaid("graph a") + "<p>three</p>");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      root.style.removeProperty("--card");
      root.style.removeProperty("--foreground");
      getContext.mockRestore();
    }
  });

  test("a broken diagram does not fall back to another diagram's drawing", async () => {
    await draw(body, mermaid("graph a", "graph b", "graph c"));
    // graph x added at the top and graph b broken at once: graph b is now
    // third, where graph c was
    const seen: string[][] = [];
    await drawPage(body, mermaid("graph x", "graph a", "graph broken b", "graph c"), {}, "light", () =>
      seen.push([...body.querySelectorAll(".mermaid svg text")].map((t) => t.textContent ?? "")),
    );
    // graph c is shown once, in its own place
    expect(seen[0]).toEqual(["graph a", "graph c"]);
    const texts = [...body.querySelectorAll(".mermaid svg text")].map((t) => t.textContent);
    expect(texts).toEqual(["graph x", "graph a", "graph c"]);
    expect(body.querySelector("pre.diagram-error")?.textContent).toContain("graph broken b");
  });

  test("a new diagram does not stand in another diagram's previous drawing", async () => {
    await draw(body, mermaid("graph a", "graph b", "graph c"));
    const seen: string[][] = [];
    await drawPage(body, mermaid("graph a", "graph x", "graph b2", "graph c"), {}, "light", () =>
      seen.push(
        [...body.querySelectorAll<HTMLElement>(".mermaid")]
          .filter((node) => node.style.visibility !== "hidden")
          .map((node) => node.querySelector("svg text")?.textContent ?? "source"),
      ),
    );
    // graph x is new: graph b's drawing in its place would be a wrong picture
    expect(seen[0]).toEqual(["graph a", "source", "source", "graph c"]);
    expect(seen[1]).toEqual(["graph a", "graph x", "graph b2", "graph c"]);
  });

  test("editing only the attributes of a raw HTML diagram draws it again", async () => {
    await draw(body, '<div class="mermaid" style="color: red">graph a</div>');
    await draw(body, '<div class="mermaid" style="color: blue">graph a</div>');
    expect(run).toHaveBeenCalledTimes(2);
    expect(body.querySelector<HTMLElement>(".mermaid")?.style.color).toBe("blue");
  });

  test("a raw HTML diagram keeps its own style after it is edited", async () => {
    await draw(body, '<div class="mermaid" style="color: red">graph a</div>');
    const seen: string[] = [];
    await drawPage(body, '<div class="mermaid" style="color: red">graph b</div>', {}, "light", () =>
      seen.push(body.querySelector(".mermaid svg text")?.textContent ?? ""),
    );
    expect(seen).toEqual(["graph a", "graph b"]);
    const node = body.querySelector<HTMLElement>(".mermaid")!;
    expect(node.getAttribute("style")).toBe("color: red");
    expect(body.querySelectorAll(".mermaid")).toHaveLength(1);
  });
});
