// Draws the diagram placeholders emitted by markdown/fence.ts. Each library
// is only downloaded once a document actually contains that kind of diagram.
import type { Chart } from "chart.js";
import type { MermaidConfig } from "mermaid";

import { escapeHtml } from "./markdown/utils";
import type { PreviewOptions } from "./protocol";

export type Theme = "light" | "dark";

let charts: Chart[] = [];

// Placeholders drawn as SVG. Their source text is much shorter than the
// drawing, so redrawing them on every refresh made the page shrink and grow
// again, causing a layout shift.
const SVG_DIAGRAMS = ".mermaid, div.dot, div.flowchart, div.sequence-diagrams";

// what each diagram was drawn from, read before its source is replaced
const drawnFrom = new WeakMap<Element, string>();

/** Everything besides its source that a drawing depends on. */
function drawingStyle(options: PreviewOptions, theme: Theme) {
  return JSON.stringify([
    theme,
    options.maid,
    options.flowchart_diagrams,
    options.sequence_diagrams,
    // the colors read from the page, which a custom theme can change
    options.maid?.theme ? null : mermaidTheme(theme),
  ]);
}

// the placeholder's tag, attributes and source, read before it is drawn
function drawingKey(node: HTMLElement, style: string) {
  return `${style}\n${node.outerHTML}`;
}

function markDrawn(node: HTMLElement) {
  node.dataset.drawn = "";
}

// edited diagrams, drawn out of sight, with the previous drawing shown in
// their place until they are done and their own style attribute
const outdated = new Map<
  HTMLElement,
  { old: HTMLElement; style: string | null }
>();

/** Shows an edited diagram again, returning its previous drawing. */
function unhide(node: HTMLElement) {
  const entry = outdated.get(node);
  if (!entry) return undefined;
  outdated.delete(node);
  if (entry.style === null) node.removeAttribute("style");
  else node.setAttribute("style", entry.style);
  return entry.old;
}

function kind(node: HTMLElement) {
  return node.classList[0];
}

// Takes a diagram of the previous page into the next one. A refresh can come
// while an edited diagram is still being drawn: its previous drawing and the
// drawing in progress both stop being outdated or hidden.
function take(node: HTMLElement) {
  delete node.dataset.outdated;
  unhide(node);
  for (const [edited, { old }] of outdated) {
    if (old === node) outdated.delete(edited);
  }
  return node;
}

/** The diagrams of `root` that are drawn, to pass to `reuseDiagrams`. */
export function drawnDiagrams(root: HTMLElement): HTMLElement[] {
  // a previous drawing whose replacement is already drawn is not needed
  const replaced = new Set(
    [...outdated]
      .filter(([edited]) => edited.dataset.drawn !== undefined)
      .map(([, { old }]) => old),
  );
  return [...root.querySelectorAll<HTMLElement>("[data-drawn]")].filter(
    (node) => !replaced.has(node),
  );
}

/**
 * Moves the `drawn` diagrams of the previous page in place of the
 * placeholders of `root` with the same source, theme and options, so the
 * page has its final height right away and they are not drawn again.
 */
export function reuseDiagrams(
  root: HTMLElement,
  drawn: HTMLElement[],
  options: PreviewOptions,
  theme: Theme,
) {
  const byKey = new Map<string, HTMLElement[]>();
  for (const node of drawn) {
    const key = drawnFrom.get(node);
    if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), node]);
  }
  const style = drawingStyle(options, theme);
  const unused = new Set(drawn);
  const edited: HTMLElement[] = [];
  const placeholders = [...root.querySelectorAll<HTMLElement>(SVG_DIAGRAMS)];
  for (const node of placeholders) {
    const key = drawingKey(node, style);
    // before it is hidden below, which changes its attributes
    drawnFrom.set(node, key);
    const old = byKey.get(key)?.shift();
    if (old) {
      node.replaceWith(take(old));
      unused.delete(old);
    } else {
      edited.push(node);
    }
  }

  // An edited diagram keeps showing its previous drawing, the one at the same
  // place among the diagrams of its kind, while it is drawn out of sight.
  // When diagrams of that kind were added or removed, which drawing was this
  // diagram's is unknown, so it gets none.
  for (const node of edited) {
    const now = placeholders.filter((p) => kind(p) === kind(node));
    const before = drawn.filter((d) => kind(d) === kind(node));
    if (now.length !== before.length) continue;
    const old = before[now.indexOf(node)];
    if (!unused.delete(old)) continue;
    node.before(take(old));
    old.dataset.outdated = "";
    outdated.set(node, { old, style: node.getAttribute("style") });
    node.style.cssText = `position: absolute; visibility: hidden; height: 0; overflow: hidden; width: ${old.offsetWidth}px`;
  }
}

