/**
 * Discovery of x.com's web client internals: GraphQL operation IDs, feature switches and the
 * inputs of the transaction-id generator. X rotates these often, so x-cli reads them from the
 * live web bundle instead of hard-coding them, and caches the result.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./session.ts";
import { debug } from "./errors.ts";
import { parseIndices } from "./transaction.ts";

export interface Operation {
  id: string;
  name: string;
  kind: "query" | "mutation" | "subscription";
  /** Classic web client: feature switches the operation expects in `features`. */
  featureSwitches?: string[];
  fieldToggles?: string[];
  /** Relay client: argument names (variables) the operation declares. */
  args?: string[];
  source: "classic" | "relay" | "fallback";
}

export interface HomePage {
  verificationKey?: string;
  frames: string[];
  featureValues: Record<string, boolean>;
  scriptUrls: string[];
  /** webpack-style chunk name -> hash map (classic client). */
  chunkHashes: Record<string, string>;
}

export interface WebCache {
  version: 1;
  fetchedAt: string;
  operations: Record<string, Operation>;
  featureValues: Record<string, boolean>;
  tx?: { rowIndex: number; keyBytesIndices: number[] };
  scannedFiles: number;
}

const CACHE_TTL_MS = Number(process.env.X_CLI_CACHE_TTL_MS ?? 12 * 3600 * 1000);
const MAX_FILES = Number(process.env.X_CLI_MAX_SCAN_FILES ?? 4000);
const DISCOVERY_BUDGET_MS = 90_000;
const CONCURRENCY = 24;

/**
 * Operation IDs seen in x.com's bundle on 2026-11-18. Used only when discovery fails;
 * they will go stale.
 */
