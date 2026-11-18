#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";

/**
 * Bun auto-loads .env files from the current directory, and agents run x-cli inside arbitrary
 * repositories. A malicious .env must not be able to swap the account (X_COOKIE) or move the
 * session (X_CLI_HOME), so x-cli settings are only honoured when they come from the real environment.
 */
/** Settings that decide whose account is used, where the session lives, or how traffic is routed. */
const SENSITIVE = /^(X_COOKIE|X_CLI_\w+|XDG_CONFIG_HOME|HOME|USERPROFILE|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|NODE_TLS_\w+|NODE_EXTRA_CA_CERTS|SSL_CERT_\w+)$/;

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'" || q === "`") && v.endsWith(q) && v.length >= 2) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, "");
}

function dropDotenvSettings(): void {
  let files: string[] = [];
  try {
    files = readdirSync(process.cwd()).filter((f) => /^\.env(\..+)?$/.test(f));
  } catch {
    return;
  }
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.]*)[ \t]*[=:][ \t]*(.*)$/gm)) {
      const name = m[1]!;
      if (!SENSITIVE.test(name)) continue;
      const value = unquote(m[2]!);
      // Bun never overrides a variable the shell already set, so only drop it when the
      // process has exactly the .env value (a shell export with another value is kept).
      if (process.env[name] !== undefined && process.env[name] === value) {
        delete process.env[name];
        console.error(`x-cli: ignoring ${name} from ${f} (set it in your shell instead)`);
      }
    }
  }
}

dropDotenvSettings();
if (process.env.X_COOKIE) console.error("x-cli: using the session from X_COOKIE, not the saved one");
const { main } = await import("./cli.ts");
process.exitCode = await main(process.argv.slice(2));
