// Draws the diagram placeholders emitted by markdown/fence.ts. Each library
// is only downloaded once a document actually contains that kind of diagram.
import type { Chart } from "chart.js";
import type { MermaidConfig } from "mermaid";

import { escapeHtml } from "./markdown/utils";
import type { PreviewOptions } from "./protocol";

export type Theme = "light" | "dark";

let charts: Chart[] = [];

export async function renderDiagrams(
  root: HTMLElement,
  options: PreviewOptions,
  theme: Theme,
) {
  // charts hold resize observers on their canvas; release the previous ones
  charts.forEach((chart) => chart.destroy());
  charts = [];

  await Promise.all([
    renderMermaid(root, options, theme),
    renderCharts(root),
    renderFlowcharts(root, options),
    renderSequenceDiagrams(root, options),
    renderDot(root),
  ]);
}

function showError(element: Element, kind: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  element.outerHTML = `<pre class="diagram-error">${escapeHtml(`${kind}: ${message}`)}</pre>`;
}

/** Values of the page's CSS color variables as hex, which mermaid needs. */
export function themeColors<Name extends string>(
  names: readonly Name[],
): Partial<Record<Name, string>> {
  const context = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  if (!context) return {};
  const style = getComputedStyle(document.documentElement);
  const colors: Partial<Record<Name, string>> = {};
  for (const name of names) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (!value) continue;
    // the canvas converts any CSS color, oklch included, to sRGB
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    colors[name] =
      `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }
  return colors;
}

/** Mermaid's base theme drawn with the page's (shadcn) colors. */
function mermaidTheme(theme: Theme): MermaidConfig {
  const c = themeColors([
    "card",
    "foreground",
    "secondary",
    "muted",
    "muted-foreground",
    "primary-foreground",
    "accent",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
  ] as const);
  // mermaid's own dark or default theme, when the colors are unknown
  if (!c.card || !c.foreground) {
    return { theme: theme === "dark" ? "dark" : "default" };
  }
  const text = c.foreground;
  const border = c["muted-foreground"];
  const line = c["muted-foreground"];
  const node = c.secondary;
  return {
    theme: "base",
    // rounded like the page's cards
    themeCSS: ".node rect, rect.task { rx: 6px; ry: 6px; }",
    themeVariables: {
      darkMode: theme === "dark",
      fontFamily: getComputedStyle(document.body).fontFamily,
      background: c.card,
      textColor: text,
      lineColor: line,
      // mermaid's is light grey, a glow on dark backgrounds
      dropShadow: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.1))",
      // flowcharts, state and class diagrams
      primaryColor: node,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: c.muted,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: c.card,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      mainBkg: node,
      nodeBorder: border,
      nodeTextColor: text,
      clusterBkg: c.muted,
      clusterBorder: border,
      titleColor: text,
      edgeLabelBackground: c.card,
      // sequence diagrams
      actorBkg: node,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: line,
      signalColor: text,
      signalTextColor: text,
      labelBoxBkgColor: node,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: c.accent,
      noteBorderColor: border,
      noteTextColor: text,
      activationBkgColor: c.muted,
      activationBorderColor: border,
      sequenceNumberColor: c["primary-foreground"],
      // gantt charts
      sectionBkgColor: c.muted,
      altSectionBkgColor: c.card,
      sectionBkgColor2: c.muted,
      gridColor: c.muted,
      taskBkgColor: c["chart-2"],
      taskBorderColor: border,
      taskTextColor: text,
      taskTextLightColor: text,
      taskTextOutsideColor: text,
      taskTextDarkColor: text,
      activeTaskBkgColor: c["chart-1"],
      activeTaskBorderColor: border,
      doneTaskBkgColor: node,
      doneTaskBorderColor: border,
      critBkgColor: c["chart-5"],
      critBorderColor: border,
      todayLineColor: c["chart-1"],
      // pie charts
      pie1: c["chart-1"],
      pie2: c["chart-2"],
      pie3: c["chart-3"],
      pie4: c["chart-4"],
      pie5: c["chart-5"],
      pieStrokeColor: c.card,
      pieOuterStrokeColor: border,
      pieTitleTextColor: text,
      pieSectionTextColor: text,
      pieLegendTextColor: text,
    },
  };
}

let lastGoodMermaid: string[] = [];

export function forgetDiagrams() {
  lastGoodMermaid = [];
}

async function renderMermaid(
  root: HTMLElement,
  options: PreviewOptions,
  theme: Theme,
) {
  const nodes = [...root.querySelectorAll<HTMLElement>(".mermaid")];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    // a theme chosen in the preview options keeps its own colors
    ...(options.maid?.theme ? {} : mermaidTheme(theme)),
    ...options.maid,
  });
  const good = lastGoodMermaid.slice(0, nodes.length);
  lastGoodMermaid = good;
  for (const [index, node] of nodes.entries()) {
    try {
      await mermaid.run({ nodes: [node] });
      good[index] = node.innerHTML;
      addViewerButton(node);
    } catch (error) {
      const svg = good[index];
      if (svg === undefined) {
        showError(node, "Mermaid", error);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      node.innerHTML = svg;
      node.classList.add("diagram-stale");
      node.insertAdjacentHTML(
        "afterbegin",
        `<pre class="diagram-error">${escapeHtml(`Mermaid: ${message}`)}\n(showing the last diagram that rendered)</pre>`,
      );
      addViewerButton(node);
    }
  }
}

function addViewerButton(node: HTMLElement) {
  const svg = node.querySelector<SVGSVGElement>(":scope > svg");
  if (!svg) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "diagram-open";
  button.title = "Open diagram";
  button.setAttribute("aria-label", "Open diagram");
  button.contentEditable = "false";
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 .53-.22h3a.75.75 0 0 1 0 1.5H5.56l2.47 2.47a.75.75 0 0 1-1.06 1.06L4.5 6.06v1.19a.75.75 0 0 1-1.5 0v-3a.75.75 0 0 1 .22-.53Zm8.56 8.56a.75.75 0 0 1-.53.22h-3a.75.75 0 0 1 0-1.5h1.19L7.47 8.53a.75.75 0 0 1 1.06-1.06l2.47 2.47V8.75a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-.22.53Z"></path></svg>';
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const { openDiagramViewer } = await import("./diagram-viewer");
    openDiagramViewer(svg);
  });
  node.append(button);
}

async function renderCharts(root: HTMLElement) {
  const canvases = [
    ...root.querySelectorAll<HTMLCanvasElement>(".chartjs canvas"),
  ];
  if (canvases.length === 0) return;
  const { default: Chart } = await import("chart.js/auto");
  for (const canvas of canvases) {
    try {
      charts.push(new Chart(canvas, JSON.parse(canvas.dataset.config ?? "{}")));
    } catch (error) {
      showError(canvas.parentElement ?? canvas, "Chart.js", error);
    }
  }
}

async function renderFlowcharts(root: HTMLElement, options: PreviewOptions) {
  const nodes = [...root.querySelectorAll<HTMLElement>("div.flowchart")];
  if (nodes.length === 0) return;
  const flowchart = await import("flowchart.js");
  for (const node of nodes) {
    try {
      const chart = flowchart.parse(node.textContent ?? "");
      node.textContent = "";
      chart.drawSVG(node, options.flowchart_diagrams);
    } catch (error) {
      showError(node, "Flowchart", error);
    }
  }
}

async function renderDot(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>("div.dot")];
  if (nodes.length === 0) return;
  const { instance } = await import("@viz-js/viz");
  const viz = await instance();
  for (const node of nodes) {
    try {
      node.replaceChildren(viz.renderSVGElement(node.textContent ?? ""));
    } catch (error) {
      showError(node, "Graphviz", error);
    }
  }
}

// js-sequence-diagrams is unmaintained and not published in a bundler
// friendly form, so its prebuilt scripts are loaded from /_static/sequence.
interface SequenceDiagram {
  parse(code: string): {
    drawSVG(container: HTMLElement, options: Record<string, unknown>): void;
  };
}

let sequenceLibrary: Promise<SequenceDiagram> | undefined;

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function loadSequenceLibrary(): Promise<SequenceDiagram> {
  sequenceLibrary ??= (async () => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/_static/sequence/sequence-diagram-min.css";
    document.head.appendChild(css);
    for (const file of [
      "webfont.js",
      "snap.svg.min.js",
      "underscore-min.js",
      "sequence-diagram-min.js",
    ]) {
      await loadScript(`/_static/sequence/${file}`);
    }
    return (window as unknown as { Diagram: SequenceDiagram }).Diagram;
  })();
  return sequenceLibrary;
}

async function renderSequenceDiagrams(
  root: HTMLElement,
  options: PreviewOptions,
) {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>("div.sequence-diagrams"),
  ];
  if (nodes.length === 0) return;
  const Diagram = await loadSequenceLibrary();
  for (const node of nodes) {
    try {
      const diagram = Diagram.parse(node.textContent ?? "");
      node.textContent = "";
      diagram.drawSVG(node, { theme: "hand", ...options.sequence_diagrams });
    } catch (error) {
      showError(node, "Sequence diagram", error);
    }
  }
}
