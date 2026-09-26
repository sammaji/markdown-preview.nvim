// Release checks that need neither an editor nor a browser: the names and
// versions spread over the workflow, the install scripts and the plugin must
// agree, or a release publishes something users cannot install.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "@playwright/test";

import { REPO, SERVER_BINARY } from "../lib/editor";
import { VERSION } from "../lib/release";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const RELEASES = "https://github.com/sammaji/markdown-preview.nvim/releases/download";

/** Asset base names the release workflow publishes. */
function releasedAssets() {
  const workflow = read(".github/workflows/release.yml");
  const names = [...workflow.matchAll(/^\s+name: (markdown-preview-[\w-]+)$/gm)].map((m) => m[1]);
  expect(names.length, "release.yml matrix names").toBeGreaterThan(0);
  return names;
}

/** Platforms mkdp#util#get_platform() can answer. */
function pluginPlatforms() {
  const util = read("autoload/mkdp/util.vim");
  const body = /function! s:detect_platform\(\)[\s\S]*?endfunction/.exec(util)![0];
  return [...body.matchAll(/return '([\w-]+)'/g)].map((m) => m[1]);
}

test.describe("versions", () => {
  test("Cargo.toml, Cargo.lock and the built binary agree", () => {
    const lock = /name = "markdown-preview"\nversion = "([^"]+)"/.exec(read("Cargo.lock"));
    expect(lock?.[1], "Cargo.lock").toBe(VERSION);
    expect(execFileSync(SERVER_BINARY, ["--version"], { encoding: "utf8" }).trim(), "binary").toBe(VERSION);
  });

  test("CHANGELOG.md has an entry for the version", () => {
    const top = /^## (v\S+)/m.exec(read("CHANGELOG.md"))?.[1];
    expect(top, "newest CHANGELOG.md entry").toBe(`v${VERSION}`);
  });

  test("the plugin reads the same version as the scripts", () => {
    // mkdp#util#version(), install.sh and install.cmd each parse Cargo.toml themselves
    const out = execFileSync(
      "nvim",
      [
        "--headless",
        "-u",
        "NONE",
        "-i",
        "NONE",
        "--cmd",
        `set rtp^=${REPO}`,
        "-c",
        "call writefile([mkdp#util#version()], '/dev/stdout')",
        "-c",
        "qa!",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe(VERSION);
  });

  test("release.sh tags what release.yml builds", () => {
    expect(read("release.sh")).toContain('tag="v$version"');
    expect(read(".github/workflows/release.yml")).toMatch(/tags: \["v\*"\]/);
  });
});

