import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { analyzeTweets } from "./analyze.ts";
import * as api from "./api.ts";
import { XClient } from "./client.ts";
import { CliError, debug } from "./errors.ts";
import { browserLogin } from "./login.ts";
import type { Tweet } from "./normalize.ts";
import { clearSession, hasAuth, loadSession, parseCookieHeader, saveSession, sessionPath } from "./session.ts";
import { checkLength, screenName, splitThread, tweetId, weightedLength } from "./text.ts";
import { cachePath, readCache } from "./web.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;
type Token = { kind: string; name?: string; value?: string };

/** Pair each --alt with the --media right before it (parseArgs' values lose that order). */
function mediaWithAlt(tokens: Token[]): Array<{ path: string; alt?: string }> {
  const out: Array<{ path: string; alt?: string }> = [];
  for (const t of tokens) {
    if (t.kind !== "option") continue;
    if (t.name === "media" && t.value !== undefined) out.push({ path: t.value });
    else if (t.name === "alt" && t.value !== undefined) {
      const last = out[out.length - 1];
      if (!last || last.alt !== undefined) throw new CliError("USAGE", "Each --alt must come right after the --media it describes.");
      last.alt = t.value;
    }
  }
  return out;
}

export interface Deps {
  client?: XClient;
  login?: typeof browserLogin;
  readStdin?: () => Promise<string>;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  args?: number;
  run(ctx: { values: Values; positionals: string[]; client: XClient; deps: Deps; tokens: Token[] }): Promise<unknown>;
}

const limitOpt = (def: string) => ({ limit: { type: "string" as const, default: def }, cursor: { type: "string" as const } });

