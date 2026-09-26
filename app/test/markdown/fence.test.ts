import { describe, expect, test } from "vitest";

import { render } from "../render";

const fence = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

describe("code fences", () => {
  test("highlights known languages with highlight.js", () => {
    const root = render(fence("js", "const answer = 42;"));
    const code = root.querySelector("pre.hljs > code")!;
    expect(code.querySelector("span.hljs-keyword")?.textContent).toBe("const");
    expect(code.querySelector("span.hljs-number")?.textContent).toBe("42");
    expect(code.textContent).toBe("const answer = 42;\n");
  });

  test("escapes highlighted code", () => {
    const root = render(fence("html", "<script>alert(1)</script>"));
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("pre.hljs span.hljs-tag")).not.toBeNull();
    expect(root.querySelector("pre.hljs code")?.textContent).toBe("<script>alert(1)</script>\n");
  });

  test("escapes code in unknown languages", () => {
    const root = render(fence("nosuchlang", '<script>alert(1)</script> & "x"'));
    expect(root.querySelector("script")).toBeNull();
    const code = root.querySelector("pre.hljs > code")!;
    expect(code.children).toHaveLength(0);
    expect(code.textContent).toBe('<script>alert(1)</script> & "x"\n');
  });

  test("escapes code without a language", () => {
    const root = render(fence("", "<img src=x onerror=alert(1)>"));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("<img src=x onerror=alert(1)>\n");
  });
});

describe("diagram fences", () => {
  test.each([
    ["dot", "dot"],
    ["graphviz", "dot"],
    ["flowchart", "flowchart"],
    ["sequence-diagrams", "sequence-diagrams"],
    ["mermaid", "mermaid"],
  ])("```%s becomes a div.%s placeholder holding the escaped source", (lang, className) => {
    const code = 'a -> b <script>alert("x")</script>';
    const root = render(fence(lang, `  ${code}  `));
    expect(root.children).toHaveLength(1);
    const div = root.firstElementChild!;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toBe(className);
    expect(div.children).toHaveLength(0);
    expect(div.textContent).toBe(code);
    expect(root.querySelector("pre")).toBeNull();
  });

  test.each(["graph TD", "graph LR;", "sequenceDiagram", "gantt", "erDiagram"])(
    "fences without a language starting with `%s` are mermaid",
    (first) => {
      const code = `${first}\n  A-->B`;
      const root = render(fence("", code));
      const div = root.querySelector("div.mermaid");
      expect(div).not.toBeNull();
      expect(div!.textContent).toBe(code);
      expect(root.querySelector("pre")).toBeNull();
    },
  );

  test.each(["graph XY", "flowchart LR", "not a diagram", "graph TD extra"])(
    "fences without a language starting with `%s` stay code",
    (first) => {
      const root = render(fence("", `${first}\n  A-->B`));
      expect(root.querySelector(".mermaid")).toBeNull();
      expect(root.querySelector("pre code")?.textContent).toBe(`${first}\n  A-->B\n`);
    },
  );

  test("```chart with valid JSON becomes a canvas carrying the config", () => {
    const config = {
      type: "bar",
      data: { labels: ["<Mon>", "Tue's", '"Wed"', "a & b"], datasets: [{ label: "n", data: [3, 5, 2, 8] }] },
      options: { scales: { y: { beginAtZero: true } } },
    };
    const root = render(fence("chart", JSON.stringify(config, null, 2)));
    const canvas = root.querySelector<HTMLCanvasElement>("div.chartjs > canvas");
    expect(canvas).not.toBeNull();
    expect(JSON.parse(canvas!.dataset.config!)).toEqual(config);
    expect(root.querySelector(".diagram-error")).toBeNull();
  });

  test("```chart with invalid JSON shows the parse error", () => {
    const root = render(fence("chart", '{ "type": <bar> }'));
    expect(root.querySelector(".chartjs")).toBeNull();
    const error = root.querySelector("pre.diagram-error");
    expect(error?.textContent).toMatch(/^SyntaxError: /);
    expect(error?.children).toHaveLength(0);
  });
});

describe("PlantUML", () => {
  // the example from https://plantuml.com/text-encoding
  const BOB = "Bob -> Alice : hello";
  const BOB_ENCODED = "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000";

  test("```plantuml becomes an image from the public PlantUML server", () => {
    const root = render(fence("plantuml", BOB));
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`https://www.plantuml.com/plantuml/img/${BOB_ENCODED}`);
    expect(img?.getAttribute("alt")).toBe("");
    expect(root.querySelector("pre")).toBeNull();
  });

  test("fence languages containing plantuml are PlantUML too", () => {
    const root = render(fence("{plantuml}", BOB));
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(new RegExp(`/img/${BOB_ENCODED}$`));
  });

  test("uses the uml server and image format options", () => {
    const uml = { server: "http://localhost:8080/plantuml", imageFormat: "svg" };
    const root = render(`${fence("plantuml", BOB)}\n\n@startuml\n${BOB}\n@enduml`, { uml });
    const srcs = [...root.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual([`${uml.server}/svg/${BOB_ENCODED}`, `${uml.server}/svg/${BOB_ENCODED}`]);
  });

  test("bare @startuml blocks become images of their contents", () => {
    const root = render(`before\n\n@startuml\n${BOB}\n@enduml\n\nafter`);
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`https://www.plantuml.com/plantuml/img/${BOB_ENCODED}`);
    expect(img?.getAttribute("alt")).toBe("uml diagram");
    expect([...root.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["before", "after"]);
    expect(root.textContent).not.toContain("@startuml");
    expect(root.textContent).not.toContain("@enduml");
  });

  test("text after @startuml is the image alt", () => {
    const root = render(`@startuml sequence of greetings\n${BOB}\n@enduml`);
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("sequence of greetings");
  });

  test("custom open and close markers", () => {
    const uml = { openMarker: "@startdiagram", closeMarker: "@enddiagram" };
    const root = render(`@startdiagram\n${BOB}\n@enddiagram\n\nafter`, { uml });
    expect(root.querySelector("img")?.getAttribute("src")).toMatch(new RegExp(`/img/${BOB_ENCODED}$`));
    expect(root.querySelector("p")?.textContent).toBe("after");
  });
});