test.describe("release assets", () => {
  test("every platform the plugin knows has a released asset", () => {
    const assets = releasedAssets();
    for (const platform of pluginPlatforms()) {
      expect(assets, `mkdp#util#get_platform() = '${platform}'`).toContain(`markdown-preview-${platform}`);
    }
  });

  test("install.sh only downloads released assets", () => {
    const assets = releasedAssets();
    const downloads = [...read("app/install.sh").matchAll(/download (markdown-preview-[\w-]+)\.tar\.gz/g)].map(
      (m) => m[1],
    );
    expect(downloads.length).toBeGreaterThan(0);
    for (const name of downloads) expect(assets).toContain(name);
  });

  test("mkdp#util#get_platform() names the asset for the machine", () => {
    test.skip(process.platform !== "linux", "macOS and Windows are detected by the editor, not uname");
    const cases: [string, string][] = [
      ["Linux x86_64", "linux"],
      ["Linux aarch64", "linux-arm64"],
      ["FreeBSD amd64", "freebsd"],
    ];
    for (const [system, platform] of cases) {
      const bin = mkdtempSync(join(tmpdir(), "mkdp-uname-"));
      try {
        writeFileSync(join(bin, "uname"), `#!/bin/sh\necho '${system}'\n`);
        chmodSync(join(bin, "uname"), 0o755);
        const out = execFileSync(
          "nvim",
          ["--headless", "-u", "NONE", "-i", "NONE", "--cmd", `set rtp^=${REPO}`,
            "-c", "call writefile([mkdp#util#get_platform()], '/dev/stdout')", "-c", "qa!"],
          { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
        ).trim();
        expect(out, system).toBe(platform);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    }
  });

  test("install.cmd downloads the Windows asset", () => {
    expect(read("app/install.cmd")).toContain('$file = "markdown-preview-win.zip"');
    expect(releasedAssets()).toContain("markdown-preview-win");
  });

  test("archives hold the file name the plugin runs", () => {
    const workflow = read(".github/workflows/release.yml");
    // app/bin/markdown-preview-<platform>[.exe], see s:pre_build in autoload/mkdp/util.vim
    expect(read("autoload/mkdp/util.vim")).toContain("let s:pre_build = s:mkdp_root_dir . '/app/bin/markdown-preview-'");
    expect(workflow).toContain("cp target/${{ matrix.target }}/release/markdown-preview ${{ matrix.name }}");
    expect(workflow).toContain("tar -czf ${{ matrix.name }}.tar.gz ${{ matrix.name }}");
    expect(workflow).toContain("markdown-preview.exe ${{ matrix.name }}.exe");
  });
});

test.describe("install.sh", () => {
  test.skip(process.platform === "win32", "install.sh is for unix");

  /** Runs a copy of install.sh as if on `uname -sm` = `system`, with curl faked. */
  function install(system: string, args: string[] = [], { failDownload = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), "mkdp-install-"));
    try {
      cpSync(join(REPO, "app/install.sh"), join(root, "app/install.sh"));
      cpSync(join(REPO, "Cargo.toml"), join(root, "Cargo.toml"));
      const bin = join(root, "fakebin");
      mkdirSync(bin);
      // an archive holding one executable named like the requested asset
      const log = join(root, "requests");
      writeFileSync(
        join(bin, "uname"),
        `#!/bin/sh\n[ "$1" = "-sm" ] && echo '${system}' && exit 0\nexec /usr/bin/uname "$@"\n`,
      );
      writeFileSync(
        join(bin, "curl"),
        [
          "#!/bin/sh",
          'for url; do :; done',
          `echo "$url" >> '${log}'`,
          failDownload ? "echo 'curl: (22) 404' >&2; exit 22" : "",
          'name=$(basename "$url" .tar.gz)',
          'tmp=$(mktemp -d); printf "#!/bin/sh\\necho fake\\n" > "$tmp/$name"',
          'tar -czf - -C "$tmp" "$name"',
        ].join("\n"),
      );
      chmodSync(join(bin, "uname"), 0o755);
      chmodSync(join(bin, "curl"), 0o755);
      const result = spawnSync("bash", [join(root, "app/install.sh"), ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      const binDir = join(root, "app/bin");
      const installed = existsSync(binDir)
        ? execFileSync("ls", [binDir], { encoding: "utf8" }).split("\n").filter((f) => f && !f.endsWith(".gz"))
        : [];
      const executable = installed.every((f) => (statSync(join(binDir, f)).mode & 0o111) !== 0);
      return { status: result.status, output: result.stdout + result.stderr, requests, installed, executable };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const supported: [string, string][] = [
    ["Linux x86_64", "markdown-preview-linux"],
    ["Darwin x86_64", "markdown-preview-macos"],
    ["Darwin arm64", "markdown-preview-macos-arm64"],
    ["Linux aarch64", "markdown-preview-linux-arm64"],
    ["Linux arm64", "markdown-preview-linux-arm64"],
    ["FreeBSD amd64", "markdown-preview-freebsd"],
  ];
  for (const [system, asset] of supported) {
    test(`${system} installs ${asset}`, () => {
      const result = install(system, ["v1.2.3"]);
      expect(result.requests).toEqual([`${RELEASES}/v1.2.3/${asset}.tar.gz`]);
      expect(result.installed).toEqual([asset]);
      expect(result.executable).toBe(true);
    });
  }

  test("without a tag it installs the plugin's version", () => {
    const result = install("Linux x86_64");
    expect(result.requests).toEqual([`${RELEASES}/v${VERSION}/markdown-preview-linux.tar.gz`]);
  });

  // unsupported systems must not get a binary for another architecture, and
  // the build hook must see the failure
  for (const system of ["Linux i686", "Linux armv7l", "FreeBSD arm64", "SunOS i86pc"]) {
    test(`${system} downloads nothing`, () => {
      const result = install(system, ["v1.2.3"]);
      expect(result.requests).toEqual([]);
      expect(result.installed).toEqual([]);
      expect(result.output).toContain("No pre-built binary available");
      expect(result.status).not.toBe(0);
    });
  }

  test("a failed download leaves no binary behind", () => {
    const result = install("Linux x86_64", ["v1.2.3"], { failDownload: true });
    expect(result.requests).toHaveLength(1);
    expect(result.installed).toEqual([]);
    expect(result.output).toContain("Command failed (exit code 22)");
  });
});

const CONTENT = "docs/content/docs";
const SITE = "https://mkdp.sammaji.com";

/** The markdown files users read: the site's pages and the repository's own. */
function docPages() {
  const pages = ["README.md", "CONTRIBUTING.md", "skip-test-case.md"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".mdx")) pages.push(path);
    }
  };
  walk(CONTENT);
  return pages;
}

/** Markdown without its fenced code blocks, where `#` and `](` mean nothing. */
const prose = (markdown: string) => markdown.replace(/^(`{3,})[\s\S]*?^\1$/gm, "");

/** The anchors the site (and GitHub) give a page's headings. */
function anchors(markdown: string) {
  const seen = new Map<string, number>();
  return [...prose(markdown).matchAll(/^#{1,6} (.+)$/gm)].map((m) => {
    const slug = m[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  });
}

/** The content file of a site path such as `/docs/features/themes/`. */
function pageOfUrl(path: string) {
  const slug = path.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  return [`${CONTENT}/${slug || "index"}.mdx`, `${CONTENT}/${slug}/index.mdx`].find((f) => existsSync(join(REPO, f)));
}

/** The repository file a link in `doc` points to, or undefined when it is broken. */
function linkTarget(doc: string, file: string) {
  if (file.startsWith(SITE)) return file === SITE || file === `${SITE}/` ? "docs/app/(home)/page.tsx" : pageOfUrl(file.slice(SITE.length));
  if (file.startsWith("/docs")) return pageOfUrl(file);
  const path = file ? join(dirname(doc), decodeURIComponent(file)) : doc;
  return existsSync(join(REPO, path)) ? path : undefined;
}

/** `#### \`name\`` headings of the configuration reference, per section. */
function documentedOptions() {
  const config = read(`${CONTENT}/configuration.mdx`);
  const section = (from: string, to: string) =>
    [...config.slice(config.indexOf(from), config.indexOf(to)).matchAll(/^#### `(\w+)`/gm)].map((m) => m[1]);
  return {
    options: section("\n## Options", "\n## Preview options"),
    previewOptions: section("\n## Preview options", "\n## Commands and mappings"),
  };
}

test.describe("docs", () => {
  test("every mkdp#util# function the docs mention exists", () => {
    const util = read("autoload/mkdp/util.vim");
    const defined = new Set([...util.matchAll(/^function! (mkdp#util#\w+)/gm)].map((m) => m[1]));
    for (const doc of [...docPages(), "build.lua"]) {
      for (const [, name] of read(doc).matchAll(/(mkdp#util#\w+)/g)) {
        expect(defined, `${name} in ${doc}`).toContain(name);
      }
    }
  });

  test("every documented option is read by the plugin or the server", () => {
    const code = ["plugin/mkdp.vim", "autoload/mkdp/util.vim", "autoload/mkdp/autocmd.vim", "autoload/mkdp.vim", "src/server.rs"]
      .map(read)
      .join("\n");
    const { options } = documentedOptions();
    expect(options.length).toBeGreaterThan(20);
    for (const option of options) {
      // g:mkdp_x in vimscript, get(g:, 'mkdp_x') or get_var("mkdp_x") elsewhere
      expect(code, `g:mkdp_${option}`).toMatch(new RegExp(`(g:mkdp_${option}\\b|['"]mkdp_${option}['"])`));
    }
  });

  test("every option of the plugin and of setup() is documented", () => {
    const { options } = documentedOptions();
    const internal = new Set(["clients_active", "node_channel_id"]);
    const defaults = [...read("plugin/mkdp.vim").matchAll(/^\s*let g:mkdp_(\w+) =/gm)].map((m) => m[1]);
    const table = /local OPTIONS = \{([\s\S]*?)\n\}/.exec(read("lua/markdown-preview/init.lua"))![1];
    const setup = [...table.matchAll(/^ {2}(\w+) =/gm)].map((m) => m[1]);
    expect(setup.length).toBeGreaterThan(20);
    // preview_options has a section of its own
    const documented = [...options, "preview_options"];
    for (const option of [...defaults, ...setup].filter((o) => !internal.has(o))) {
      expect(documented, `${option} in configuration.mdx`).toContain(option);
    }
    // and nothing documented that setup() rejects
    for (const option of options) expect(setup, `setup() accepts ${option}`).toContain(option);
  });

  test("the preview options are documented, and exist", () => {
    const { previewOptions } = documentedOptions();
    const protocol = read("app/src/lib/protocol.ts");
    const body = /interface PreviewOptions \{([\s\S]*?)\n\}/.exec(protocol)![1];
    const keys = [...body.matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect([...previewOptions].sort()).toEqual([...keys].sort());
  });

  test("links between the docs point to pages and headings that exist", () => {
    let checked = 0;
    for (const doc of docPages()) {
      const text = prose(read(doc));
      // markdown links, and <Card href="..."> in MDX
      const targets = [...text.matchAll(/\]\(([^)\s]+)\)|href="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
      for (const target of targets) {
        if (/^[a-z]+:/.test(target) && !target.startsWith(SITE)) continue;
        const [file, anchor] = target.split("#");
        const path = linkTarget(doc, file);
        expect(path, `${target} in ${doc}`).toBeDefined();
        if (anchor && /\.mdx?$/.test(path!)) {
          expect(anchors(read(path!)), `${target} in ${doc}`).toContain(anchor);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("the lazy.nvim example builds without calling an autoload function (#690)", () => {
    // `build = function() vim.fn["mkdp#util#install"]() end` runs before the
    // plugin is on the runtimepath and fails with E117
    for (const doc of docPages()) {
      expect(read(doc), doc).not.toMatch(/build\s*=\s*function\(\)\s*vim\.fn\[/);
    }
  });
});
