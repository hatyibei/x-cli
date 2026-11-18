import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "./errors.ts";
import { configDir } from "./session.ts";

/**
 * Keep at least `minGapMs` between requests made by *different* x-cli processes. Agents run one
 * command per process, so an in-memory throttle alone would let `like A; like B; like C` fire
 * back-to-back. Best effort: a small lock file serializes the read-modify-write.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function throttleAcrossProcesses(minGapMs: number): Promise<void> {
  if (!Number.isFinite(minGapMs) || minGapMs <= 0) return;
  const dir = configDir();
  const stamp = join(dir, "last-request");
  const lock = join(dir, "last-request.lock");
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  for (;;) {
    let handle;
    try {
      handle = await open(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        await sleep(minGapMs); // can't coordinate (read-only dir?): still keep the gap
        return;
      }
      // A lock whose owner died is stale; a live owner is never skipped, however long the queue.
      const owner = Number(await readFile(lock, "utf8").catch(() => ""));
      const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
      if ((owner > 0 && !alive(owner)) || (!owner && age > 5_000)) await rm(lock, { force: true });
      await sleep(100);
      continue;
    }
    try {
      await handle.writeFile(String(process.pid));
      const last = Number(await readFile(stamp, "utf8").catch(() => "0")) || 0;
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await sleep(Math.min(wait, minGapMs));
      await writeFile(stamp, String(Date.now()));
      return;
    } finally {
      await handle.close();
      await rm(lock, { force: true });
    }
  }
}
