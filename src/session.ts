import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Session {
  /** x.com cookies, name -> value. `auth_token` and `ct0` are required. */
  cookies: Record<string, string>;
  screenName?: string;
  userId?: string;
  savedAt: string;
}

export function configDir(): string {
  if (process.env.X_CLI_HOME) return process.env.X_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "x-cli");
}

export const sessionPath = () => join(configDir(), "session.json");

/** Parse a `Cookie:` header style string ("a=1; b=2") into a map. */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export function hasAuth(cookies: Record<string, string> | undefined): boolean {
  return !!cookies?.auth_token && !!cookies?.ct0;
}

/**
 * Load the session. `X_COOKIE` (a raw Cookie header with auth_token and ct0) overrides the
 * saved file, which is handy for CI or one-off runs.
 */
export async function loadSession(): Promise<Session | null> {
  if (process.env.X_COOKIE) return { cookies: parseCookieHeader(process.env.X_COOKIE), savedAt: "env" };
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8")) as Session;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function saveSession(session: Session): Promise<string> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  // Write a fresh 0600 file and rename it over the old one, so the cookies never sit in a looser file.
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
  return path;
}

export async function clearSession(): Promise<boolean> {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
