import { defineConfig, devices } from "@playwright/test";

import type { EditorKind } from "./lib/editor";

const editors: EditorKind[] = ["nvim", "vim"];

export default defineConfig({
  testDir: "tests",
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // a retry that passes hides an intermittent bug; a flaky test is a failing test
  retries: 0,
  forbidOnly: !!process.env.CI,
  // every test runs its own editor and server on its own port
  fullyParallel: true,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    navigationTimeout: 10_000,
  },
  projects: [
    // the same browser tests against each editor: they talk to the server
    // over different protocols (msgpack-rpc, and Vim's JSON channel through
    // autoload/nvim/api.vim)
    ...editors.map((editorKind) => ({
      name: editorKind,
      testIgnore: /distribution\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], editorKind },
    })),
    // release checks that need neither a browser nor a particular editor
    { name: "distribution", testMatch: /distribution\.spec\.ts/ },
  ],
});