const COMMANDS: Record<string, Command> = {
  // ---------------- auth ----------------
  "auth login": {
    usage: "auth login [--timeout <sec, default 280>] [--browser <path>]",
    summary: "Open a browser, log in to X by hand, and save the session cookies",
    options: { timeout: { type: "string", default: "280" }, browser: { type: "string" } },
    async run({ values, deps }) {
      const login = deps.login ?? browserLogin;
      const cookies = await login({
        timeoutSec: int(values.timeout, "timeout"),
        browser: str(values.browser),
      });
      // The browser really holds an X session here, so keep it even if the check call fails
      // (X may have changed that endpoint); report why so it can be fixed without logging in again.
      return finishLogin(cookies, { saveUnverified: true });
    },
  },
  "auth import": {
    usage: "auth import   (pipe the Cookie header or 'auth_token=..; ct0=..' via stdin; --cookie/--auth-token/--ct0 also work but end up in shell history)",
    summary: "Save a session from cookies copied from browser DevTools (auth_token and ct0 are required)",
    options: { cookie: { type: "string" }, "auth-token": { type: "string" }, ct0: { type: "string" } },
    async run({ values, deps }) {
      let cookies: Record<string, string>;
      if (str(values["auth-token"]) || str(values.ct0)) cookies = { auth_token: str(values["auth-token"]) ?? "", ct0: str(values.ct0) ?? "" };
      else cookies = parseCookieHeader(str(values.cookie) ?? (await (deps.readStdin ?? readStdin)()));
      if (!hasAuth(cookies)) throw new CliError("USAGE", "The cookies must include both auth_token and ct0.");
      return finishLogin(cookies);
    },
  },
  "auth status": {
    usage: "auth status",
    summary: "Show whether the saved session works and which account it belongs to",
    async run({ client }) {
      const session = await loadSession();
      if (!session || !hasAuth(session.cookies)) return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const { screenName } = await api.accountSettings(client);
        return { loggedIn: true, screenName, savedAt: session.savedAt };
      } catch (e) {
        if (e instanceof CliError && ["AUTH_ERROR", "NOT_LOGGED_IN", "FORBIDDEN"].includes(e.code)) {
          return { loggedIn: false, expired: true, reason: e.message, sessionPath: sessionPath() };
        }
        if (e instanceof CliError) return { loggedIn: "unknown", reason: `${e.code}: ${e.message}`, savedAt: session.savedAt, sessionPath: sessionPath() };
        throw e;
      }
    },
  },
  "auth logout": {
    usage: "auth logout",
    summary: "Delete the saved session (does not log out other devices)",
    async run() {
      return { removed: await clearSession(), sessionPath: sessionPath() };
    },
  },

  // ---------------- me / users ----------------
  whoami: {
    usage: "whoami",
    summary: "Profile of the logged-in account",
    async run({ client }) {
      return api.me(client);
    },
  },
  user: {
    usage: "user <screen_name> [--limit 20] [--replies] [--cursor <c>]",
    summary: "Profile and recent posts of a user (--limit 0 for profile only)",
    args: 1,
    options: { ...limitOpt("20"), replies: { type: "boolean", default: false } },
    async run({ values, positionals, client }) {
      const limit = int(values.limit, "limit");
      const user = await api.userByScreenName(client, screenName(positionals[0]!));
      if (limit === 0) return { user };
      const posts = await api.userTweets(client, user, limit, { replies: !!values.replies, cursor: str(values.cursor) });
      return { user, posts: posts.items, exhausted: posts.exhausted, nextCursor: posts.nextCursor, skipped: posts.skipped };
    },
  },
  followers: {
    usage: "followers <screen_name> [--limit 50] [--cursor <c>]",
    summary: "Followers of a user",
    args: 1,
    options: limitOpt("50"),
    async run({ values, positionals, client }) {
      const limit = int(values.limit, "limit");
      const user = await api.userByScreenName(client, screenName(positionals[0]!));
      return api.followList(client, "followers", user, limit, str(values.cursor));
    },
  },
  following: {
    usage: "following <screen_name> [--limit 50] [--cursor <c>]",
    summary: "Accounts a user follows",
    args: 1,
    options: limitOpt("50"),
    async run({ values, positionals, client }) {
      const limit = int(values.limit, "limit");
      const user = await api.userByScreenName(client, screenName(positionals[0]!));
      return api.followList(client, "following", user, limit, str(values.cursor));
    },
  },
  likes: {
    usage: "likes [<screen_name>] [--limit 20]",
    summary: "Posts a user liked (defaults to yourself; others' likes are private since 2024)",
    options: limitOpt("20"),
    async run({ values, positionals, client }) {
      const user = positionals[0] ? await api.userByScreenName(client, screenName(positionals[0])) : await api.me(client);
      return api.userLikes(client, user.id, int(values.limit, "limit"), str(values.cursor));
    },
  },

  // ---------------- reading ----------------
  post: {
    usage:
      "post [<text> | -] [--file <path>] [--no-thread] [--reply-to <id|url>] [--quote <id|url>] [--media <path> [--alt <text>]]... [--schedule <ISO time>] [--long] [--dry-run]",
    summary: "Publish a post. Lines of only '---' split the text into a thread (--no-thread to disable). Use -- before text that starts with '-'",
    options: {
      file: { type: "string" },
      "no-thread": { type: "boolean", default: false },
      "reply-to": { type: "string" },
      quote: { type: "string" },
      media: { type: "string", multiple: true },
      alt: { type: "string", multiple: true },
      schedule: { type: "string" },
      long: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    async run({ values, positionals, client, deps, tokens }) {
      let text = positionals.join(" ");
      if (str(values.file)) {
        if (text) throw new CliError("USAGE", "Pass the text or --file, not both.");
        text = await readFile(str(values.file)!, "utf8");
      } else if (text === "-") text = await (deps.readStdin ?? readStdin)();
      const posts = splitThread(text, !values["no-thread"]);
      if (!posts.length) throw new CliError("USAGE", "Nothing to post. Pass the text, --file <path>, or '-' to read stdin.");
      const lengths = checkLength(posts, !!values.long);
      const pairs = mediaWithAlt(tokens);
      const alts = pairs.map((p) => p.alt);
      const media = await Promise.all(pairs.map((p) => api.checkMedia(p.path)));
      api.checkMediaSet(media);
      const replyTo = str(values["reply-to"]) ? tweetId(str(values["reply-to"])!) : undefined;
      const quoteId = str(values.quote) ? tweetId(str(values.quote)!) : undefined;
      const scheduleAt = str(values.schedule) ? parseDate(str(values.schedule)!) : undefined;
      if (scheduleAt && (posts.length > 1 || replyTo || quoteId)) throw new CliError("USAGE", "--schedule supports a single post without --reply-to/--quote.");

      const plan = {
        posts: posts.map((p, i) => ({
          text: p,
          weightedLength: lengths[i]!.weightedLength,
          ...(i === 0 && media.length ? { media: media.map((m, j) => ({ path: m.path, alt: alts[j] })) } : {}),
          ...(i === 0 && replyTo ? { replyTo } : {}),
          ...(i === 0 && quoteId ? { quote: quoteId } : {}),
        })),
        ...(posts.length > 1 ? { thread: posts.length } : {}),
        ...(scheduleAt ? { scheduleAt: scheduleAt.toISOString() } : {}),
      };
      if (values["dry-run"]) return { dryRun: true, ...plan };

      const mediaIds: string[] = [];
      for (const [i, m] of media.entries()) mediaIds.push(await api.uploadMedia(client, m.path, alts[i]));

      if (scheduleAt) return api.scheduleTweet(client, posts[0]!, scheduleAt, mediaIds);

      const quoteUrl = quoteId ? (await api.tweetById(client, quoteId)).url : undefined;
      const published: Array<Tweet | { id: string; url: string }> = [];
      let parent = replyTo;
      for (const [i, p] of posts.entries()) {
        try {
          const t = await api.createTweet(client, { text: p, long: lengths[i]!.weightedLength > 280, replyTo: parent, quote: i === 0 ? quoteUrl : undefined, mediaIds: i === 0 ? mediaIds : [] });
          published.push(t);
          parent = t.id;
        } catch (e) {
          if (!published.length) throw e;
          const err = e instanceof CliError ? e : new CliError("UNEXPECTED", String(e));
          throw new CliError(
            "PARTIAL_THREAD",
            `Posts 1-${published.length} of ${posts.length} were published, then post ${i + 1} failed (${err.code}: ${err.message}). Do NOT re-run the whole thread. To continue, post the remaining text with --reply-to ${parent}.`,
            { detail: { published: published.map((t) => ({ id: t.id, url: t.url })), failedIndex: i, remaining: posts.slice(i), cause: { code: err.code, detail: err.detail } } },
          );
        }
      }
      return published.length === 1 ? { ok: true, post: published[0] } : { ok: true, thread: published };
    },
  },
  delete: {
    usage: "delete <id|url>",
    summary: "Delete one of your posts",
    args: 1,
    async run({ positionals, client }) {
      return api.deleteTweet(client, tweetId(positionals[0]!));
    },
  },
  tweet: {
    usage: "tweet <id|url> [--replies 20]",
    summary: "A post with its thread context and replies",
    args: 1,
    options: { replies: { type: "string", default: "20" } },
    async run({ values, positionals, client }) {
      const id = tweetId(positionals[0]!);
      const replies = int(values.replies, "replies");
      if (replies === 0) return { tweet: await api.tweetById(client, id) };
      return api.tweetDetail(client, id, replies);
    },
  },
  search: {
    usage: "search <query> [--product top|latest|people|media] [--limit 20] [--cursor <c>]",
    summary: "Search posts (or people). Supports X operators: from:, since:, min_faves:, lang:, -filter:replies ...",
    args: 1,
    options: { ...limitOpt("20"), product: { type: "string", default: "top" } },
    async run({ values, positionals, client }) {
      const product = oneOf(values.product, Object.keys(api.SEARCH_PRODUCTS), "product") as keyof typeof api.SEARCH_PRODUCTS;
      return api.search(client, positionals.join(" "), product, int(values.limit, "limit"), str(values.cursor));
    },
  },
  home: {
    usage: "home [--latest] [--limit 20] [--cursor <c>]",
    summary: "Your home timeline (For you, or Following with --latest)",
    options: { ...limitOpt("20"), latest: { type: "boolean", default: false } },
    async run({ values, client }) {
      return api.home(client, !!values.latest, int(values.limit, "limit"), str(values.cursor));
    },
  },
  bookmarks: {
    usage: "bookmarks [--limit 20] [--cursor <c>]",
    summary: "Your bookmarks",
    options: limitOpt("20"),
    async run({ values, client }) {
      return api.bookmarks(client, int(values.limit, "limit"), str(values.cursor));
    },
  },
  likers: {
    usage: "likers <id|url> [--limit 50]",
    summary: "Who liked a post (only visible for your own posts)",
    args: 1,
    options: limitOpt("50"),
    async run({ values, positionals, client }) {
      return api.engagers(client, "likers", tweetId(positionals[0]!), int(values.limit, "limit"), str(values.cursor));
    },
  },
  retweeters: {
    usage: "retweeters <id|url> [--limit 50]",
    summary: "Who reposted a post",
    args: 1,
    options: limitOpt("50"),
    async run({ values, positionals, client }) {
      return api.engagers(client, "retweeters", tweetId(positionals[0]!), int(values.limit, "limit"), str(values.cursor));
    },
  },

  // ---------------- engagement ----------------
  ...toggleCommands("like", "Like a post", "Remove a like"),
  ...toggleCommands("retweet", "Repost a post", "Undo a repost"),
  ...toggleCommands("bookmark", "Bookmark a post", "Remove a bookmark"),
  follow: {
    usage: "follow <screen_name>",
    summary: "Follow a user",
    args: 1,
    async run({ positionals, client }) {
      return api.follow(client, screenName(positionals[0]!), true);
    },
  },
  unfollow: {
    usage: "unfollow <screen_name>",
    summary: "Unfollow a user",
    args: 1,
    async run({ positionals, client }) {
      return api.follow(client, screenName(positionals[0]!), false);
    },
  },

  // ---------------- analysis ----------------
  "analyze search": {
    usage: "analyze search <query> [--product top|latest] [--limit 100] [--top 10]",
    summary: "Collect search results and summarize engagement, timing, media/link effects, top authors and posts",
    args: 1,
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" }, product: { type: "string", default: "top" } },
    async run({ values, positionals, client }) {
      const product = oneOf(values.product, ["top", "latest", "media"], "product") as keyof typeof api.SEARCH_PRODUCTS;
      const res = await api.search(client, positionals.join(" "), product, int(values.limit, "limit"));
      return { query: positionals.join(" "), product, ...analyzeTweets(res.items as Tweet[], { top: int(values.top, "top") }) };
    },
  },
  "analyze user": {
    usage: "analyze user [<screen_name>] [--limit 100] [--top 10]",
    summary: "Summarize a user's recent posts (defaults to yourself)",
    options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
    async run({ values, positionals, client }) {
      const user = positionals[0] ? await api.userByScreenName(client, screenName(positionals[0])) : await api.me(client);
      const res = await api.userTweets(client, user, int(values.limit, "limit"));
      const own = (res.items as Tweet[]).filter((t) => t.author.id === user.id);
      // The pinned post can be years old; it would skew the time buckets.
      const pinned = new Set(user.pinnedTweetIds ?? []);
      const sample = own.filter((t) => !pinned.has(t.id));
      return { user: { screenName: user.screenName, followers: user.followers }, ...analyzeTweets(sample, { top: int(values.top, "top") }) };
    },
  },

  // ---------------- maintenance ----------------
  count: {
    usage: "count <text | -> [--file <path>]",
    summary: "Weighted character count as X counts it (Japanese = 2, URL = 23, max 280), per thread post",
    options: { file: { type: "string" } },
    async run({ values, positionals, deps }) {
      let text = positionals.join(" ");
      if (str(values.file)) text = await readFile(str(values.file)!, "utf8");
      else if (text === "-" || !text) text = await (deps.readStdin ?? readStdin)();
      return { posts: splitThread(text).map((p) => ({ weightedLength: weightedLength(p), max: 280, ok: weightedLength(p) <= 280, text: p })) };
    },
  },
  ops: {
    usage: "ops [--grep <word>] [--refresh]",
    summary: "List GraphQL operations discovered in x.com's web client (debugging)",
    options: { grep: { type: "string" }, refresh: { type: "boolean", default: false } },
    async run({ values, client }) {
      const web = await client.webInfo(!!values.refresh);
      const re = str(values.grep) ? new RegExp(str(values.grep)!, "i") : null;
      const ops = Object.values(web.operations)
        .filter((o) => !re || re.test(o.name))
        .map((o) => ({ name: o.name, id: o.id, kind: o.kind, source: o.source, args: o.args?.filter((a) => !a.startsWith("__relay")) }));
      return { fetchedAt: web.fetchedAt, scannedFiles: web.scannedFiles, transactionIdReady: !!web.tx, cachePath: cachePath(), count: ops.length, operations: ops };
    },
  },
  raw: {
    usage: "raw <OperationName> [--vars '<json>'] [--field-toggles '<json>'] [--allow-mutation]",
    summary: "Call a discovered GraphQL query and print the raw response (debugging). Mutations need --allow-mutation",
    args: 1,
    options: { vars: { type: "string", default: "{}" }, "field-toggles": { type: "string" }, "allow-mutation": { type: "boolean", default: false } },
    async run({ values, positionals, client }) {
      const op = await client.operation(positionals[0]!);
      if (op.kind !== "query" && !values["allow-mutation"]) {
        throw new CliError("USAGE", `${op.name} is a ${op.kind} (it changes something on X). Only run it with the user's explicit OK, and pass --allow-mutation.`);
      }
      const vars = json(values.vars, "vars");
      const ft = str(values["field-toggles"]) ? json(values["field-toggles"], "field-toggles") : undefined;
      return client.graphql(positionals[0]!, vars, { fieldToggles: ft as Record<string, boolean> | undefined });
    },
  },
  doctor: {
    usage: "doctor",
    summary: "Check the session, operation discovery and transaction-id generation",
    async run({ client }) {
      const session = await loadSession();
      const out: Record<string, unknown> = { sessionPath: sessionPath(), hasSession: !!session && hasAuth(session.cookies) };
      try {
        const web = await client.webInfo(true);
        const needed = [["UserByScreenName"], ["UserTweets"], ["SearchTimeline", "SearchByRawQuery"], ["TweetDetail"], ["CreateTweet"], ["FavoriteTweet"], ["CreateRetweet"], ["Followers", "followersQuery"], ["HomeTimeline"]];
        const optional = [["DeleteTweet", "deleteTweetMutation"], ["CreateScheduledTweet"], ["UnfavoriteTweet", "likeButtonControlUnfavoriteMutation"]];
        const missing = (groups: string[][]) => groups.filter((g) => !g.some((n) => web.operations[n])).map((g) => g.join(" / "));
        out.operations = { count: Object.keys(web.operations).length, scannedFiles: web.scannedFiles, missing: missing(needed), missingOptional: missing(optional) };
        out.transactionIdReady = !!web.tx;
      } catch (e) {
        out.discoveryError = (e as Error).message;
      }
      if (out.hasSession) {
        try {
          out.account = (await api.accountSettings(client)).screenName;
        } catch (e) {
          out.accountError = (e as Error).message;
        }
      }
      const cache = await readCache();
      out.cacheFetchedAt = cache?.fetchedAt;
      return out;
    },
  },
};

