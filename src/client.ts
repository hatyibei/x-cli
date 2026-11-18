import { CliError, sleep , debug } from "./errors.ts";
import { cookieHeader, hasAuth, loadSession, saveSession, type Session } from "./session.ts";
import { throttleAcrossProcesses } from "./throttle.ts";
import { buildContext, generateTransactionId, type TransactionContext } from "./transaction.ts";
import { discover, FALLBACK_OPERATIONS, isFresh, parseHomePage, readCache, writeCache, type Operation, type WebCache } from "./web.ts";

/** The public bearer token embedded in X's web client (not a secret; same for everyone). */
export const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_AGENT =
  process.env.X_CLI_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Session cookies are only ever sent to these hosts, over https. */
export const TRUSTED_HOSTS = new Set(["x.com", "api.x.com", "upload.x.com"]);

export function isTrustedUrl(u: string | URL): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && TRUSTED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export const REST_BASE = "https://api.x.com/1.1";
export const UPLOAD_URL = "https://upload.x.com/i/media/upload.json";
const DEFAULT_GRAPHQL_BASES = ["https://x.com/i/api/graphql", "https://api.x.com/graphql"];
/** X_CLI_GRAPHQL_BASE may only pick one of the official bases. */
const GRAPHQL_BASES = process.env.X_CLI_GRAPHQL_BASE && DEFAULT_GRAPHQL_BASES.includes(process.env.X_CLI_GRAPHQL_BASE.replace(/\/$/, ""))
  ? [process.env.X_CLI_GRAPHQL_BASE.replace(/\/$/, "")]
  : DEFAULT_GRAPHQL_BASES;

/** Feature switch defaults that are known to matter; anything else the client asks for defaults to its HTML value or false. */
const KNOWN_FEATURES: Record<string, boolean> = {
  responsive_web_graphql_timeline_navigation_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  articles_preview_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

/** GraphQL/REST error codes X uses, mapped to CLI error codes. */
const ERROR_CODES: Record<number, string> = {
  32: "AUTH_ERROR",
  89: "AUTH_ERROR",
  239: "AUTH_ERROR",
  353: "AUTH_ERROR",
  88: "RATE_LIMITED",
  34: "NOT_FOUND",
  50: "NOT_FOUND",
  63: "SUSPENDED",
  64: "SUSPENDED",
  144: "NOT_FOUND",
  139: "ALREADY_DONE",
  327: "ALREADY_DONE",
  160: "ALREADY_DONE",
  186: "TOO_LONG",
  187: "DUPLICATE",
  226: "AUTOMATION_SUSPECTED",
  344: "DAILY_LIMIT",
  385: "NOT_FOUND",
};

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: Record<string, string> | FormData;
  /** Fail fast when there is no session. Default true. */
  auth?: boolean;
  /** Send `x-client-transaction-id`. Default true for x.com/api.x.com requests. */
  transactionId?: boolean;
}

export interface GraphqlOptions {
  fieldToggles?: Record<string, boolean>;
  /** Extra feature values to send. */
  features?: Record<string, boolean>;
}

/**
 * True when a GraphQL `data` object carries an actual result: some scalar value other than a
 * __typename, anywhere in the tree. Failed mutations come back as empty skeletons
 * (`{delete_tweet:{tweet_results:{}}}`) next to `errors`.
 */
export function hasPayload(d: unknown, depth = 0): boolean {
  if (d === null || d === undefined || depth > 20) return false;
  if (typeof d !== "object") return d !== "" && d !== false;
  for (const [k, v] of Object.entries(d)) {
    if (k === "__typename") continue;
    if (hasPayload(v, depth + 1)) return true;
  }
  return false;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Rename snake_case variables to the camelCase names a Relay operation declares, and fill provided variables. */
export function adaptVariables(op: Operation, vars: Record<string, unknown>, loggedIn: boolean): Record<string, unknown> {
  if (!op.args?.length) return vars;
  const args = new Set(op.args);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    if (args.has(k)) out[k] = v;
    else if (args.has(camel(k))) out[camel(k)] = v;
  }
  for (const a of op.args) {
    if (a in out) continue;
    if (a.startsWith("__relay_internal__pv__")) out[a] = loggedIn && /isloggedin/.test(a);
    // Relay declares optional switches like `withIdentity` as required; off is the safe default.
    else if (/^(with|include)[A-Z]/.test(a)) out[a] = false;
  }
  return out;
}

