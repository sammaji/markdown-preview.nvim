import { describe, expect, test } from "vitest";

import { render } from "../render";

describe("GitHub alerts", () => {
  test.each([
    ["NOTE", "note", "Note"],
    ["TIP", "tip", "Tip"],
    ["IMPORTANT", "important", "Important"],
    ["WARNING", "warning", "Warning"],
    ["CAUTION", "caution", "Caution"],
  ])("[!%s] becomes a %s callout", (marker, kind, title) => {
    const root = render(`> [!${marker}]\n> Read **this** first.`);
    const alert = root.querySelector(`div.markdown-alert.markdown-alert-${kind}`)!;
    expect(alert).not.toBeNull();
    expect(root.querySelector("blockquote")).toBeNull();
    const heading = alert.querySelector(":scope > p.markdown-alert-title")!;
    expect(heading.textContent).toBe(title);
    expect(heading.querySelector("svg.octicon > path")?.getAttribute("d")).toMatch(/^M/);
    const body = alert.querySelector(":scope > p:not(.markdown-alert-title)")!;
    expect(body.textContent).toBe("Read this first.");
    expect(body.querySelector("strong")?.textContent).toBe("this");
    expect(alert.textContent).not.toContain("[!");
  });

  test("the marker is case insensitive", () => {
    expect(render("> [!warning]\n> text").querySelector(".markdown-alert-warning")).not.toBeNull();
  });

  test("keeps every block of the quote", () => {
    const root = render("> [!TIP]\n>\n> First\n>\n> - a\n> - b");
    const alert = root.querySelector(".markdown-alert-tip")!;
    expect(alert.querySelector(":scope > p:not(.markdown-alert-title)")?.textContent).toBe("First");
    expect([...alert.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["a", "b"]);
  });

  test("keeps the source lines for sync scroll", () => {
    const root = render("Intro\n\n> [!NOTE]\n> Line three\n\n> [!TIP]\n>\n> Line seven");
    const note = root.querySelector<HTMLElement>(".markdown-alert-note")!;
    expect(note.dataset.sourceLine).toBe("2");
    expect(note.querySelector<HTMLElement>("p:not(.markdown-alert-title)")?.dataset.sourceLine).toBe("3");
    const tip = root.querySelector<HTMLElement>(".markdown-alert-tip")!;
    expect(tip.dataset.sourceLine).toBe("5");
    expect(tip.querySelector<HTMLElement>("p:not(.markdown-alert-title)")?.dataset.sourceLine).toBe("7");
    // every line number is used once, or sync scroll finds the wrong element
    const lines = [...root.querySelectorAll<HTMLElement>("[data-source-line]")].map((e) => e.dataset.sourceLine);
    expect(new Set(lines).size).toBe(lines.length);
  });

  test.each([
    ["an unknown type", "> [!DANGER]\n> text"],
    ["text after the marker", "> [!NOTE] inline\n> text"],
    ["a marker that isn't first", "> text\n> [!NOTE]"],
  ])("%s stays a blockquote", (_, src) => {
    const root = render(src);
    expect(root.querySelector(".markdown-alert")).toBeNull();
    expect(root.querySelector("blockquote")).not.toBeNull();
  });

  test("nested quotes close in the right place", () => {
    const root = render("> [!NOTE]\n> outer\n> > inner\n\nafter");
    const alert = root.querySelector(".markdown-alert-note")!;
    expect(alert.querySelector("blockquote")?.textContent?.trim()).toBe("inner");
    expect(root.querySelector(":scope > p")?.textContent).toBe("after");
  });

  test("plain blockquotes are unchanged", () => {
    const root = render("> just a quote");
    expect(root.querySelector("blockquote > p")?.textContent).toBe("just a quote");
  });
});
