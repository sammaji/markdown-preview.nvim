import type { Metadata } from "next";
import type { ReactNode } from "react";

import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Markdown Preview",
  icons: { icon: "/_static/favicon.ico" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* not bundled: the server swaps these for g:mkdp_markdown_css and g:mkdp_highlight_css */}
        <link rel="stylesheet" href="/_static/markdown.css" />
        <link rel="stylesheet" href="/_static/highlight.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
