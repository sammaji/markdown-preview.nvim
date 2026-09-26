import Link from "next/link";
import { repoUrl } from "@/lib/shared";

const install = `{
  "sammaji/markdown-preview.nvim"
}`;

const features = [
  {
    title: "Live preview",
    text: "The page follows the buffer as you type and scrolls with the cursor.",
    href: "/docs/features/live-preview",
  },
  {
    title: "Math and diagrams",
    text: "KaTeX, Mermaid with a full-screen viewer, Chart.js, Graphviz, PlantUML and more.",
    href: "/docs/features/diagrams",
  },
  {
    title: "GitHub-flavoured",
    text: "Alerts, tables of contents, task lists, footnotes, emoji, front matter and local images.",
    href: "/docs/features/markdown",
  },
  {
    title: "Your theme",
    text: "Light and dark, or any shadcn/ui or tweakcn theme, with your own fonts.",
    href: "/docs/features/themes",
  },
  {
    title: "No Node.js",
    text: "One small server binary for macOS, Linux, FreeBSD and Windows, downloaded for you.",
    href: "/docs/installation",
  },
  {
    title: "Share it",
    text: "Open the preview on your phone or from a remote machine, protected by a token.",
    href: "/docs/features/browser",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-16 md:py-24">
      <section className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Markdown preview for Neovim and Vim
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          Preview markdown in your browser with synchronised scrolling, math,
          diagrams and themes. It updates as you type, before you save.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs/quickstart"
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <a
            href={repoUrl}
            className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>
      </section>

      <section className="mx-auto w-full max-w-2xl">
        <p className="mb-2 text-sm text-fd-muted-foreground">With lazy.nvim:</p>
        <pre className="overflow-x-auto rounded-xl border bg-fd-card p-4 text-sm">
          <code>{install}</code>
        </pre>
        <p className="mt-2 text-sm text-fd-muted-foreground">
          Then open a markdown file and run <code>:MarkdownPreview</code>.{" "}
          <Link
            href="/docs/installation"
            className="underline underline-offset-4"
          >
            Other plugin managers
          </Link>
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Link
            key={feature.title}
            href={feature.href}
            className="rounded-xl border bg-fd-card p-5 transition-colors hover:bg-fd-accent"
          >
            <h2 className="mb-1 font-semibold">{feature.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{feature.text}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