/** Puts edited diagrams in place of their previous drawing. */
function swapOutdated(nodes: HTMLElement[]) {
  // a node that failed to draw is already replaced by its error
  for (const node of nodes) unhide(node)?.remove();
}

export async function renderDiagrams(
  root: HTMLElement,
  options: PreviewOptions,
  theme: Theme,
) {
  // charts hold resize observers on their canvas; release the previous ones
  charts.forEach((chart) => chart.destroy());
  charts = [];

  const undrawn = [
    ...root.querySelectorAll<HTMLElement>(
      `:is(${SVG_DIAGRAMS}):not([data-drawn])`,
    ),
  ];
  const style = drawingStyle(options, theme);
  for (const node of undrawn) {
    if (!drawnFrom.has(node)) drawnFrom.set(node, drawingKey(node, style));
  }

  try {
    await Promise.all([
      renderMermaid(root, options, theme),
      renderCharts(root),
      renderFlowcharts(root, options),
      renderSequenceDiagrams(root, options),
      renderDot(root),
    ]);
  } finally {
    swapOutdated(undrawn);
  }
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
let lastMermaidCount = 0;

export function forgetDiagrams() {
  lastGoodMermaid = [];
  lastMermaidCount = 0;
  outdated.clear();
}

async function renderMermaid(
  root: HTMLElement,
  options: PreviewOptions,
  theme: Theme,
) {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>(".mermaid:not([data-outdated])"),
  ];
  if (nodes.length === 0) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    // a theme chosen in the preview options keeps its own colors
    ...(options.maid?.theme ? {} : mermaidTheme(theme)),
    ...options.maid,
  });
  // drawings are paired with diagrams by place, which only holds while no
  // diagram was added or removed
  const good = nodes.length === lastMermaidCount ? [...lastGoodMermaid] : [];
  lastGoodMermaid = good;
  lastMermaidCount = nodes.length;
  for (const [index, node] of nodes.entries()) {
    // replaced by a newer refresh while this one was drawing
    if (!root.contains(node)) continue;
    if (node.dataset.drawn !== undefined) {
      good[index] =
        node.querySelector(":scope > svg")?.outerHTML ?? good[index];
      continue;
    }
    try {
      await mermaid.run({ nodes: [node] });
      good[index] = node.innerHTML;
      markDrawn(node);
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
  const nodes = [
    ...root.querySelectorAll<HTMLElement>("div.flowchart:not([data-drawn])"),
  ];
  if (nodes.length === 0) return;
  const flowchart = await import("flowchart.js");
  for (const node of nodes) {
    try {
      const chart = flowchart.parse(node.textContent ?? "");
      node.textContent = "";
      chart.drawSVG(node, options.flowchart_diagrams);
      markDrawn(node);
    } catch (error) {
      showError(node, "Flowchart", error);
    }
  }
}

async function renderDot(root: HTMLElement) {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>("div.dot:not([data-drawn])"),
  ];
  if (nodes.length === 0) return;
  const { instance } = await import("@viz-js/viz");
  const viz = await instance();
  for (const node of nodes) {
    try {
      node.replaceChildren(viz.renderSVGElement(node.textContent ?? ""));
      markDrawn(node);
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
    ...root.querySelectorAll<HTMLElement>(
      "div.sequence-diagrams:not([data-drawn])",
    ),
  ];
  if (nodes.length === 0) return;
  const Diagram = await loadSequenceLibrary();
  for (const node of nodes) {
    try {
      const diagram = Diagram.parse(node.textContent ?? "");
      node.textContent = "";
      diagram.drawSVG(node, { theme: "hand", ...options.sequence_diagrams });
      markDrawn(node);
    } catch (error) {
      showError(node, "Sequence diagram", error);
    }
  }
}
