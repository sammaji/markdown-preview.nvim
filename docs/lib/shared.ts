import { createGetUrl } from "fumadocs-core/source";

export const appName = "markdown-preview.nvim";
export const docsRoute = "/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const gitConfig = {
  user: "sammaji",
  repo: "markdown-preview.nvim",
  branch: "master",
};

export const siteUrl = "https://mkdp.sammaji.com";

export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, "content.md"];
  return { segments, url: getContentUrl(segments, page.locale) };
}
