import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The page is exported to out/ and embedded in the Rust server binary.
  output: "export",
  reactStrictMode: true,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
