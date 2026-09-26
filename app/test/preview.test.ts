import { afterEach, describe, expect, test } from "vitest";

import { bufnrFromUrl, displayName } from "@/components/preview";

describe("displayName", () => {
  test.each([
    ["/home/me/notes/README.md", "README"],
    ["C:\\Users\\me\\notes\\todo.markdown", "todo"],
    ["relative/dir/file.tar.md", "file.tar"],
    ["no-extension", "no-extension"],
    ["/home/me/.hidden", ".hidden"],
    ["", ""],
  ])("%s -> %s", (path, name) => {
    expect(displayName(path)).toBe(name);
  });
});

describe("bufnrFromUrl", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  test.each([
    ["/page/1", 1],
    ["/page/42", 42],
    ["/page/7?x=1#top", 7],
  ])("%s -> %d", (path, bufnr) => {
    window.history.replaceState(null, "", path);
    expect(bufnrFromUrl()).toBe(bufnr);
  });

  test.each(["/", "/page/", "/page/abc", "/other/3"])("%s has no buffer", (path) => {
    window.history.replaceState(null, "", path);
    expect(bufnrFromUrl()).toBeNaN();
  });
});
