// Renders markdown the way the preview page does and parses the result, so
// tests can assert on elements instead of HTML strings.
import { createRenderer } from "@/lib/markdown";
import type { PreviewOptions } from "@/lib/protocol";

export function render(src: string, options: PreviewOptions = {}): HTMLElement {
  const root = document.createElement("section");
  root.innerHTML = createRenderer(options).render(src);
  return root;
}

export function html(src: string, options: PreviewOptions = {}): string {
  return createRenderer(options).render(src);
}
