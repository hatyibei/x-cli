import { describe, expect, test } from "bun:test";
import { Cubic, buildContext, floatToHex, roundHalfEven, frameRows, generateTransactionId, parseIndices } from "../src/transaction.ts";
import { classicChunkUrls, extractClassicOperations, extractRelayOperations, parseHomePage, relativeImports } from "../src/web.ts";

const FRAME = (seed: number) =>
  "M 10,30 " +
  Array.from({ length: 16 }, (_, r) => `C ${Array.from({ length: 11 }, (_, i) => ((seed + r * 13 + i * 37) % 256)).join(" ")} h 5 s 6,7 8,9 `).join("");

const HOME = `<html><head><meta name="twitter-site-verification" content="${Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 7 + 3) % 256)).toString("base64")}"/></head>
<body><script>window.__INITIAL_STATE__={"featureSwitch":{"defaultConfig":{"view_counts_everywhere_api_enabled":{"value":true},"verified_phone_label_enabled":{"value":false}}},"featureSwitchPayload":{"features":{"post_ctas_fetch_enabled":true}}}</script>
${[0, 1, 2, 3].map((n) => `<svg viewBox="0 0 24 24" id="loading-x-anim-${n}"><g><path d="M18 2z"></path><path d="${FRAME(n * 50)}"></path></g></svg>`).join("")}
<script src="https://abs.twimg.com/x-web/x-web/entry-client-ABC.js"></script>
<script>{"ondemand.s":"1a2b3c4d"}</script></body></html>`;

describe("parseHomePage", () => {
  test("extracts key, frames, features and scripts", () => {
    const h = parseHomePage(HOME);
    expect(h.verificationKey).toBeTruthy();
    expect(h.frames).toHaveLength(4);
    expect(h.frames[2]).toBe(FRAME(100));
    expect(h.featureValues).toEqual({ view_counts_everywhere_api_enabled: true, verified_phone_label_enabled: false, post_ctas_fetch_enabled: true });
    expect(h.scriptUrls).toEqual(["https://abs.twimg.com/x-web/x-web/entry-client-ABC.js"]);
    expect(h.chunkHashes).toEqual({ "ondemand.s": "1a2b3c4d" });
  });
});

describe("operation extraction", () => {
  test("classic main.js format", () => {
    const js = `e.exports={queryId:"abc-_1",operationName:"UserTweets",operationType:"query",metadata:{featureSwitches:["a_enabled","b_enabled"],fieldToggles:["withX"]}}`;
    expect(extractClassicOperations(js)).toEqual([
      { id: "abc-_1", name: "UserTweets", kind: "query", featureSwitches: ["a_enabled", "b_enabled"], fieldToggles: ["withX"], source: "classic" },
    ]);
  });

  test("relay format with hoisted argument definitions", () => {
    const js =
      "var a={defaultValue:null,kind:`LocalArgument`,name:`other`};x={params:{id:`ID0`,metadata:{},name:`Other`,operationKind:`query`,text:null}};" +
      "var e={defaultValue:null,kind:`LocalArgument`,name:`tweetId`},t={defaultValue:null,kind:`LocalArgument`,name:`engagementRequest`};" +
      "y={fragment:{argumentDefinitions:[e,t]},params:{id:`gWHQ-1`,metadata:{},name:`FavoriteTweet`,operationKind:`mutation`,text:null}}";
    const ops = extractRelayOperations(js);
    expect(ops.map((o) => [o.name, o.id, o.kind, o.args])).toEqual([
      ["Other", "ID0", "query", ["other"]],
      ["FavoriteTweet", "gWHQ-1", "mutation", ["tweetId", "engagementRequest"]],
    ]);
  });

  test("chunk references", () => {
    expect(relativeImports('import{a}from"./B1.js";import(`./C2.js`);x="./messages-ja-1.js"', "https://abs.twimg.com/x-web/x-web/assets/A.js")).toEqual([
      "https://abs.twimg.com/x-web/x-web/assets/B1.js",
      "https://abs.twimg.com/x-web/x-web/assets/C2.js",
    ]);
    expect(classicChunkUrls('{"endpoints.UsersGraphQL":"abc123"}', "https://abs.twimg.com/responsive-web/client-web/")).toEqual([
      "https://abs.twimg.com/responsive-web/client-web/endpoints.UsersGraphQL.abc123a.js",
    ]);
  });
});

describe("transaction id", () => {
  test("parseIndices", () => {
    expect(parseIndices("x(e[25],16)+y(e[46],16),z(t[17], 16)(e[5],16)")).toEqual({ rowIndex: 25, keyBytesIndices: [46, 17, 5] });
    expect(parseIndices("parseInt(abc[3],16)")).toBeNull();
    expect(parseIndices("nothing here")).toBeNull();
  });

  test("roundHalfEven matches Python's round()", () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, 127.5].map(roundHalfEven)).toEqual([0, 2, 2, 2, 3, 128]);
  });

  test("Cubic.value always terminates", () => {
    expect(typeof new Cubic([0.1, 0.2, 0.3, 0.4]).value(NaN)).toBe("number");
    expect(new Cubic([0.42, 0, 0.58, 1]).value(0.5)).toBeCloseTo(0.5, 3);
    expect(Number.isFinite(new Cubic([2, 0, 3, 1]).value(0.999999))).toBe(true);
    expect(() => floatToHex(Infinity)).toThrow();
  });

  test("floatToHex matches the reference implementation", () => {
    expect(floatToHex(255)).toBe("FF");
    expect(floatToHex(0.5)).toBe(".8");
    expect(floatToHex(16.25)).toBe("10.4");
  });

  test("frameRows splits path data into numeric rows", () => {
    const rows = frameRows(FRAME(0));
    expect(rows).toHaveLength(16);
    expect(rows[0]!.slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => (i * 37) % 256));
  });

  test("generates a deterministic, decodable id", () => {
    const home = parseHomePage(HOME);
    const ctx = buildContext({ key: home.verificationKey!, frames: home.frames, rowIndex: 25, keyBytesIndices: [46, 17, 5] });
    expect(ctx.animationKey).toMatch(/^[0-9a-f]+$/);
    const id = generateTransactionId(ctx, "GET", "/i/api/graphql/x/UserTweets", { nowMs: 1_800_000_000_000, random: 7 });
    expect(id).toBe(generateTransactionId(ctx, "GET", "/i/api/graphql/x/UserTweets", { nowMs: 1_800_000_000_000, random: 7 }));
    const bytes = [...Buffer.from(id, "base64")];
    expect(bytes[0]).toBe(7);
    // 1 random + 48 key + 4 time + 16 hash + 1 constant
    expect(bytes).toHaveLength(70);
    expect(bytes.slice(1, 49).map((b) => b ^ 7)).toEqual(ctx.keyBytes);
    expect(bytes[69]! ^ 7).toBe(3);
    expect(generateTransactionId(ctx, "POST", "/i/api/graphql/x/UserTweets", { nowMs: 1_800_000_000_000, random: 7 })).not.toBe(id);
  });
});
