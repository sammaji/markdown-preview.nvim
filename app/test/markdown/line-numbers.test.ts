// Sync scroll finds the element for the editor cursor line through
// data-source-line, so these values are 0-based source lines (scroll.ts
// looks up `cursor - 1`).
import { describe, expect, test } from "vitest";

import { render } from "../render";

const DOC = [
  "# Title", // 0
  "", // 1
  "First paragraph", // 2
  "continues here.", // 3
  "", // 4
  "- one", // 5
  "- two", // 6
  "  - nested", // 7
  "", // 8
  "```js", // 9
  "let x = 1;", // 10
  "```", // 11
  "", // 12
  "| a | b |", // 13
  "|---|---|", // 14
  "| 1 | 2 |", // 15
  "", // 16
  "> quoted", // 17
  "", // 18
  "## Second", // 19
  "", // 20
  "1. first", // 21
  "", // 22
  "   more of first", // 23
  "", // 24
  "$$", // 25
  "x", // 26
  "$$", // 27
  "", // 28
  "***", // 29
  "", // 30
  "last", // 31
].join("\n");

const line = (element: Element | null | undefined) => (element as HTMLElement | null)?.dataset.sourceLine;

describe("source line numbers", () => {
  const root = render(DOC);

  test("headings", () => {
    expect(line(root.querySelector("h1"))).toBe("0");
    expect(line(root.querySelector("h2"))).toBe("19");
  });

  test("paragraphs", () => {
    const paragraphs = [...root.querySelectorAll(":scope > p.source-line")];
    expect(paragraphs.map((p) => [line(p), p.textContent])).toEqual([
      ["2", "First paragraph\ncontinues here."],
      ["31", "last"],
    ]);
  });

  test("list items and their paragraphs", () => {
    const items = [...root.querySelectorAll("li")];
    expect(items.map((li) => line(li))).toEqual(["5", "6", "7", "21"]);
    const loose = root.querySelectorAll("ol > li > p");
    expect([...loose].map((p) => line(p))).toEqual(["21", "23"]);
  });

  test("tables", () => {
    expect(line(root.querySelector("table"))).toBe("13");
  });

  test("paragraphs in blockquotes", () => {
    expect(line(root.querySelector("blockquote > p"))).toBe("17");
  });

  test("tagged elements carry the source-line class", () => {
    for (const element of root.querySelectorAll("[data-source-line]")) {
      expect(element.classList.contains("source-line")).toBe(true);
    }
    expect(root.querySelectorAll(".source-line").length).toBe(root.querySelectorAll("[data-source-line]").length);
  });

  test("fences, math blocks and thematic breaks are not tagged", () => {
    // sync scroll interpolates between the tagged elements around them
    expect(root.querySelector("pre")?.closest("[data-source-line]")).toBeNull();
    expect(root.querySelector("pre [data-source-line]")).toBeNull();
    expect(root.querySelector(".katex-display")?.closest("[data-source-line]")).toBeNull();
    expect(root.querySelector("hr")?.hasAttribute("data-source-line")).toBe(false);
  });

  test("the lines are exactly the tagged ones", () => {
    const lines = [...root.querySelectorAll("[data-source-line]")].map((element) => Number(line(element)));
    expect([...new Set(lines)].sort((a, b) => a - b)).toEqual([0, 2, 5, 6, 7, 13, 17, 19, 21, 23, 31]);
  });
});
