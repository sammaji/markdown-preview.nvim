import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // the preview page runs in the browser; tests that don't need a DOM
    // opt out with a `@vitest-environment node` comment
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
