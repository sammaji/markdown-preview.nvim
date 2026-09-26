// Installing the server binary the way users get it: a plugin checkout with
// no binary, downloading from a release.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Editor } from "../lib/editor";
import { EXE } from "../lib/editor";
import { copyPlugin, FakeRelease, PLATFORM, VERSION } from "../lib/release";
import { expect, test, token } from "../lib/test";

test.skip(process.platform === "win32", "install.cmd downloads with PowerShell, which these tests do not fake");
// downloads run in a terminal and are waited for
test.setTimeout(60_000);

const installed = (plugin: string) => join(plugin, "app/bin", `markdown-preview-${PLATFORM}${EXE}`);

let plugin: string;
let release: FakeRelease;

test.beforeEach(async () => {
  plugin = copyPlugin();
  release = await FakeRelease.start();
  release.redirect(plugin);
});

test.afterEach(async () => {
  await release.stop();
  rmSync(dirname(plugin), { recursive: true, force: true });
});

async function startEditor(launch: (o: object) => Promise<Editor>) {
  const editor = await launch({ plugin, binary: null });
  expect(await editor.eval<string>("mkdp#util#server_binary()"), "the copy starts without a binary").toBe("");
  return editor;
}

test("the first :MarkdownPreview downloads the server and opens the preview", async ({ launch, page }) => {
  const editor = await startEditor(launch);
  const title = token();
  await editor.open("note.md", `# ${title}\n`);
  await editor.command("MarkdownPreview");

  await page.goto(await editor.previewUrl(1, 30_000));
  await expect(page.locator(".markdown-body h1")).toContainText(title);
  expect(release.requests).toEqual([release.assetPath]);
  // the preview runs the downloaded binary
  expect(resolve(await editor.eval<string>("mkdp#util#server_binary()"))).toBe(installed(plugin));
  expect(statSync(installed(plugin)).mode & 0o111).not.toBe(0);
  expect(execFileSync(installed(plugin), ["--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
  await expect.poll(() => editor.messages()).toContain("install completed");
});

test("a binary from an older version is replaced", async ({ launch, page }) => {
  // what an old release left behind before a plugin update
  mkdirSync(dirname(installed(plugin)), { recursive: true });
  writeFileSync(installed(plugin), "#!/bin/sh\necho 0.0.1\n");
  chmodSync(installed(plugin), 0o755);
  const editor = await launch({ plugin, binary: null });
  expect(await editor.eval<number>("mkdp#util#server_ready()")).toBe(0);

  const title = token();
  await editor.open("note.md", `# ${title}\n`);
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl(1, 30_000));
  await expect(page.locator(".markdown-body h1")).toContainText(title);
  expect(release.requests).toEqual([release.assetPath]);
  expect(execFileSync(installed(plugin), ["--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
});

test("a failed download is reported and retried only on request", async ({ launch, page }) => {
  release.failing = true;
  const editor = await startEditor(launch);
  await editor.open("note.md", "# Retry\n");
  await editor.command("MarkdownPreview");
  await expect.poll(() => editor.messages(), { timeout: 30_000 }).toContain("could not download the server binary");
  expect(release.requests).toEqual([release.assetPath]);
  expect(existsSync(installed(plugin))).toBe(false);

  // another :MarkdownPreview repeats the error without downloading again
  // (echoed while the command runs, so it is in the command's output)
  await editor.command("messages clear");
  expect(await editor.command("MarkdownPreview")).toContain("could not download the server binary");
  await editor.command("sleep 500m");
  expect(release.requests).toHaveLength(1);

  // an explicit install tries again
  release.failing = false;
  await editor.command("call mkdp#util#install()");
  await expect.poll(() => existsSync(installed(plugin)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => editor.eval<number>("mkdp#util#server_ready()"), { timeout: 10_000 }).toBe(1);
  await editor.command("wincmd t");
  await editor.command("MarkdownPreview");
  await page.goto(await editor.previewUrl(1, 30_000));
  await expect(page.locator(".markdown-body h1")).toContainText("Retry");
});

test("mkdp#util#install_sync() installs before returning and keeps the directory", async ({ launch }) => {
  const editor = await startEditor(launch);
  editor.write("project/README.md", "# Project\n");
  await editor.command(`cd ${join(editor.dir, "project")}`);
  const cwd = await editor.eval<string>("getcwd()");

  await editor.eval("mkdp#util#install_sync(v:true)");
  expect(await editor.eval<number>("mkdp#util#server_ready()")).toBe(1);
  expect(release.requests).toEqual([release.assetPath]);
  expect(await editor.eval<string>("getcwd()")).toBe(cwd);
  expect(await editor.eval<number>("haslocaldir()")).toBe(0);
});

test("mkdp#util#install_sync() keeps a window-local directory", async ({ launch }) => {
  const editor = await startEditor(launch);
  editor.write("project/README.md", "# Project\n");
  await editor.command(`lcd ${join(editor.dir, "project")}`);
  const cwd = await editor.eval<string>("getcwd()");
  await editor.eval("mkdp#util#install_sync(v:true)");
  expect(await editor.eval<string>("getcwd()")).toBe(cwd);
  expect(await editor.eval<number>("haslocaldir()")).toBe(1);
});

test("mkdp#util#install() does nothing when the binary is current", async ({ launch }) => {
  const editor = await startEditor(launch);
  await editor.eval("mkdp#util#install_sync(v:true)");
  expect(release.requests).toHaveLength(1);
  await editor.eval("mkdp#util#install_sync(v:true)");
  await editor.command("call mkdp#util#install()");
  await editor.command("sleep 500m");
  expect(release.requests).toHaveLength(1);
});

test.describe("build.lua (lazy.nvim build hook)", () => {
  test.skip(({ editorKind }) => editorKind === "vim", "lazy.nvim is Neovim only");

  // asynchronous: the fake release is served from this process
  const runBuild = (dir: string) =>
    new Promise<{ status: number | null; output: string }>((resolve) => {
      const nvim = spawn(
        "nvim",
        ["--headless", "-u", "NONE", "-i", "NONE", "-c", `luafile ${join(plugin, "build.lua")}`, "-c", "qa!"],
        { cwd: dir, env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") } },
      );
      let output = "";
      nvim.stdout.on("data", (d) => (output += d));
      nvim.stderr.on("data", (d) => (output += d));
      const timer = setTimeout(() => nvim.kill("SIGKILL"), 30_000);
      nvim.on("exit", (status) => {
        clearTimeout(timer);
        resolve({ status, output });
      });
    });

  test("installs the binary", async () => {
    const result = await runBuild(dirname(plugin));
    expect(result.status, result.output).toBe(0);
    expect(release.requests).toEqual([release.assetPath]);
    expect(execFileSync(installed(plugin), ["--version"], { encoding: "utf8" }).trim()).toBe(VERSION);
  });

  test("fails loudly when the download fails", async () => {
    release.failing = true;
    const result = await runBuild(dirname(plugin));
    expect(result.output).toContain("could not install the server binary");
    expect(existsSync(installed(plugin))).toBe(false);
  });
});
