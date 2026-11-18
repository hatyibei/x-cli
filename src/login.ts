import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, debug, sleep } from "./errors.ts";

function browserCandidates(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
    case "win32": {
      const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
      return roots.flatMap((r) => [
        join(r as string, "Google/Chrome/Application/chrome.exe"),
        join(r as string, "Microsoft/Edge/Application/msedge.exe"),
      ]);
    }
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
}

export function findBrowser(explicit?: string): string {
  const path = explicit || process.env.X_CLI_BROWSER || browserCandidates().find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new CliError(
      "BROWSER_NOT_FOUND",
      "No Chrome/Edge/Chromium found. Pass --browser <path> (or set X_CLI_BROWSER), or use `x-cli auth import`.",
    );
  }
  return path;
}

/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe` (fd 3 in, fd 4 out,
 * NUL-delimited JSON). Unlike a debugging port, no other local process can attach to the
 * logged-in browser.
 */
export class PipeCdp {
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(
    private readonly input: NodeJS.WritableStream,
    output: NodeJS.ReadableStream,
  ) {
    output.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        const p = msg.id ? this.pending.get(msg.id) : undefined;
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.input.write(`${JSON.stringify({ id, method, params })}\0`);
    });
  }
}

/** Has the throwaway profile stored an X session cookie yet? (Chrome flushes cookies to disk every ~30s.) */
function profileHasSession(profileDir: string): boolean {
  for (const rel of ["Default/Network/Cookies", "Default/Cookies"]) {
    const path = join(profileDir, rel);
    if (!existsSync(path)) continue;
    try {
      const db = new Database(path, { readonly: true });
      try {
        const row = db.query("select count(*) as n from cookies where name = 'auth_token' and (host_key = '.x.com' or host_key = 'x.com')").get() as { n: number } | null;
        if (row && row.n > 0) return true;
      } finally {
        db.close();
      }
    } catch {
      // locked or mid-write; try again next poll
    }
  }
  return false;
}

async function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.killed && proc.exitCode !== null) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** Read the x.com cookies from a profile by opening it headless over a debugging pipe. */
async function readProfileCookies(executable: string, profileDir: string): Promise<Record<string, string>> {
  const proc = spawn(executable, [`--user-data-dir=${profileDir}`, "--headless=new", "--remote-debugging-pipe", "--no-first-run", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  try {
    const cdp = new PipeCdp(proc.stdio[3] as NodeJS.WritableStream, proc.stdio[4] as NodeJS.ReadableStream);
    const res = await cdp.send<{ cookies: Array<{ name: string; value: string; domain: string }> }>("Storage.getCookies", {}, 20000);
    return Object.fromEntries(res.cookies.filter((c) => /(^|\.)x\.com$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]));
  } finally {
    proc.kill();
    await waitForExit(proc, 5000);
  }
}

/**
 * Log in with a real browser window and return the x.com cookies.
 *
 * X and Google refuse to log in inside a browser that is remote-controlled (DevTools protocol),
 * so the login window is a plain Chrome with a throwaway profile and no debugging flags. Once
 * the profile has stored X's session cookie (or the user quits that Chrome), x-cli shuts it
 * down, reopens the same profile headless over a debugging pipe, and reads only the cookies.
 * The password never passes through x-cli, and the profile is deleted afterwards (also on Ctrl-C).
 */
export async function browserLogin(opts: {
  timeoutSec: number;
  browser?: string;
}): Promise<Record<string, string>> {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join(tmpdir(), "x-cli-login-"));
  await chmod(profileDir, 0o700).catch(() => {});
  const procs: ChildProcess[] = [];
  let cleaned = false;
  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    for (const p of procs) {
      try {
        p.kill();
      } catch {
        // already gone
      }
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  const onSignal = (sig: NodeJS.Signals) => {
    cleanupSync();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  process.once("exit", cleanupSync);

  try {
    const login = spawn(executable, [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "https://x.com/i/flow/login"], { stdio: "ignore" });
    procs.push(login);
    let loginExited = false;
    login.once("exit", () => (loginExited = true));
    login.once("error", () => (loginExited = true));
    console.error("Log in to X in the Chrome window that opened. It closes by itself about 30 seconds after you're logged in (or quit it with Cmd+Q once logged in).");

    const deadline = Date.now() + opts.timeoutSec * 1000;
    let found = false;
    while (Date.now() < deadline) {
      if (profileHasSession(profileDir)) {
        found = true;
        break;
      }
      if (loginExited) break; // the user quit the browser
      await sleep(2000);
    }
    debug(`login: wait loop done (found=${found}, browserExited=${loginExited})`);
    // A graceful shutdown writes the latest cookies to disk.
    if (!loginExited) {
      login.kill("SIGTERM");
      if (!(await waitForExit(login, 10000))) login.kill("SIGKILL");
    }
    // Even if the on-disk check never saw the cookie (different DB location, late flush), the
    // browser itself is the source of truth: ask it.
    debug("login: reading cookies headless");
    const cookies = await readProfileCookies(executable, profileDir).catch(() => ({}) as Record<string, string>);
    debug(`login: got cookies [${Object.keys(cookies).join(",")}]`);
    if (!cookies.auth_token || !cookies.ct0) {
      const timedOut = !found && Date.now() >= deadline;
      throw new CliError(
        timedOut ? "LOGIN_TIMEOUT" : "LOGIN_ABORTED",
        timedOut
          ? `Login was not completed within ${opts.timeoutSec}s (no X session in the browser). Run it again with a longer --timeout, or use \`x-cli auth import\`.`
          : "The browser was closed before login completed, or it did not keep an X session. Try again, or use `x-cli auth import`.",
      );
    }
    return cookies;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("exit", cleanupSync);
    cleanupSync();
  }
}
