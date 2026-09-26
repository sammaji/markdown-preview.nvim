// A headless Neovim or Vim with the plugin from this checkout, isolated from
// the user's config and data. Both are driven through the same interface:
// Neovim over its --listen socket, Vim over a JSON channel it opens back to
// the test.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type EditorKind = "nvim" | "vim";

export const REPO = resolve(__dirname, "../..");
export const EXE = process.platform === "win32" ? ".exe" : "";
export const SERVER_BINARY = join(REPO, "target/release", `markdown-preview${EXE}`);

/** vimscript single-quoted string literal */
export function vimString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** vimscript double-quoted string for keys in `:help key-notation` */
function vimKeys(keys: string) {
  const escaped = keys.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped.replace(/<([^<>\s]+)>/g, "\\<$1>")}"`;
}

export async function waitFor<T>(
  what: string,
  poll: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await poll();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`, { cause: lastError });
}

export interface StartOptions {
  /** `g:` variables, set before the plugin loads */
  vars?: Record<string, unknown>;
  /** plugin directory to load, the checkout by default */
  plugin?: string;
  /**
   * The server binary the plugin must pick, checked before the test starts;
   * `null` skips the check, for tests that install the binary themselves.
   */
  binary?: string | null;
  /** extra environment for the editor, and the server and install scripts it starts */
  env?: Record<string, string>;
  /** extra vimscript lines for the init file, after the variables */
  init?: string[];
}

export abstract class Editor {
  protected constructor(
    readonly kind: EditorKind,
    /** temporary directory: the editor's cwd, profile, log and test files */
    readonly dir: string,
    readonly logFile: string,
    protected readonly process: ChildProcess,
  ) {}

  static async start(kind: EditorKind, options: StartOptions = {}): Promise<Editor> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `mkdp-${kind}-`)));
    const logFile = join(dir, "mkdp.log");
    const plugin = options.plugin ?? REPO;
    const init = [
      "set nocompatible",
      `let &runtimepath = ${vimString(plugin)} . ',' . &runtimepath`,
      "filetype plugin on",
      "set updatetime=100",
      // every URL the server asks to open, instead of starting a browser
      "let g:mkdp_test_urls = []",
      "function! MkdpTestOpen(url) abort",
      "  call add(g:mkdp_test_urls, a:url)",
      "endfunction",
      "let g:mkdp_browserfunc = 'MkdpTestOpen'",
      ...Object.entries(options.vars ?? {}).map(
        ([name, value]) => `let g:${name} = json_decode(${vimString(JSON.stringify(value))})`,
      ),
      ...(options.init ?? []),
    ];
    const env = {
      ...process.env,
      HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CACHE_HOME: join(dir, "cache"),
      NVIM_MKDP_LOG_FILE: logFile,
      NVIM_MKDP_LOG_LEVEL: "debug",
      ...options.env,
    };
    mkdirSync(env.HOME, { recursive: true });

    const editor =
      kind === "nvim" ? await Nvim.launch(dir, logFile, init, env) : await Vim.launch(dir, logFile, init, env);

    // a stale app/bin download or another binary would make these tests
    // pass or fail for the wrong build
    const expected = options.binary === undefined ? SERVER_BINARY : options.binary;
    if (expected !== null) {
      const binary = await editor.eval<string>("mkdp#util#server_binary()");
      if (resolve(binary) !== expected) {
        await editor.stop();
        throw new Error(`plugin would run ${binary || "no binary"}, expected ${expected}`);
      }
    }
    return editor;
  }

  /** Evaluates a vimscript expression. Throws on a vim error. */
  abstract eval<T = unknown>(expr: string): Promise<T>;

  /** Types keys as the user would, in `:help key-notation`. */
  abstract keys(keys: string): Promise<void>;

  /** Asks the editor to quit, without waiting. */
  protected abstract quit(): void;

  /** Runs an Ex command and returns its output. Throws on a vim error. */
  command(cmd: string): Promise<string> {
    return this.eval<string>(`execute(${vimString(cmd)})`);
  }

  /** Writes a file into the editor's directory, which is its cwd. */
  write(path: string, content: string | Buffer): string {
    const file = join(this.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  /** Writes a file and edits it. */
  async open(path: string, content: string): Promise<void> {
    this.write(path, content);
    await this.command(`edit ${path}`);
  }

  /** All URLs the server asked to open so far. */
  urls(): Promise<string[]> {
    return this.eval<string[]>("g:mkdp_test_urls");
  }

  /** The URL of the `n`th browser opening the server asked for, 1-based. */
  previewUrl(n = 1, timeoutMs?: number): Promise<string> {
    return waitFor(`the server to open preview #${n}`, async () => (await this.urls())[n - 1], timeoutMs);
  }

  /** `:messages` */
  messages(): Promise<string> {
    return this.command("messages");
  }

  /** `:messages` and the server log, for a failing test's report. */
  async diagnostics(): Promise<string> {
    const messages = await this.messages().catch((error) => `(unavailable: ${error})`);
    let log: string;
    try {
      log = readFileSync(this.logFile, "utf8");
    } catch (error) {
      log = `(unavailable: ${error})`;
    }
    return `--- ${this.kind} :messages ---\n${messages}\n\n--- server log ---\n${log}`;
  }

  get exited(): boolean {
    return this.process.exitCode !== null || this.process.signalCode !== null;
  }

  /** Quits the editor, which stops its server, and removes the directory. */
  async stop({ keepDir = false } = {}): Promise<void> {
    if (!this.exited) {
      const exited = new Promise((r) => this.process.once("exit", r));
      this.quit();
      const killed = setTimeout(() => this.process.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(killed);
    }
    this.cleanup();
    if (!keepDir) rmSync(this.dir, { recursive: true, force: true });
  }

  protected cleanup(): void {}
}