function toggleCommands(action: "like" | "retweet" | "bookmark", onSummary: string, offSummary: string): Record<string, Command> {
  const make = (on: boolean): Command => ({
    usage: `${on ? "" : "un"}${action} <id|url>`,
    summary: on ? onSummary : offSummary,
    args: 1,
    async run({ positionals, client }) {
      return api.toggle(client, action, tweetId(positionals[0]!), on);
    },
  });
  return { [action]: make(true), [`un${action}`]: make(false) };
}

// ---------------------------------------------------------------- helpers

async function finishLogin(cookies: Record<string, string>, opts: { saveUnverified?: boolean } = {}) {
  // Only what API calls need; no long-lived device tokens.
  const keep = Object.fromEntries(Object.entries(cookies).filter(([k]) => ["auth_token", "ct0", "twid", "lang"].includes(k)));
  const client = new XClient({ session: { cookies: keep, savedAt: "probe" }, minIntervalMs: 0, crossProcessThrottle: false });
  // Nothing to overwrite: keep the browser session right away, so a hang or crash during the
  // check below never costs the user another login.
  if (opts.saveUnverified && !(await loadSession().catch(() => null))) {
    await saveSession({ cookies: keep, savedAt: new Date().toISOString() });
    debug("login: saved session before verification");
  }
  try {
    debug("login: verifying with X");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CliError("TIMEOUT", "Checking the session with X took longer than 120s.")), 120_000);
    });
    const { screenName } = await Promise.race([api.accountSettings(client), timeout]).finally(() => clearTimeout(timer));
    const path = await saveSession({ cookies: keep, screenName, savedAt: new Date().toISOString() });
    return { loggedIn: true, screenName, sessionPath: path };
  } catch (e) {
    // X positively rejected these cookies: never replace a working session with them.
    const rejected = e instanceof CliError && ["AUTH_ERROR", "NOT_LOGGED_IN", "FORBIDDEN", "SUSPENDED"].includes(e.code);
    if (!opts.saveUnverified || rejected) throw e;
    const path = await saveSession({ cookies: keep, savedAt: new Date().toISOString() });
    const secrets = Object.values(keep).filter((v) => v.length >= 8);
    const scrub = (m: string) => secrets.reduce((acc, v) => acc.split(v).join("[redacted]"), m).slice(0, 300);
    const err = e instanceof CliError ? { code: e.code, message: scrub(e.message), status: e.status } : { code: "UNKNOWN", message: scrub(String(e)) };
    const userId = /^u(?:%3D|=)(\d+)$/.exec(keep.twid ?? "")?.[1];
    process.stderr.write(`warning: saved the browser session but could not confirm it with X (${err.code}).\n`);
    return { saved: true, verified: false, userId, verifyError: err, sessionPath: path };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

function int(v: unknown, name: string): number {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new CliError("USAGE", `--${name} must be a non-negative integer`);
  return n;
}

function oneOf(v: unknown, allowed: string[], name: string): string {
  if (typeof v !== "string" || !allowed.includes(v)) throw new CliError("USAGE", `--${name} must be one of ${allowed.join(", ")}`);
  return v;
}

function json(v: unknown, name: string): Record<string, unknown> {
  try {
    return JSON.parse(String(v));
  } catch {
    throw new CliError("USAGE", `--${name} must be JSON`);
  }
}

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new CliError("USAGE", `Invalid date: ${s} (use ISO 8601, e.g. 2026-11-20T09:00:00+09:00)`);
  if (d.getTime() < Date.now() + 60_000) throw new CliError("USAGE", "--schedule must be at least a minute in the future");
  return d;
}

