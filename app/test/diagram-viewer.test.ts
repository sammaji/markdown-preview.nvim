import { afterEach, describe, expect, test } from "vitest";

import { openDiagramViewer, svgFile } from "@/lib/diagram-viewer";

function diagram() {
  const holder = document.createElement("div");
  holder.innerHTML =
    '<svg id="mermaid-1" viewBox="0 0 400 200" width="100%" style="max-width: 400px"><text>token-42</text></svg>';
  document.body.append(holder);
  return holder.querySelector("svg")!;
}

const viewer = () => document.querySelector<HTMLElement>(".diagram-viewer");
const scale = () => Number(viewer()!.dataset.scale);
const click = (action: string) => viewer()!.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click();
const key = (key: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("diagram viewer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("shows a copy of the diagram at full size", () => {
    const source = diagram();
    openDiagramViewer(source);
    const copy = viewer()!.querySelector("svg:not(button svg)")!;
    expect(copy).not.toBe(source);
    expect(copy.textContent).toBe("token-42");
    expect(copy.getAttribute("width")).toBe("400");
    expect(copy.getAttribute("height")).toBe("200");
    // the page's diagram is untouched, and its id stays unique
    expect(source.getAttribute("width")).toBe("100%");
    expect(copy.id).toBe("");
    expect(document.querySelectorAll("#mermaid-1")).toHaveLength(1);
  });

  test("zooms with the buttons and the keyboard", () => {
    openDiagramViewer(diagram());
    const start = scale();
    click("zoomIn");
    expect(scale()).toBeCloseTo(start * 1.25);
    key("+");
    expect(scale()).toBeCloseTo(start * 1.25 * 1.25);
    click("zoomOut");
    key("-");
    expect(scale()).toBeCloseTo(start);
    click("zoomIn");
    key("0");
    expect(scale()).toBeCloseTo(start);
  });

  test("zooms with the wheel", () => {
    openDiagramViewer(diagram());
    const start = scale();
    viewer()!.querySelector(".diagram-viewer-stage")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, cancelable: true }));
    expect(scale()).toBeCloseTo(start * Math.E);
  });

  test("pans by dragging", () => {
    openDiagramViewer(diagram());
    const stage = viewer()!.querySelector(".diagram-viewer-stage")!;
    const copy = stage.querySelector("svg")!;
    const before = copy.style.transform;
    const pointer = (type: string, x: number, y: number) =>
      stage.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }), { pointerId: 1 }));
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 60, 30);
    pointer("pointerup", 60, 30);
    const moved = copy.style.transform;
    expect(moved).not.toBe(before);
    const [bx, by] = before.match(/-?[\d.]+px/g)!.map(parseFloat);
    const [mx, my] = moved.match(/-?[\d.]+px/g)!.map(parseFloat);
    expect([mx - bx, my - by]).toEqual([50, 20]);
    // no button held: no panning
    pointer("pointermove", 500, 500);
    expect(copy.style.transform).toBe(moved);
  });

  test("closes with Esc and the close button", () => {
    openDiagramViewer(diagram());
    key("Escape");
    expect(viewer()).toBeNull();
    openDiagramViewer(diagram());
    click("close");
    expect(viewer()).toBeNull();
    // closed viewers don't listen to keys any more
    key("+");
  });

  test("only one viewer is open at a time", () => {
    openDiagramViewer(diagram());
    openDiagramViewer(diagram());
    expect(document.querySelectorAll(".diagram-viewer")).toHaveLength(1);
  });

  test("exports a standalone SVG file", () => {
    const file = svgFile(diagram());
    expect(file).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
    const svg = new DOMParser().parseFromString(file, "image/svg+xml").documentElement;
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("width")).toBe("400");
    expect(svg.getAttribute("height")).toBe("200");
    expect(svg.textContent).toBe("token-42");
    expect(svg.getAttribute("style") ?? "").not.toContain("max-width");
  });
});