class Nvim extends Editor {
  private constructor(
    dir: string,
    logFile: string,
    process: ChildProcess,
    private readonly socket: string,
  ) {
    super("nvim", dir, logFile, process);
  }

  static async launch(dir: string, logFile: string, init: string[], env: NodeJS.ProcessEnv) {
    const socket =
      process.platform === "win32" ? `\\\\.\\pipe\\${dir.replace(/[\\/:]/g, "-")}` : join(dir, "nvim.sock");
    const initFile = join(dir, "init.vim");
    writeFileSync(initFile, init.join("\n"));
    const child = spawn("nvim", ["--headless", "-u", initFile, "-i", "NONE", "--listen", socket], {
      cwd: dir,
      env,
      stdio: "ignore",
    });
    const nvim = new Nvim(dir, logFile, child, socket);
    await waitFor("neovim to listen", () => nvim.eval<number>("1"));
    return nvim;
  }

  async eval<T = unknown>(expr: string): Promise<T> {
    const { stdout } = await run("nvim", ["--server", this.socket, "--remote-expr", `json_encode(${expr})`]);
    return JSON.parse(stdout) as T;
  }

  async keys(keys: string): Promise<void> {
    await run("nvim", ["--server", this.socket, "--remote-send", keys]);
  }

  protected quit(): void {
    this.keys("<C-\\><C-n>:qa!<CR>").catch(() => {});
  }
}

class Vim extends Editor {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (reply: unknown) => void>();

  private constructor(
    dir: string,
    logFile: string,
    process: ChildProcess,
    private readonly server: Server,
    private readonly channel: Socket,
  ) {
    super("vim", dir, logFile, process);
    channel.setEncoding("utf8");
    channel.on("data", (data: string) => this.receive(data));
  }

  static async launch(dir: string, logFile: string, init: string[], env: NodeJS.ProcessEnv) {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const connected = new Promise<Socket>((r) => server.once("connection", r));

    const initFile = join(dir, "vimrc");
    writeFileSync(
      initFile,
      [
        ...init,
        // without a terminal, <Esc> would wait for the rest of a key code
        "set noesckeys ttimeout ttimeoutlen=0",
        "function! MkdpTestEval(expr) abort",
        "  try",
        "    return {'ok': 1, 'value': eval(a:expr)}",
        "  catch",
        "    return {'ok': 0, 'error': v:exception}",
        "  endtry",
        "endfunction",
        `let g:mkdp_test_channel = ch_open('127.0.0.1:${port}', {'mode': 'json'})`,
      ].join("\n"),
    );
    // stdin stays open so vim keeps waiting for input and runs its main loop
    const child = spawn("vim", ["-N", "-u", initFile, "-i", "NONE", "--not-a-term"], {
      cwd: dir,
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const exited = new Promise<never>((_, reject) =>
      child.once("exit", (code) => reject(new Error(`vim exited with ${code} before connecting`))),
    );
    try {
      const channel = await Promise.race([connected, exited]);
      return new Vim(dir, logFile, child, server, channel);
    } finally {
      clearTimeout(timeout);
    }
  }

  // messages are JSON arrays sent back to back, maybe split across reads
  private receive(data: string) {
    this.buffer += data;
    for (;;) {
      const end = arrayEnd(this.buffer);
      if (end < 0) return;
      const [id, reply] = JSON.parse(this.buffer.slice(0, end)) as [number, unknown];
      this.buffer = this.buffer.slice(end).trimStart();
      this.pending.get(id)?.(reply);
      this.pending.delete(id);
    }
  }

  async eval<T = unknown>(expr: string): Promise<T> {
    if (this.exited) throw new Error("vim has exited");
    const id = this.nextId++;
    const reply = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`vim did not answer ${expr}`));
      }, 5_000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.channel.write(JSON.stringify(["call", "MkdpTestEval", [expr], id]));
    });
    const result = reply as { ok: number; value?: T; error?: string } | string;
    if (typeof result !== "object") throw new Error(`vim failed to evaluate ${expr}: ${result}`);
    if (!result.ok) throw new Error(`${expr}: ${result.error}`);
    return result.value as T;
  }

  async keys(keys: string): Promise<void> {
    await this.eval(`feedkeys(${vimKeys(keys)}, 't')`);
  }

  protected quit(): void {
    this.channel.write(JSON.stringify(["ex", "qa!"]));
  }

  protected cleanup(): void {
    this.channel.destroy();
    this.server.close();
  }
}

/** End of the first complete top-level JSON array in `text`, or -1. */
function arrayEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
