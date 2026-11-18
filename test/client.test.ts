import { describe, expect, spyOn, test } from "bun:test";
import * as api from "../src/api.ts";
import { adaptVariables, XClient } from "../src/client.ts";
import { main } from "../src/cli.ts";
import type { WebCache } from "../src/web.ts";

const session = { cookies: { auth_token: "AT", ct0: "CSRF" }, savedAt: "test" };

const web = (ops: WebCache["operations"]): WebCache => ({
  version: 1,
  fetchedAt: new Date().toISOString(),
  operations: ops,
  featureValues: { a_enabled: true },
  scannedFiles: 1,
});

type Call = { url: URL; init: RequestInit };

function fakeFetch(handler: (call: Call, n: number) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const impl = (async (input: any, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    const r = handler(call, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (f: typeof fetch, w: WebCache) => new XClient({ session, fetchImpl: f, minIntervalMs: 0, web: w, transactionIds: false });

describe("adaptVariables", () => {
  test("renames to declared camelCase args, drops undeclared, fills provided variables", () => {
    const op = { id: "x", name: "FavoriteTweet", kind: "mutation" as const, source: "relay" as const, args: ["tweetId", "__relay_internal__pv__appviewerisloggedinrelayprovider", "__relay_internal__pv__fooenabledrelayprovider"] };
    expect(adaptVariables(op, { tweet_id: "1", dark_request: false }, true)).toEqual({
      tweetId: "1",
      __relay_internal__pv__appviewerisloggedinrelayprovider: true,
      __relay_internal__pv__fooenabledrelayprovider: false,
    });
  });
  test("classic operations pass variables through", () => {
    const op = { id: "x", name: "UserTweets", kind: "query" as const, source: "classic" as const };
    expect(adaptVariables(op, { userId: "1", count: 20 }, true)).toEqual({ userId: "1", count: 20 });
  });
});

describe("XClient.graphql", () => {
  test("GET query with auth headers, features from the page, and a retry for missing features", async () => {
    const { impl, calls } = fakeFetch((_, n) =>
      n === 1 ? { status: 400, body: { errors: [{ message: "The following features cannot be null: c_enabled, d_enabled" }] } } : { body: { data: { ok: 1 } } },
    );
    const c = client(impl, web({ UserTweets: { id: "Q1", name: "UserTweets", kind: "query", featureSwitches: ["a_enabled", "b_enabled"], source: "classic" } }));
    expect(await c.graphql("UserTweets", { userId: "1" })).toEqual({ data: { ok: 1 } });
    expect(calls).toHaveLength(2);
    const url = calls[1]!.url;
    expect(url.pathname).toBe("/i/api/graphql/Q1/UserTweets");
    expect(JSON.parse(url.searchParams.get("variables")!)).toEqual({ userId: "1" });
    expect(JSON.parse(url.searchParams.get("features")!)).toEqual({ a_enabled: true, b_enabled: false, c_enabled: true, d_enabled: true });
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h["x-csrf-token"]).toBe("CSRF");
    expect(h.Cookie).toBe("auth_token=AT; ct0=CSRF");
    expect(h.Authorization).toStartWith("Bearer ");
  });

  test("mutation is a POST with queryId; falls back to the second operation name and the api.x.com base on 404", async () => {
    const { impl, calls } = fakeFetch((_, n) => (n === 1 ? { status: 404, body: "" } : { body: { data: { done: true } } }));
    const c = client(impl, web({ deleteTweetMutation: { id: "M1", name: "deleteTweetMutation", kind: "mutation", args: ["tweetId"], source: "relay" } }));
    await c.graphql(["DeleteTweet", "deleteTweetMutation"], { tweet_id: "5", dark_request: false });
    expect(calls[1]!.url.toString()).toBe("https://api.x.com/graphql/M1/deleteTweetMutation");
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ variables: { tweetId: "5" }, queryId: "M1" });
  });

  test("maps X error codes, and like treats 'already liked' as success", async () => {
    const { impl } = fakeFetch(() => ({ status: 403, body: { errors: [{ code: 139, message: "You have already favorited this Tweet." }] } }));
    const c = client(impl, web({ FavoriteTweet: { id: "F", name: "FavoriteTweet", kind: "mutation", args: ["tweetId"], source: "relay" } }));
    expect(await api.toggle(c, "like", "9", true)).toEqual({ ok: true, id: "9", action: "like", alreadyDone: true });

    const { impl: impl2 } = fakeFetch(() => ({ status: 200, body: { errors: [{ code: 226, message: "This request looks like it might be automated." }] } }));
    const c2 = client(impl2, web({ CreateTweet: { id: "C", name: "CreateTweet", kind: "mutation", source: "classic" } }));
    await expect(api.createTweet(c2, { text: "hi" })).rejects.toMatchObject({ code: "AUTOMATION_SUSPECTED" });
  });

  test("429 becomes RATE_LIMITED with the reset time", async () => {
    const { impl } = fakeFetch(() => ({ status: 429, body: {}, headers: { "x-rate-limit-reset": "1800000000" } }));
    const c = client(impl, web({ UserTweets: { id: "Q", name: "UserTweets", kind: "query", source: "classic" } }));
    await expect(c.graphql("UserTweets", {})).rejects.toMatchObject({ code: "RATE_LIMITED", detail: { resetAt: "2027-01-15T08:00:00.000Z" } });
  });

  test("createTweet sends a reply and media, and returns the normalized post", async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { data: { create_tweet: { tweet_results: { result: { __typename: "Tweet", rest_id: "77", core: { user_results: { result: { __typename: "User", rest_id: "1", core: { screen_name: "me", name: "Me" }, legacy: {} } } }, legacy: { full_text: "hi" } } } } } },
    }));
    const c = client(impl, web({ CreateTweet: { id: "C", name: "CreateTweet", kind: "mutation", source: "classic" } }));
    const t = await api.createTweet(c, { text: "hi", replyTo: "5", mediaIds: ["m1"] });
    expect(t).toMatchObject({ id: "77", url: "https://x.com/me/status/77", text: "hi" });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.variables.reply).toEqual({ in_reply_to_tweet_id: "5", exclude_reply_user_ids: [] });
    expect(body.variables.media.media_entities).toEqual([{ media_id: "m1", tagged_users: [] }]);
  });

  test("paginate follows cursors and stops when exhausted", async () => {
    const pages = [
      { items: [{ id: "1" }, { id: "2" }], bottomCursor: "c1", skipped: [] },
      { items: [{ id: "2" }, { id: "3" }], bottomCursor: "c2", skipped: [] },
      { items: [], bottomCursor: "c2", skipped: [] },
    ];
    const cursors: Array<string | undefined> = [];
    const res = await api.paginate(10, async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1]!;
    });
    expect(res.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(res.exhausted).toBe(true);
    expect(cursors).toEqual([undefined, "c1", "c2"]);
    // Never trimmed, so the cursor does not skip anything.
    const limited = await api.paginate(1, async () => pages[0]!);
    expect(limited).toEqual({ items: [{ id: "1" }, { id: "2" }], exhausted: false, nextCursor: "c1" });
  });

  test("paginate keeps going past pages that only had ads/tombstones", async () => {
    const pages = [
      { items: [{ id: "1" }], bottomCursor: "c1", skipped: [] },
      { items: [], bottomCursor: "c2", skipped: [{ reason: "Tombstone" }] },
      { items: [{ id: "2" }], bottomCursor: "c3", skipped: [] },
      { items: [], bottomCursor: "c4", skipped: [] },
      { items: [], bottomCursor: "c5", skipped: [] },
      { items: [], bottomCursor: "c6", skipped: [] },
    ];
    let n = 0;
    const res = await api.paginate(10, async () => pages[n++]!);
    expect(res.items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(res.exhausted).toBe(false);
    expect(res.nextCursor).toBe("c6");
  });

  test("errors next to an empty data object are failures, not success", async () => {
    const { impl } = fakeFetch(() => ({ status: 200, body: { data: {}, errors: [{ message: "Authorization: Denied by access control: Missing LdapGroup(...). (344)" }] } }));
    const c = client(impl, web({ CreateRetweet: { id: "R", name: "CreateRetweet", kind: "mutation", args: ["tweetId"], source: "relay" } }));
    await expect(api.toggle(c, "retweet", "1", true)).rejects.toMatchObject({ code: "DAILY_LIMIT" });
    const { impl: ok } = fakeFetch(() => ({ body: { data: { create_retweet: { retweet_results: { result: { rest_id: "9" } } } }, errors: [{ message: "minor" }] } }));
    const c2 = client(ok, web({ CreateRetweet: { id: "R", name: "CreateRetweet", kind: "mutation", args: ["tweetId"], source: "relay" } }));
    expect(await api.toggle(c2, "retweet", "1", true)).toMatchObject({ ok: true });
  });

  test("an error next to an empty mutation skeleton is a failure", async () => {
    const { impl } = fakeFetch(() => ({ body: { data: { delete_tweet: { tweet_results: {} } }, errors: [{ code: 144, message: "No status found" }] } }));
    const c = client(impl, web({ DeleteTweet: { id: "D", name: "DeleteTweet", kind: "mutation", source: "classic" } }));
    await expect(api.deleteTweet(c, "1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { impl: done } = fakeFetch(() => ({ body: { data: { favorite_tweet: "Done" } } }));
    const c2 = client(done, web({ FavoriteTweet: { id: "F", name: "FavoriteTweet", kind: "mutation", source: "classic" } }));
    expect(await api.toggle(c2, "like", "1", true)).toMatchObject({ ok: true });
  });

  test("a mutation is not resent when the refreshed operation id is the same", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 404, body: "" }));
    const c = client(impl, web({ CreateTweet: { id: "C", name: "CreateTweet", kind: "mutation", source: "classic" } }));
    await expect(api.createTweet(c, { text: "hi" })).rejects.toMatchObject({ status: 404 });
    // one POST per base; the failed refresh must not add more
    expect(calls.filter((x) => x.init.method === "POST")).toHaveLength(2);
  });

  test("never sends the session to another host", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: {} }));
    const c = client(impl, web({}));
    await expect(c.request("https://evil.example/1.1/account/settings.json")).rejects.toMatchObject({ code: "USAGE" });
    await expect(c.request("http://x.com/i/api/x")).rejects.toMatchObject({ code: "USAGE" });
    expect(calls).toHaveLength(0);
  });
});

