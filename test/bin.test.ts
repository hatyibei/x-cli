import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("x-cli ignores X_COOKIE / X_CLI_* from a .env in the current directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-cli-env-"));
  writeFileSync(join(dir, ".env"), "X_COOKIE=auth_token=evil; ct0=evil\nX_CLI_HOME: /tmp/evil\nXDG_CONFIG_HOME=/tmp/evilcfg\nOTHER=1\n");
  const home = mkdtempSync(join(tmpdir(), "x-cli-home-"));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/bin.ts"), "auth", "status"], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: home },
  });
  const err = r.stderr.toString();
  expect(err).toContain("ignoring X_COOKIE from .env");
  expect(err).toContain("ignoring X_CLI_HOME from .env");
  expect(err).toContain("ignoring XDG_CONFIG_HOME from .env");
  expect(JSON.parse(r.stdout.toString())).toMatchObject({ loggedIn: false, sessionPath: join(home, ".config/x-cli/session.json") });
});

test("a shell export with a different value than .env is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-cli-env-"));
  writeFileSync(join(dir, ".env"), "X_CLI_HOME=/tmp/evil\n");
  const home = mkdtempSync(join(tmpdir(), "x-cli-home-"));
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../src/bin.ts"), "auth", "status"], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: home, X_CLI_HOME: join(home, "real") },
  });
  expect(r.stderr.toString()).not.toContain("ignoring");
  expect(JSON.parse(r.stdout.toString()).sessionPath).toBe(join(home, "real/session.json"));
});
