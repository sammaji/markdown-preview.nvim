// Draws the diagram placeholders emitted by markdown/fence.ts. Each library
// is only downloaded once a document actually contains that kind of diagram.
import type { Chart } from "chart.js";

import { escapeHtml } from "./markdown/utils";
import type { PreviewOptions } from "./protocol";

export type Theme = "light" | "dark";

let charts: Chart[] = [];

export async function renderDiagrams(root: HTMLElement, options: PreviewOptions, theme: Theme) {
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

async function renderMermaid(root: HTMLElement, options: PreviewOptions, theme: Theme) {
  const nodes = [...root.querySelectorAll<HTMLElement>(".mermaid")];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    theme: theme === "dark" ? "dark" : "default",
    ...options.maid,
  });
  for (const node of nodes) {
    try {
      await mermaid.run({ nodes: [node] });
    } catch (error) {
      showError(node, "Mermaid", error);
    }
  }
}

async function renderCharts(root: HTMLElement) {
  const canvases = [...root.querySelectorAll<HTMLCanvasElement>(".chartjs canvas")];
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
  parse(code: string): { drawSVG(container: HTMLElement, options: Record<string, unknown>): void };
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
    for (const file of ["webfont.js", "snap.svg.min.js", "underscore-min.js", "sequence-diagram-min.js"]) {
      await loadScript(`/_static/sequence/${file}`);
    }
    return (window as unknown as { Diagram: SequenceDiagram }).Diagram;
  })();
  return sequenceLibrary;
}

async function renderSequenceDiagrams(root: HTMLElement, options: PreviewOptions) {
  const nodes = [...root.querySelectorAll<HTMLElement>("div.sequence-diagrams")];
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
