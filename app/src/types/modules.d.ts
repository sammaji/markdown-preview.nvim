// Packages without bundled type definitions.

declare module "markdown-it-deflist" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}

declare module "markdown-it-footnote" {
  import type { PluginSimple } from "markdown-it";
  const plugin: PluginSimple;
  export default plugin;
}

declare module "markdown-it-emoji" {
  import type { PluginWithOptions } from "markdown-it";
  export const full: PluginWithOptions<Record<string, unknown>>;
}

declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>;
  export default plugin;
}

declare module "plantuml-encoder" {
  export function encode(code: string): string;
}

declare module "katex/contrib/mhchem";
