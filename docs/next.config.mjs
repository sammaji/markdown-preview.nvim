import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// only `next build` exports: in dev, an export makes every path missing from
// generateStaticParams an error instead of a 404
const isBuild = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const config = {
  output: isBuild ? "export" : undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
  turbopack: {
    root: import.meta.dirname,
  },
};

export default withMDX(config);
