const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const ZOOM_STEP = 1.25;

const ICONS = {
  zoomIn:
    "M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z",
  zoomOut:
    "M2 7.75A.75.75 0 0 1 2.75 7h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.75Z",
  fit: "M1.75 10a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5a.75.75 0 0 1 .75-.75Zm12.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 13.25 15h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 .75-.75ZM2.75 2.5a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0v-2.5C1 1.784 1.784 1 2.75 1h2.5a.75.75 0 0 1 0 1.5ZM10 1.75a.75.75 0 0 1 .75-.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1-.75-.75Z",
  download:
    "M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z",
  close:
    "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
};

function button(name: keyof typeof ICONS, label: string) {
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.action = name;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${ICONS[name]}"></path></svg>`;
  return element;
}

/** Natural size of a rendered diagram, from its viewBox. */
function naturalSize(svg: SVGSVGElement) {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0)
    return { width: box.width, height: box.height };
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 300, height: rect.height || 150 };
}

/** The diagram as a standalone SVG file. */
export function svgFile(svg: SVGSVGElement): string {
  // XMLSerializer adds the SVG namespace itself
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = naturalSize(svg);
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.style.removeProperty("max-width");
  if (!copy.getAttribute("style")) copy.removeAttribute("style");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}\n`;
}

/**
 * A copy of the diagram with an id of its own. Mermaid scopes the diagram's
 * <style> and its arrowhead markers by the svg's id, so the id is renamed
 * everywhere rather than dropped, which would lose the styles.
 */
function copyWithOwnId(source: SVGSVGElement): SVGSVGElement {
  const copy = source.cloneNode(true) as SVGSVGElement;
  if (!source.id) return copy;
  const id = `${source.id}-viewer`;
  copy.innerHTML = copy.innerHTML.replaceAll(source.id, id);
  copy.id = id;
  return copy;
}

function download(svg: SVGSVGElement) {
  const url = URL.createObjectURL(
    new Blob([svgFile(svg)], { type: "image/svg+xml" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "diagram.svg";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openDiagramViewer(source: SVGSVGElement) {
  document.querySelector(".diagram-viewer")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "diagram-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram");
  overlay.tabIndex = -1;

  const toolbar = document.createElement("div");
  toolbar.className = "diagram-viewer-toolbar";
  toolbar.append(
    button("zoomIn", "Zoom in (+)"),
    button("zoomOut", "Zoom out (-)"),
    button("fit", "Fit (0)"),
    button("download", "Download SVG"),
    button("close", "Close (Esc)"),
  );

  const stage = document.createElement("div");
  stage.className = "diagram-viewer-stage";
  const svg = copyWithOwnId(source);
  const size = naturalSize(source);
  svg.setAttribute("width", String(size.width));
  svg.setAttribute("height", String(size.height));
  svg.style.maxWidth = "none";
  stage.append(svg);
  overlay.append(toolbar, stage);
  document.body.append(overlay);

  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    svg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    overlay.dataset.scale = scale.toFixed(3);
  };
  const fit = () => {
    const width = stage.clientWidth || window.innerWidth;
    const height = stage.clientHeight || window.innerHeight;
    scale = Math.min(
      MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min(width / size.width, height / size.height) * 0.95,
      ),
    );
    x = (width - size.width * scale) / 2;
    y = (height - size.height * scale) / 2;
    apply();
  };
  // zoom keeping the stage point (px, py) in place
  const zoom = (
    factor: number,
    px = stage.clientWidth / 2,
    py = stage.clientHeight / 2,
  ) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    apply();
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    const actions: Record<string, () => void> = {
      Escape: close,
      "+": () => zoom(ZOOM_STEP),
      "=": () => zoom(ZOOM_STEP),
      "-": () => zoom(1 / ZOOM_STEP),
      "0": fit,
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
  document.addEventListener("keydown", onKey, true);

  toolbar.addEventListener("click", (event) => {
    const action = (event.target as Element).closest<HTMLElement>("button")
      ?.dataset.action;
    if (action === "zoomIn") zoom(ZOOM_STEP);
    else if (action === "zoomOut") zoom(1 / ZOOM_STEP);
    else if (action === "fit") fit();
    else if (action === "download") download(svg);
    else if (action === "close") close();
  });

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoom(
        Math.exp(-event.deltaY / 300),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    },
    { passive: false },
  );

  let drag: { id: number; x: number; y: number } | undefined;
  stage.addEventListener("pointerdown", (event) => {
    drag = { id: event.pointerId, x: event.clientX - x, y: event.clientY - y };
    stage.setPointerCapture?.(event.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    x = event.clientX - drag.x;
    y = event.clientY - drag.y;
    apply();
  });
  const endDrag = () => {
    drag = undefined;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  fit();
  overlay.focus();
  return { close, zoom, fit, overlay };
}