export class XClient {
  private session: Session | null | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  private readonly crossProcessThrottle: boolean;
  private web: WebCache | null = null;
  private webRefreshed = false;
  private discoveryError: Error | undefined;
  private tx: TransactionContext | null | undefined;
  private homeHtml: string | undefined;
  private graphqlBase = GRAPHQL_BASES[0]!;

  constructor(
    opts: {
      session?: Session | null;
      fetchImpl?: typeof fetch;
      minIntervalMs?: number;
      web?: WebCache | null;
      transactionIds?: boolean;
      /** Space requests across separate x-cli processes too (default: true unless fetchImpl is injected). */
      crossProcessThrottle?: boolean;
    } = {},
  ) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const envInterval = Number(process.env.X_CLI_INTERVAL_MS);
    this.minIntervalMs = opts.minIntervalMs ?? (Number.isFinite(envInterval) && envInterval >= 0 ? Math.min(envInterval, 60_000) : 1000);
    if (opts.web !== undefined) this.web = opts.web;
    if (process.env.X_CLI_NO_TRANSACTION_ID || opts.transactionIds === false) this.tx = null;
    this.crossProcessThrottle = opts.crossProcessThrottle ?? !opts.fetchImpl;
  }

  async getSession(): Promise<Session | null> {
    if (this.session === undefined) this.session = await loadSession();
    return this.session;
  }

  private async requireSession(): Promise<Session> {
    const s = await this.getSession();
    if (!s || !hasAuth(s.cookies)) {
      throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `x-cli auth login` (or `x-cli auth import`).");
    }
    return s;
  }

  private async throttle(write: boolean) {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    // Each CLI command is its own process, so also keep a gap between processes (longer for writes).
    if (this.crossProcessThrottle) await throttleAcrossProcesses(write ? Math.max(this.minIntervalMs, 3000) : this.minIntervalMs);
    this.lastRequestAt = Date.now();
  }

  // ------------------------------------------------------------ web bundle

  /** Fetch a public text resource (HTML / JS) with browser-like headers. */
  async fetchText(url: string, withCookies = false): Promise<string> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8" };
    if (withCookies) {
      const s = await this.getSession();
      if (s) headers.Cookie = cookieHeader(s.cookies);
    }
    const res = await this.fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new CliError("API_ERROR", `GET ${url} failed (${res.status})`, { status: res.status });
    return res.text();
  }

  async homePage(): Promise<string> {
    // Without cookies: the logged-out page carries the same bundle and verification key, and a
    // logged-in fetch of x.com/home was seen to hang.
    this.homeHtml ??= await this.fetchText("https://x.com/home", false);
    return this.homeHtml;
  }

  /**
   * Discovered operations (cached on disk). `refresh` forces a re-crawl of the web bundle, at most
   * once per process. If a re-crawl fails, an expired cache is still better than nothing.
   */
  async webInfo(refresh = false): Promise<WebCache> {
    this.web ??= await readCache();
    if (this.web && (this.webRefreshed || (!refresh && isFresh(this.web)))) return this.web;
    // Discovery already failed in this process; don't crawl again on every call.
    if (this.webRefreshed && this.discoveryError) throw this.discoveryError;
    // A forced refresh must see the current page; the transaction context depends on it too.
    if (refresh) this.homeHtml = undefined;
    this.webRefreshed = true;
    try {
      const result = await discover((u) => this.fetchText(u), await this.homePage());
      const { home: _home, ...cache } = result;
      if (Object.keys(cache.operations).length === 0) throw new Error("no operations found in the web bundle");
      await writeCache(cache).catch(() => {});
      this.web = cache;
      if (this.tx) this.tx = undefined; // rebuild with the new indices + page
      return cache;
    } catch (e) {
      if (this.web) return this.web;
      this.discoveryError = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  }

  async operation(names: string | string[]): Promise<Operation> {
    const list = Array.isArray(names) ? names : [names];
    const find = (w: WebCache | null) => {
      for (const n of list) if (w?.operations[n]) return w.operations[n];
      return undefined;
    };
    let web: WebCache | null = null;
    try {
      web = await this.webInfo();
    } catch {
      // fall through to fallbacks
    }
    let op = find(web);
    if (!op && !this.webRefreshed) op = find(await this.webInfo(true).catch(() => null));
    if (!op) for (const n of list) if (FALLBACK_OPERATIONS[n]) return FALLBACK_OPERATIONS[n];
    if (!op) {
      throw new CliError(
        "OPERATION_NOT_FOUND",
        `GraphQL operation ${list.join(" / ")} was not found in x.com's web client. Run \`x-cli ops --refresh\` to re-scan, or \`x-cli ops --grep <word>\` to look for a renamed one.`,
      );
    }
    return op;
  }

  private async transactionId(method: string, url: URL): Promise<string | undefined> {
    if (this.tx === null) return undefined;
    if (this.tx === undefined) {
      try {
        const web = await this.webInfo();
        const home = parseHomePage(await this.homePage());
        if (!web.tx || !home.verificationKey || home.frames.length < 4) throw new Error("missing inputs");
        debug("transaction id: building context");
        this.tx = buildContext({ key: home.verificationKey, frames: home.frames, ...web.tx });
        debug("transaction id: ready");
      } catch {
        this.tx = null;
        return undefined;
      }
    }
    return generateTransactionId(this.tx, method, url.pathname);
  }

  // ------------------------------------------------------------ requests

  async request<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw(url, opts)).data as T;
  }

  async requestRaw(urlStr: string, opts: RequestOptions = {}): Promise<{ status: number; headers: Headers; data: any }> {
    const method = opts.method ?? (opts.json || opts.form ? "POST" : "GET");
    const url = new URL(urlStr);
    if (!isTrustedUrl(url)) throw new CliError("USAGE", `Refusing to send the X session to ${url.origin}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "ja,en;q=0.8",
      Authorization: `Bearer ${WEB_BEARER}`,
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": process.env.X_CLI_LANG ?? "ja",
      Origin: "https://x.com",
      Referer: "https://x.com/",
    };
    const session = opts.auth === false ? await this.getSession() : await this.requireSession();
    if (session && hasAuth(session.cookies)) {
      headers.Cookie = cookieHeader(session.cookies);
      headers["x-csrf-token"] = session.cookies.ct0!;
      headers["x-twitter-auth-type"] = "OAuth2Session";
    }
    if (opts.transactionId !== false) {
      const tid = await this.transactionId(method, url);
      if (tid) headers["x-client-transaction-id"] = tid;
    }

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form instanceof FormData) {
      body = opts.form;
    } else if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
    }

    await this.throttle(method !== "GET");
    debug(`request: ${method} ${url.host}${url.pathname}`);
    const res = await this.fetchImpl(url, { method, headers, body, redirect: "manual" });
    debug(`response: ${res.status}`);
    await this.captureCookies(res.headers);
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }

    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      throw new CliError("RATE_LIMITED", "Rate limited by X. Wait before retrying.", {
        status: 429,
        detail: reset ? { resetAt: new Date(reset * 1000).toISOString() } : undefined,
      });
    }
    const errors: Array<{ code?: number; message?: string; extensions?: { code?: number } }> | undefined = data?.errors;
    if (!res.ok || (errors?.length && !hasPayload(data?.data))) {
      const first = errors?.[0];
      const xcode = first?.code ?? first?.extensions?.code ?? Number(first?.message?.match(/\((\d{2,3})\)/)?.[1] ?? NaN);
      const code =
        (Number.isFinite(xcode) && ERROR_CODES[xcode as number]) ||
        (res.status >= 300 && res.status < 400 ? "AUTH_ERROR" : undefined) ||
        (res.status === 401 ? "AUTH_ERROR" : res.status === 403 ? "FORBIDDEN" : res.status === 404 ? "NOT_FOUND" : "API_ERROR");
      throw new CliError(code, first?.message ?? `${method} ${url.pathname} failed (${res.status})`, {
        status: res.status,
        detail: errors ?? (typeof data === "string" ? data.slice(0, 300) : data),
      });
    }
    return { status: res.status, headers: res.headers, data };
  }

  /** X rotates ct0 occasionally; keep the saved session in sync. */
  private async captureCookies(headers: Headers) {
    const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const s = this.session;
    if (!s || !setCookies.length || s.savedAt === "probe") return;
    let changed = false;
    for (const c of setCookies) {
      const m = c.match(/^(ct0|auth_token)=([^;]*)/);
      if (m && m[2] && s.cookies[m[1]!] !== m[2]) {
        s.cookies[m[1]!] = m[2];
        changed = true;
      }
    }
    if (changed && s.savedAt !== "env") await saveSession(s).catch(() => {});
  }

  /**
   * Call a GraphQL operation by name (or the first of several candidate names that exists).
   * Handles operation discovery, Relay variable naming and missing feature flags.
   */
  async graphql<T = any>(names: string | string[], variables: Record<string, unknown>, opts: GraphqlOptions = {}): Promise<T> {
    let op = await this.operation(names);
    const session = await this.getSession();
    const loggedIn = !!session && hasAuth(session.cookies);
    const extraFeatures: Record<string, boolean> = { ...opts.features };
    let retriedFeatures = false;
    let retriedOps = false;
    let addedVars = 0;
    // Try the current base first, then the other one; only switch for good once the other one works.
    let bases = [this.graphqlBase, ...GRAPHQL_BASES.filter((b) => b !== this.graphqlBase)];
    let baseIdx = 0;

    for (;;) {
      const web = this.web;
      const vars = adaptVariables(op, variables, loggedIn);
      const features: Record<string, boolean> = {};
      for (const f of op.featureSwitches ?? []) features[f] = web?.featureValues[f] ?? KNOWN_FEATURES[f] ?? false;
      Object.assign(features, extraFeatures);
      const fieldToggles = opts.fieldToggles;
      const base = bases[baseIdx]!;
      const url = `${base}/${op.id}/${op.name}`;

      try {
        const result =
          op.kind === "mutation"
            ? await this.request<T>(url, {
                method: "POST",
                json: { variables: vars, features: Object.keys(features).length ? features : undefined, fieldToggles, queryId: op.id },
              })
            : await this.request<T>(url, {
                query: {
                  variables: JSON.stringify(vars),
                  features: Object.keys(features).length ? JSON.stringify(features) : undefined,
                  fieldToggles: fieldToggles ? JSON.stringify(fieldToggles) : undefined,
                },
              });
        this.graphqlBase = base;
        return result;
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        const msg = `${e.message} ${JSON.stringify(e.detail ?? "")}`;
        // `{"path":["variable","withX"],"message":"must be defined"}`: X added a required switch.
        const undefinedVar = /must be defined/.test(msg) ? msg.match(/"path":\["variable","(\w+)"\]/)?.[1] : undefined;
        if (undefinedVar && !(undefinedVar in variables) && addedVars < 3) {
          variables = { ...variables, [undefinedVar]: false };
          op = { ...op, args: op.args && !op.args.includes(undefinedVar) ? [...op.args, undefinedVar] : op.args };
          addedVars++;
          continue;
        }
        const missing = msg.match(/features cannot be null: ([\w, ]+)/)?.[1];
        if (missing && !retriedFeatures) {
          for (const f of missing.split(/,\s*/)) if (f.trim()) extraFeatures[f.trim()] = KNOWN_FEATURES[f.trim()] ?? true;
          retriedFeatures = true;
          continue;
        }
        // 404 = unknown operation id on this base (X answers stale ids and bad transaction ids with 404).
        if (e.status === 404 && baseIdx + 1 < bases.length) {
          baseIdx++;
          continue;
        }
        if (e.status === 404 && !retriedOps && !this.webRefreshed) {
          retriedOps = true;
          retriedFeatures = false;
          await this.webInfo(true).catch(() => null);
          const refreshed = await this.operation(names);
          if (refreshed.id === op.id) throw e; // nothing new to try; don't resend
          op = refreshed;
          bases = [this.graphqlBase, ...GRAPHQL_BASES.filter((b) => b !== this.graphqlBase)];
          baseIdx = 0;
          continue;
        }
        throw e;
      }
    }
  }
}
