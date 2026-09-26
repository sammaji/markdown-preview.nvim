import { beforeEach, describe, expect, test, vi } from "vitest";

import { forgetDiagrams, renderDiagrams } from "@/lib/diagrams";

// a mermaid that draws the source as the text of an SVG, and fails on "broken"
const run = vi.fn(async ({ nodes }: { nodes: HTMLElement[] }) => {
  for (const node of nodes) {
    const code = node.textContent ?? "";
    if (code.includes("broken")) throw new Error(`Parse error in ${code}`);
    node.innerHTML = `<svg viewBox="0 0 10 10"><text>${code}</text></svg>`;
  }
});
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), run } }));

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
