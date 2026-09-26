// A copy of the plugin as a user gets it from git (no target/, no app/bin/),
// and a stand-in for the GitHub release it downloads the server from.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { REPO, SERVER_BINARY } from "./editor";

const RELEASES = "https://github.com/sammaji/markdown-preview.nvim/releases/download";

export const VERSION = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, "Cargo.toml"), "utf8"))![1];

/** What mkdp#util#get_platform() answers on this machine. */
export const PLATFORM =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? process.arch === "arm64"
        ? "macos-arm64"
        : "macos"
      : "linux";

/** Tracked and untracked-but-not-ignored files, as a clone would have them. */
export function copyPlugin(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "mkdp-plugin-"))), "markdown-preview.nvim");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPO,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && !f.startsWith("e2e/"));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    try {
      copyFileSync(join(REPO, file), join(dir, file));
    } catch {
      // deleted in the working tree
    }
  }
  return dir;
}

/** Serves the release archives of the built server, like a GitHub release. */
export class FakeRelease {
  /** paths requested so far */
  readonly requests: string[] = [];
  /** answer 404 to every download while set */
  failing = false;

  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeRelease> {
    // packaged like .github/workflows/release.yml does
    const dir = mkdtempSync(join(tmpdir(), "mkdp-release-"));
    const name = `markdown-preview-${PLATFORM}`;
    mkdirSync(join(dir, `v${VERSION}`));
    copyFileSync(SERVER_BINARY, join(dir, name));
    execFileSync("tar", ["-czf", join(dir, `v${VERSION}`, `${name}.tar.gz`), name], { cwd: dir });

    let release: FakeRelease;
    const server = createServer((req, res) => {
      release.requests.push(req.url ?? "");
      const file = join(dir, decodeURIComponent(req.url ?? "/"));
      let body: Buffer | undefined;
      try {
        body = release.failing ? undefined : readFileSync(file);
      } catch {
        body = undefined;
      }
      if (body) {
        res.writeHead(200, { "content-type": "application/gzip" }).end(body);
      } else {
        res.writeHead(404).end("Not Found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    release = new FakeRelease(server, dir, url);
    return release;
  }

  /** Points the plugin's install script at this release instead of GitHub. */
  redirect(plugin: string) {
    const script = join(plugin, "app/install.sh");
    const original = readFileSync(script, "utf8");
    if (!original.includes(RELEASES)) throw new Error(`install.sh no longer downloads from ${RELEASES}`);
    writeFileSync(script, original.replaceAll(RELEASES, this.url));
  }

  /** The path the plugin should download for this machine. */
  get assetPath() {
    return `/v${VERSION}/markdown-preview-${PLATFORM}.tar.gz`;
  }

  async stop() {
    await new Promise((r) => this.server.close(r));
    rmSync(this.dir, { recursive: true, force: true });
  }
}