function findCommand(argv: string[]): { cmd: Command; rest: string[] } | null {
  const two = `${argv[0]} ${argv[1]}`;
  if (argv.length >= 2 && COMMANDS[two]) return { cmd: COMMANDS[two], rest: argv.slice(2) };
  if (COMMANDS[argv[0]!]) return { cmd: COMMANDS[argv[0]!]!, rest: argv.slice(1) };
  return null;
}

export function helpText(): string {
  const lines = Object.values(COMMANDS).map((c) => `  x-cli ${c.usage}\n      ${c.summary}`);
  return [
    "x-cli — unofficial X (Twitter) CLI. All output is JSON.",
    "",
    "Commands:",
    ...lines,
    "",
    "Environment (ignored when they come from a .env file): X_COOKIE (Cookie header, overrides the saved session),",
    "             X_CLI_HOME, X_CLI_INTERVAL_MS (default 1000), X_CLI_TZ (default Asia/Tokyo), X_CLI_NO_TRANSACTION_ID",
  ].join("\n");
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0]!)) {
    console.log(helpText());
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log("0.1.0");
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group = Object.values(COMMANDS).filter((c) => c.usage.startsWith(`${argv[0]} `));
    const message = group.length ? `Usage:\n${group.map((c) => `  x-cli ${c.usage}`).join("\n")}` : `Unknown command: ${argv[0]}. Run \`x-cli --help\`.`;
    console.error(JSON.stringify({ error: { code: "USAGE", message } }, null, 2));
    return 2;
  }
  const { cmd, rest } = found;
  const beforeDashDash = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (beforeDashDash.includes("--help") || beforeDashDash.includes("-h")) {
    console.log(`x-cli ${cmd.usage}\n  ${cmd.summary}`);
    return 0;
  }
  try {
    const tz = process.env.X_CLI_TZ;
    if (tz) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new CliError("USAGE", `X_CLI_TZ is not a valid time zone: ${tz} (e.g. Asia/Tokyo)`);
      }
    }
    const { values, positionals, tokens } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true, tokens: true });
    if (positionals.length < (cmd.args ?? 0)) throw new CliError("USAGE", `Usage: x-cli ${cmd.usage}`);
    const client = deps.client ?? new XClient();
    const result = await cmd.run({ values: values as Values, positionals, client, deps, tokens: (tokens ?? []) as Token[] });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if ((e as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(JSON.stringify({ error: { code: "USAGE", message: `${(e as Error).message}. Usage: x-cli ${cmd.usage}` } }, null, 2));
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: (e as Error).stack ?? String(e) } }, null, 2));
    return 1;
  }
}