describe("cli", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((s) => void out.push(String(s)));
    const error = spyOn(console, "error").mockImplementation((s) => void err.push(String(s)));
    try {
      const code = await main(argv, { client: client(fakeFetch(() => ({ body: {} })).impl, web({})) });
      return { code, out: out.join("\n"), err: err.join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };

  test("post --dry-run splits a thread and reports lengths without calling X", async () => {
    const r = await run(["post", "--dry-run", "最初\n---\n次 https://example.com"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ dryRun: true, posts: [{ text: "最初", weightedLength: 4 }, { text: "次 https://example.com", weightedLength: 26 }], thread: 2 });
    const single = await run(["post", "--dry-run", "--no-thread", "a\n---\nb"]);
    expect(JSON.parse(single.out).posts).toEqual([{ text: "a\n---\nb", weightedLength: 7 }]);
  });

  test("dry-run validates media the same way a real post does", async () => {
    const missing = await run(["post", "--dry-run", "hi", "--media", "/nope/a.png"]);
    expect(missing.code).toBe(2);
    const ext = await run(["post", "--dry-run", "hi", "--media", "a.bmp"]);
    expect(JSON.parse(ext.err).error.message).toMatch(/Unsupported/);
    const alts = await run(["post", "--dry-run", "hi", "--alt", "x"]);
    expect(JSON.parse(alts.err).error.message).toMatch(/right after the --media/);
  });

  test("a thread that fails part-way reports what was already published", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n++;
      if (n === 3) return { status: 429, body: {} };
      return { body: { data: { create_tweet: { tweet_results: { result: { __typename: "Tweet", rest_id: String(100 + n), legacy: { full_text: "x" } } } } } } };
    });
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((s) => void out.push(String(s)));
    const error = spyOn(console, "error").mockImplementation((s) => void err.push(String(s)));
    try {
      const code = await main(["post", "one\n---\ntwo\n---\nthree\n---\nfour"], {
        client: client(impl, web({ CreateTweet: { id: "C", name: "CreateTweet", kind: "mutation", source: "classic" } })),
      });
      expect(code).toBe(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const e = JSON.parse(err.join("\n")).error;
    expect(e.code).toBe("PARTIAL_THREAD");
    expect(e.detail.published.map((p: any) => p.id)).toEqual(["101", "102"]);
    expect(e.detail.remaining).toEqual(["three", "four"]);
    expect(e.message).toContain("--reply-to 102");
  });

  test("raw refuses mutations unless explicitly allowed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((s) => void out.push(String(s)));
    const error = spyOn(console, "error").mockImplementation((s) => void err.push(String(s)));
    try {
      const code = await main(["raw", "DeleteTweet", "--vars", '{"tweet_id":"1"}'], {
        client: client(fakeFetch(() => ({ body: { data: { ok: 1 } } })).impl, web({ DeleteTweet: { id: "D", name: "DeleteTweet", kind: "mutation", source: "classic" } })),
      });
      expect(code).toBe(2);
      expect(err.join("")).toContain("--allow-mutation");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("too long posts fail with TOO_LONG", async () => {
    const r = await run(["post", "あ".repeat(141)]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error.code).toBe("TOO_LONG");
  });

  test("usage errors exit 2", async () => {
    expect((await run(["tweet"])).code).toBe(2);
    expect((await run(["search", "x", "--product", "bogus"])).code).toBe(2);
    const unknown = await run(["nope"]);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.err).error.code).toBe("USAGE");
    const badFlag = await run(["post", "--bogus"]);
    expect(JSON.parse(badFlag.err).error.code).toBe("USAGE");
    expect((await run(["user", "alice", "--limit", "1e2"])).code).toBe(2);
    // --help after -- is post text, not a help request.
    expect(JSON.parse((await run(["post", "--dry-run", "--", "--help"])).out).posts[0].text).toBe("--help");
  });
});