export const FALLBACK_OPERATIONS: Record<string, Operation> = Object.fromEntries(
  (
    [
      ["CreateTweet", "JLKEgZjJeqmwOJjC78Rwhg", "mutation", ["attachment_url", "batch_compose", "card_uri", "cashtag_attachment_options", "content_disclosure_options", "conversation_control", "edit_options", "engagement_request", "exclusive_tweet_control_options", "geo", "isEdit", "media", "premium_tweet_control_options", "reply", "semantic_annotation_ids", "semantic_annotation_options", "tweet_text", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider"]],
      ["FavoriteTweet", "gWHQmsY1Atd_XuOoMR2v5A", "mutation", ["engagementRequest", "tweetId"]],
      ["likeButtonControlUnfavoriteMutation", "jd_5MSDRzKH4MJ3c4BmrqQ", "mutation", ["engagementRequest", "tweetId"]],
      ["CreateRetweet", "lBRHQaQKWQwF0eaGzH209w", "mutation", ["engagementRequest", "tweetId"]],
      ["retweetButtonUnretweetMutation", "TSIYEnua4u_yleM5nrWzFw", "mutation", ["tweetId"]],
      ["BookmarkAdd", "9559L3Eb62SZndMSVHIeNw", "mutation", ["folderId", "tweetId"]],
      ["BookmarkDelete", "jTTS9lZmxUq-eYwmY8pHiA", "mutation", ["tweetId"]],
      ["deleteTweetMutation", "6DqoQrCrai4VWFRVzm9pDg", "mutation", ["tweetId"]],
      ["TweetDetail", "wYZm9S8HMLYJu88HdNI8fQ", "query", ["cursor", "focalTweetId", "rankingMode", "referrer", "withFocalTweet", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["HomeTimeline", "DR6r_R_zsb-rgnNDQdQhhg", "query", ["count", "cursor", "requestContext", "seenTweetIds", "tag", "topicIds", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["TweetResultByRestId", "T9pF_JQAreIoqn0HjHrUjg", "query", []],
      ["UserByScreenName", "vvsod6CckxF5dpGoGO1pDw", "query", ["screenName", "withIdentity", "__relay_internal__pv__xclientsfeaturesappviewercansendmoneyrelayprovider", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider"]],
      ["UserTweets", "AShxlJwsIFALlV5nN-TmUw", "query", ["count", "cursor", "screenName", "sortByMostLiked", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["UserRepliesTimeline", "ZfTZkgKGR6qHH7OeJvU8og", "query", ["count", "cursor", "screenName", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["SearchByRawQuery", "LRnMihIvuGbvMYvwFDheZw", "query", ["count", "cursor", "product", "querySource", "rawQuery", "withMediaGridTweet", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["followersQuery", "wClbeMd13vq4zCEKE8vyxQ", "query", ["count", "cursor", "screenName", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["followingQuery", "J_q3EbS-2yAvawwv1kQpWQ", "query", ["count", "cursor", "screenName", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["tweetFavoritersQuery", "8LsjZC2NsJXUOYdFUc4cjA", "query", ["count", "cursor", "enableRanking", "tweetId", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["tweetRetweetersQuery", "qaa_Nc4GydnVOW0FouXfnw", "query", ["count", "cursor", "enableRanking", "tweetId", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["likesQuery", "hXibXDiXSTFbRIZzek3Deg", "query", ["count", "cursor", "userId", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
      ["BookmarkTimeline", "tBDOyYfnuB07j_kX4_KvqA", "query", ["count", "cursor", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]],
    ] as Array<[string, string, Operation["kind"], string[]]>
  ).map(([name, id, kind, args]) => [name, { id, name, kind, args, source: "fallback" as const }]),
);

export const cachePath = () => join(configDir(), "web-cache.json");

export async function readCache(): Promise<WebCache | null> {
  try {
    const c = JSON.parse(await readFile(cachePath(), "utf8")) as WebCache;
    return c.version === 1 ? c : null;
  } catch {
    return null;
  }
}

export function isFresh(c: WebCache, now = Date.now()): boolean {
  return now - Date.parse(c.fetchedAt) < CACHE_TTL_MS && Object.keys(c.operations).length > 0;
}

export async function writeCache(c: WebCache): Promise<void> {
  await mkdir(dirname(cachePath()), { recursive: true, mode: 0o700 });
  await writeFile(cachePath(), JSON.stringify(c));
}

// ---------------------------------------------------------------- parsing

function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
}

export function parseHomePage(html: string): HomePage {
  const key =
    html.match(/name=["']twitter-site-verification["'][^>]*content=["']([^"']+)["']/)?.[1] ??
    html.match(/content=["']([^"']+)["'][^>]*name=["']twitter-site-verification["']/)?.[1];

  const frames: string[] = [];
  for (const m of html.matchAll(/<svg[^>]*id=["']loading-x-anim-(\d+)["'][^>]*>([\s\S]*?)<\/svg>/g)) {
    const ds = [...m[2]!.matchAll(/\sd=["']([^"']+)["']/g)].map((d) => decodeAttr(d[1]!));
    if (ds[1]) frames[Number(m[1])] = ds[1];
  }

  const featureValues: Record<string, boolean> = {};
  // classic: "name":{"value":true}
  for (const m of html.matchAll(/"([a-z0-9_]+)":\{"value":(true|false)\}/g)) featureValues[m[1]!] = m[2] === "true";
  // new client: "featureSwitchPayload":{"features":{"name":true,...}}
  const payload = html.match(/"featureSwitchPayload":\{"features":\{([^{}]*)\}/)?.[1];
  if (payload) for (const m of payload.matchAll(/"([a-z0-9_]+)":(true|false)/g)) featureValues[m[1]!] = m[2] === "true";

  const scriptUrls = [
    ...new Set(
      [...html.matchAll(/https:\/\/abs\.twimg\.com\/(?:responsive-web\/client-web(?:-legacy)?|x-web\/x-web)\/[^"'\s<>]+?\.js/g)].map((m) => m[0]),
    ),
  ];

  const chunkHashes: Record<string, string> = {};
  for (const m of html.matchAll(/["']((?:ondemand|endpoints|main|vendor)\.[\w.]+)["']\s*:\s*["']([0-9a-f]{5,})["']/g)) {
    chunkHashes[m[1]!] = m[2]!;
  }

  return { verificationKey: key, frames, featureValues, scriptUrls, chunkHashes };
}

/** Classic web client: `queryId:"..",operationName:"..",operationType:"..",metadata:{featureSwitches:[..],fieldToggles:[..]}` */
export function extractClassicOperations(js: string): Operation[] {
  const out: Operation[] = [];
  const re =
    /queryId:\s*["']([\w-]+)["'],\s*operationName:\s*["'](\w+)["'],\s*operationType:\s*["'](\w+)["'](?:,\s*metadata:\s*\{\s*featureSwitches:\s*\[([^\]]*)\](?:,\s*fieldToggles:\s*\[([^\]]*)\])?)?/g;
  const list = (s?: string) => (s ? [...s.matchAll(/["'](\w+)["']/g)].map((m) => m[1]!) : []);
  for (const m of js.matchAll(re)) {
    out.push({
      id: m[1]!,
      name: m[2]!,
      kind: m[3] as Operation["kind"],
      featureSwitches: list(m[4]),
      fieldToggles: list(m[5]),
      source: "classic",
    });
  }
  return out;
}

/** Relay client: `params:{id:`..`,metadata:{},name:`..`,operationKind:`..`` plus the LocalArgument names before it. */
export function extractRelayOperations(js: string): Operation[] {
  const out: Operation[] = [];
  const re = /params:\s*\{\s*id:\s*[`"']([\w-]+)[`"'],\s*metadata:\s*\{[^}]*\},\s*name:\s*[`"'](\w+)[`"'],\s*operationKind:\s*[`"'](\w+)[`"']/g;
  let prevEnd = 0;
  for (const m of js.matchAll(re)) {
    const start = Math.max(prevEnd, m.index! - 60000);
    // Argument definitions are hoisted into local vars (`var e={kind:"LocalArgument",name:"tweetId"}`)
    // between the previous operation and this one.
    const scope = js.slice(start, m.index!);
    const args = [...new Set([...scope.matchAll(/kind:\s*[`"']LocalArgument[`"'],\s*name:\s*[`"'](\w+)[`"']/g)].map((a) => a[1]!))];
    out.push({ id: m[1]!, name: m[2]!, kind: m[3] as Operation["kind"], args, source: "relay" });
    prevEnd = m.index! + m[0].length;
  }
  return out;
}

/** Relative chunk imports inside an ES module chunk (`"./X.js"`, `./assets/X.js`). */
export function relativeImports(js: string, fileUrl: string): string[] {
  const out = new Set<string>();
  for (const m of js.matchAll(/["'`](\.{1,2}\/[\w./-]+?\.js)["'`]/g)) {
    const spec = m[1]!;
    if (/messages-|\/i18n\/|\.css/.test(spec)) continue;
    out.add(new URL(spec, fileUrl).toString());
  }
  return [...out];
}

/** Classic webpack chunk references (`"endpoints.UsersGraphQL":"abc123"`). */
export function classicChunkUrls(text: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/["']((?:endpoints|ondemand)\.[\w.]+)["']\s*:\s*["']([0-9a-f]{5,})["']/g)) {
    out.add(new URL(`${m[1]}.${m[2]}a.js`, baseUrl).toString());
  }
  return [...out];
}

// ---------------------------------------------------------------- crawling

export interface DiscoveryResult extends WebCache {
  home: HomePage;
}

/**
 * Crawl the web bundle starting from the home page's scripts and collect every GraphQL
 * operation and the transaction-id generator indices.
 */
export async function discover(fetchText: (url: string) => Promise<string>, homeHtml: string): Promise<DiscoveryResult> {
  const home = parseHomePage(homeHtml);
  const queue: string[] = [...home.scriptUrls];
  const classicBase = "https://abs.twimg.com/responsive-web/client-web/";
  if (Object.keys(home.chunkHashes).length) queue.push(...classicChunkUrls(homeHtml, classicBase));
  const seen = new Set<string>();
  const operations: Record<string, Operation> = {};
  let tx: WebCache["tx"];

  const handle = (url: string, js: string) => {
    for (const op of [...extractClassicOperations(js), ...extractRelayOperations(js)]) {
      const prev = operations[op.name];
      // Prefer classic definitions (they carry features) over relay ones with the same name.
      if (!prev || (prev.source === "relay" && op.source === "classic")) operations[op.name] = op;
    }
    // The generator chunk: `ondemand.s.*.js` in the classic client, the chunk with the epoch constant in the new one.
    if (/ondemand\.s/.test(url) || js.includes("1682924400")) tx = parseIndices(js) ?? tx;
    for (const next of [...relativeImports(js, url), ...classicChunkUrls(js, classicBase)]) {
      if (!seen.has(next)) queue.push(next);
    }
  };

  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  debug(`discover: start, ${queue.length} entry scripts`);
  while (queue.length && seen.size < MAX_FILES) {
    if (Date.now() > deadline) {
      debug(`discover: time budget hit after ${seen.size} files`);
      break;
    }
    const batch: string[] = [];
    while (queue.length && batch.length < CONCURRENCY) {
      const u = queue.shift()!;
      if (seen.has(u)) continue;
      seen.add(u);
      batch.push(u);
    }
    const texts = await Promise.all(batch.map((u) => fetchText(u).catch(() => "")));
    batch.forEach((u, i) => {
      if (!texts[i]) return;
      const t = Date.now();
      handle(u, texts[i]!);
      if (Date.now() - t > 500) debug(`discover: slow parse ${Date.now() - t}ms ${u} (${texts[i]!.length} chars)`);
    });
    debug(`discover: ${seen.size} files, ${Object.keys(operations).length} ops, queue ${queue.length}`);
  }

  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    operations,
    featureValues: home.featureValues,
    tx,
    scannedFiles: seen.size,
    home,
  };
}
