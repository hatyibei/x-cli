#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/errors.ts
function debug(msg) {
  if (process.env.X_CLI_DEBUG)
    process.stderr.write(`[x-cli +${Date.now() - T0}ms] ${msg}
`);
}
var CliError, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), T0;
var init_errors = __esm(() => {
  CliError = class CliError extends Error {
    code;
    status;
    detail;
    constructor(code, message, opts = {}) {
      super(message);
      this.code = code;
      this.status = opts.status;
      this.detail = opts.detail;
    }
  };
  T0 = Date.now();
});

// src/text.ts
function weightedLength(text) {
  let len = 0;
  const replaceUrl = (url) => {
    const trailing = url.match(TRAILING_PUNCT)?.[0] ?? "";
    len += URL_LENGTH;
    return `\x00${trailing}`;
  };
  const rest = text.normalize("NFC").replace(URL_RE, replaceUrl).replace(BARE_DOMAIN_RE, replaceUrl);
  for (const { segment } of segmenter.segment(rest)) {
    if (segment === "\x00")
      continue;
    const cps = [...segment].map((c) => c.codePointAt(0));
    if (cps.length > 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)) {
      len += 2;
      continue;
    }
    for (const cp of cps) {
      if (cp === 65039 || cp === 8205)
        continue;
      len += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return len;
}
function splitThread(text, thread = true) {
  const body = text.replace(/^\uFEFF/, "");
  if (!thread)
    return body.trim() ? [body.trim()] : [];
  return body.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
}
function checkLength(posts, allowLong) {
  const report = posts.map((p, index) => ({ index, weightedLength: weightedLength(p) }));
  if (!allowLong) {
    const over = report.filter((r) => r.weightedLength > MAX_WEIGHTED_LENGTH);
    if (over.length) {
      throw new CliError("TOO_LONG", `Post ${over.map((o) => `#${o.index + 1} (${o.weightedLength})`).join(", ")} exceeds ${MAX_WEIGHTED_LENGTH} weighted characters (Japanese characters count 2). Shorten it, split it with a '---' line, or pass --long if the account has Premium.`, { detail: report });
    }
  }
  return report;
}
function tweetId(input) {
  const s = input.trim();
  if (/^\d{1,20}$/.test(s))
    return s;
  const m = s.match(new RegExp(`${HOST}\\/(?:\\w{1,15}|i(?:\\/web)?)\\/status(?:es)?\\/(\\d{1,20})(?=[/?#]|$)`));
  if (m)
    return m[1];
  throw new CliError("USAGE", `Not a post ID or URL: ${input}`);
}
function screenName(input) {
  const s = input.trim();
  const m = s.match(new RegExp(`${HOST}\\/@?(\\w+)(?=[/?#]|$)`));
  if (!m && /[/.]/.test(s))
    throw new CliError("USAGE", `Not a profile URL: ${input}`);
  const name = (m ? m[1] : s).replace(/^@/, "");
  if (m && RESERVED.has(name.toLowerCase()))
    throw new CliError("USAGE", `Not a profile URL: ${input}`);
  if (!/^\w{1,15}$/.test(name))
    throw new CliError("USAGE", `Not a valid screen name: ${input}`);
  return name;
}
var MAX_WEIGHTED_LENGTH = 280, URL_LENGTH = 23, URL_RE, URL_PATH, GTLDS = "com|net|org|edu|gov|mil|int|info|biz|name|pro|aero|coop|museum|mobi|asia|tel|travel|jobs|app|dev|xyz|news|blog|tech|site|shop|page|online|store|cloud|live|art|media|world|top|club|link|space|website|design|studio|life|today|games|wiki", BARE_DOMAIN_RE, TRAILING_PUNCT, LIGHT_RANGES, segmenter, HOST, RESERVED;
var init_text = __esm(() => {
  init_errors();
  URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
  URL_PATH = String.raw`[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*`;
  BARE_DOMAIN_RE = new RegExp(String.raw`(?<![\w@.\-/])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:(?:${GTLDS})(?![a-z0-9-])(?:\/${URL_PATH})?|[a-z]{2}(?![a-z0-9-])\/${URL_PATH})`, "gi");
  TRAILING_PUNCT = /[.,!?:;'")\]]+$/;
  LIGHT_RANGES = [
    [0, 4351],
    [8192, 8205],
    [8208, 8223],
    [8242, 8247]
  ];
  segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  HOST = String.raw`^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com`;
  RESERVED = new Set(["i", "home", "intent", "search", "settings", "explore", "notifications", "messages", "compose", "hashtag", "share", "login", "logout", "tos", "privacy"]);
});

// src/analyze.ts
function stats(values) {
  if (!values.length)
    return { count: 0, mean: 0, median: 0, p90: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return {
    count: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    median: round(q(0.5)),
    p90: round(q(0.9)),
    max: s[s.length - 1]
  };
}
function localParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  return {
    weekday: parts.find((p) => p.type === "weekday")?.value ?? "?",
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0)
  };
}
function group(tweets, key) {
  const m = new Map;
  for (const t of tweets) {
    const k = key(t);
    if (k === undefined)
      continue;
    if (!m.has(k))
      m.set(k, []);
    m.get(k).push(t.likeCount);
  }
  return m;
}
function analyzeTweets(all, opts = {}) {
  const top = opts.top ?? 10;
  const timeZone = opts.timeZone ?? process.env.X_CLI_TZ ?? "Asia/Tokyo";
  const tweets = all.filter((t) => !t.isRetweet);
  const withViews = tweets.filter((t) => t.viewCount && t.viewCount > 0);
  const compare = (label, pred) => {
    const yes = tweets.filter(pred);
    const no = tweets.filter((t) => !pred(t));
    return { feature: label, with: { count: yes.length, medianLikes: median(yes.map((t) => t.likeCount)) }, without: { count: no.length, medianLikes: median(no.map((t) => t.likeCount)) } };
  };
  const lengthBucket = (t) => {
    const n = weightedLength(t.text);
    return n <= 50 ? "0-50" : n <= 100 ? "51-100" : n <= 180 ? "101-180" : n <= 280 ? "181-280" : "281+";
  };
  const byLength = [...group(tweets, lengthBucket)].map(([bucket, v]) => ({ bucket, count: v.length, medianLikes: median(v) }));
  const byWeekday = [...group(tweets, (t) => t.createdAt ? localParts(t.createdAt, timeZone).weekday : undefined)].map(([weekday, v]) => ({ weekday, count: v.length, medianLikes: median(v) })).sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday));
  const byHour = [...group(tweets, (t) => t.createdAt ? localParts(t.createdAt, timeZone).hour : undefined)].map(([hour, v]) => ({ hour, count: v.length, medianLikes: median(v) })).sort((a, b) => a.hour - b.hour);
  const tagCount = new Map;
  for (const t of tweets) {
    for (const h of new Set(t.hashtags.map((x) => x.toLowerCase()))) {
      const e = tagCount.get(h) ?? { count: 0, likes: [] };
      e.count++;
      e.likes.push(t.likeCount);
      tagCount.set(h, e);
    }
  }
  const authorCount = new Map;
  for (const t of tweets) {
    const e = authorCount.get(t.author.screenName) ?? { screenName: t.author.screenName, name: t.author.name, followers: t.author.followers, count: 0, likes: 0 };
    e.count++;
    e.likes += t.likeCount;
    authorCount.set(t.author.screenName, e);
  }
  return {
    sample: { total: all.length, analyzed: tweets.length, retweetsExcluded: all.length - tweets.length, timeZone },
    likes: stats(tweets.map((t) => t.likeCount)),
    retweets: stats(tweets.map((t) => t.retweetCount)),
    replies: stats(tweets.map((t) => t.replyCount)),
    bookmarks: stats(tweets.map((t) => t.bookmarkCount)),
    views: stats(withViews.map((t) => t.viewCount)),
    engagementRate: {
      note: "(likes + retweets + replies + quotes) / views, posts with view counts only",
      ...stats(withViews.map((t) => round(engagements(t) / t.viewCount * 100, 3))),
      unit: "%"
    },
    features: [
      compare("media", (t) => t.media.length > 0),
      compare("link", (t) => t.urls.length > 0),
      compare("hashtag", (t) => t.hashtags.length > 0),
      compare("reply", (t) => t.isReply),
      compare("quote", (t) => t.isQuote),
      compare("question", (t) => /[?\uFF1F]/.test(t.text))
    ],
    textLength: byLength,
    publishTime: { byWeekday, byHour },
    topHashtags: [...tagCount].map(([tag, e]) => ({ tag, count: e.count, medianLikes: median(e.likes) })).sort((a, b) => b.count - a.count).slice(0, top),
    topAuthors: [...authorCount.values()].sort((a, b) => b.likes - a.likes).slice(0, top),
    topTweets: [...tweets].sort((a, b) => b.likeCount - a.likeCount).slice(0, top).map((t) => ({ url: t.url, author: t.author.screenName, text: t.text.slice(0, 140), likeCount: t.likeCount, retweetCount: t.retweetCount, viewCount: t.viewCount, createdAt: t.createdAt }))
  };
}
var round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d, median = (v) => stats(v).median, WEEKDAYS, engagements = (t) => t.likeCount + t.retweetCount + t.replyCount + t.quoteCount;
var init_analyze = __esm(() => {
  init_text();
  WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
});

// src/session.ts
import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
function configDir() {
  if (process.env.X_CLI_HOME)
    return process.env.X_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "x-cli");
}
function parseCookieHeader(header) {
  const out = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0)
      continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name)
      out[name] = value;
  }
  return out;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
function hasAuth(cookies) {
  return !!cookies?.auth_token && !!cookies?.ct0;
}
async function loadSession() {
  if (process.env.X_COOKIE)
    return { cookies: parseCookieHeader(process.env.X_COOKIE), savedAt: "env" };
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return null;
    throw e;
  }
}
async function saveSession(session) {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  await chmod(dirname(path), 448).catch(() => {});
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, JSON.stringify(session, null, 2), { mode: 384, flag: "wx" });
  await rename(tmp, path);
  return path;
}
async function clearSession() {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if (e.code === "ENOENT")
      return false;
    throw e;
  }
}
var sessionPath = () => join(configDir(), "session.json");
var init_session = () => {};

// src/throttle.ts
import { mkdir as mkdir2, open, readFile as readFile2, rm as rm2, stat, writeFile as writeFile2 } from "fs/promises";
import { join as join2 } from "path";
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function throttleAcrossProcesses(minGapMs) {
  if (!Number.isFinite(minGapMs) || minGapMs <= 0)
    return;
  const dir = configDir();
  const stamp = join2(dir, "last-request");
  const lock = join2(dir, "last-request.lock");
  await mkdir2(dir, { recursive: true, mode: 448 }).catch(() => {});
  for (;; ) {
    let handle;
    try {
      handle = await open(lock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") {
        await sleep(minGapMs);
        return;
      }
      const owner = Number(await readFile2(lock, "utf8").catch(() => ""));
      const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? Date.now());
      if (owner > 0 && !alive(owner) || !owner && age > 5000)
        await rm2(lock, { force: true });
      await sleep(100);
      continue;
    }
    try {
      await handle.writeFile(String(process.pid));
      const last = Number(await readFile2(stamp, "utf8").catch(() => "0")) || 0;
      const wait = last + minGapMs - Date.now();
      if (wait > 0)
        await sleep(Math.min(wait, minGapMs));
      await writeFile2(stamp, String(Date.now()));
      return;
    } finally {
      await handle.close();
      await rm2(lock, { force: true });
    }
  }
}
var init_throttle = __esm(() => {
  init_errors();
  init_session();
});

// src/transaction.ts
import { createHash } from "crypto";
function parseIndices(js) {
  const found = [...js.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map((m) => Number(m[1]));
  if (found.length < 3)
    return null;
  return { rowIndex: found[0], keyBytesIndices: found.slice(1) };
}
function base64ToBytes(b64) {
  return [...Buffer.from(b64, "base64")];
}
function roundHalfEven(n) {
  const f = Math.floor(n);
  const diff = n - f;
  if (diff > 0.5)
    return f + 1;
  if (diff < 0.5)
    return f;
  return f % 2 === 0 ? f : f + 1;
}
function jsRound(n) {
  return Math.floor(n + 0.5);
}
function solve(value, min, max, rounding) {
  const r = value * (max - min) / 255 + min;
  return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
}

class Cubic {
  c;
  constructor(c) {
    this.c = c;
  }
  static calc(a, b, m) {
    return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m;
  }
  value(t) {
    const c = this.c;
    if (t <= 0) {
      let g = 0;
      if (c[0] > 0)
        g = c[1] / c[0];
      else if (c[1] === 0 && c[2] > 0)
        g = c[3] / c[2];
      return g * t;
    }
    if (t >= 1) {
      let g = 0;
      if (c[2] < 1)
        g = (c[3] - 1) / (c[2] - 1);
      else if (c[2] === 1 && c[0] < 1)
        g = (c[1] - 1) / (c[0] - 1);
      return 1 + g * (t - 1);
    }
    let start = 0;
    let end = 1;
    let mid = 0;
    for (let i = 0;i < 64 && start < end; i++) {
      mid = (start + end) / 2;
      const x = Cubic.calc(c[0], c[2], mid);
      if (Math.abs(t - x) < 0.00001)
        return Cubic.calc(c[1], c[3], mid);
      if (x < t)
        start = mid;
      else
        end = mid;
    }
    return Cubic.calc(c[1], c[3], mid);
  }
}
function floatToHex(input) {
  if (!Number.isFinite(input))
    throw new Error(`floatToHex: non-finite input ${input}`);
  let x = input;
  const result = [];
  let quotient = Math.trunc(x);
  let fraction = x - quotient;
  while (quotient > 0) {
    quotient = Math.trunc(x / 16);
    const remainder = Math.trunc(x - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    x = quotient;
  }
  if (fraction === 0)
    return result.join("");
  result.push(".");
  while (fraction > 0) {
    fraction *= 16;
    const integer = Math.trunc(fraction);
    fraction -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }
  return result.join("");
}
function animate(row, targetTime) {
  const fromColor = [...row.slice(0, 3), 1];
  const toColor = [...row.slice(3, 6), 1];
  const toRotation = [solve(row[6], 60, 360, true)];
  const curves = row.slice(7).map((v, i) => solve(v, i % 2 ? -1 : 0, 1, false));
  const val = new Cubic(curves).value(targetTime);
  const color = interpolate(fromColor, toColor, val).map((v) => v > 0 ? v : 0);
  const rotation = interpolate([0], toRotation, val)[0];
  const rad = rotation * Math.PI / 180;
  const matrix = [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
  const parts = color.slice(0, -1).map((v) => roundHalfEven(v).toString(16));
  for (const v of matrix) {
    let r = Math.round(v * 100) / 100;
    if (r < 0)
      r = -r;
    const hex = floatToHex(r);
    parts.push(hex.startsWith(".") ? `0${hex}`.toLowerCase() : hex || "0");
  }
  parts.push("0", "0");
  return parts.join("").replace(/[.-]/g, "");
}
function frameRows(d) {
  return d.slice(9).split("C").map((seg) => seg.replace(/[^\d]+/g, " ").trim().split(/\s+/).filter(Boolean).map(Number));
}
function buildContext(p) {
  const keyBytes = base64ToBytes(p.key);
  const totalTime = 4096;
  const rowIndex = keyBytes[p.rowIndex] % 16;
  let frameTime = p.keyBytesIndices.map((i) => keyBytes[i] % 16).reduce((a, b) => a * b, 1);
  frameTime = jsRound(frameTime / 10) * 10;
  const frame = p.frames[keyBytes[5] % 4];
  if (!frame)
    throw new Error("animation frame not found");
  const row = frameRows(frame)[rowIndex];
  if (!row)
    throw new Error("animation row not found");
  return { keyBytes, animationKey: animate(row, frameTime / totalTime) };
}
function generateTransactionId(ctx, method, path, opts = {}) {
  const timeNow = Math.floor(((opts.nowMs ?? Date.now()) - EPOCH_OFFSET_SEC * 1000) / 1000);
  const timeBytes = [0, 1, 2, 3].map((i) => timeNow >> i * 8 & 255);
  const keyword = opts.keyword ?? process.env.X_CLI_TX_KEYWORD ?? DEFAULT_KEYWORD;
  const hash = [...createHash("sha256").update(`${method}!${path}!${timeNow}${keyword}${ctx.animationKey}`).digest()];
  const rnd = opts.random ?? Math.floor(Math.random() * 256);
  const bytes = [...ctx.keyBytes, ...timeBytes, ...hash.slice(0, 16), ADDITIONAL_RANDOM_NUMBER];
  const out = Buffer.from([rnd, ...bytes.map((b) => b ^ rnd)]);
  return out.toString("base64").replace(/=+$/, "");
}
var DEFAULT_KEYWORD = "obfiowerehiring", ADDITIONAL_RANDOM_NUMBER = 3, EPOCH_OFFSET_SEC = 1682924400, interpolate = (from, to, f) => from.map((a, i) => a * (1 - f) + to[i] * f);
var init_transaction = () => {};

// src/web.ts
import { mkdir as mkdir3, readFile as readFile3, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname2, join as join3 } from "path";
async function readCache() {
  try {
    const c = JSON.parse(await readFile3(cachePath(), "utf8"));
    return c.version === 1 ? c : null;
  } catch {
    return null;
  }
}
function isFresh(c, now = Date.now()) {
  return now - Date.parse(c.fetchedAt) < CACHE_TTL_MS && Object.keys(c.operations).length > 0;
}
async function writeCache(c) {
  await mkdir3(dirname2(cachePath()), { recursive: true, mode: 448 });
  await writeFile3(cachePath(), JSON.stringify(c));
}
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
}
function parseHomePage(html) {
  const key = html.match(/name=["']twitter-site-verification["'][^>]*content=["']([^"']+)["']/)?.[1] ?? html.match(/content=["']([^"']+)["'][^>]*name=["']twitter-site-verification["']/)?.[1];
  const frames = [];
  for (const m of html.matchAll(/<svg[^>]*id=["']loading-x-anim-(\d+)["'][^>]*>([\s\S]*?)<\/svg>/g)) {
    const ds = [...m[2].matchAll(/\sd=["']([^"']+)["']/g)].map((d) => decodeAttr(d[1]));
    if (ds[1])
      frames[Number(m[1])] = ds[1];
  }
  const featureValues = {};
  for (const m of html.matchAll(/"([a-z0-9_]+)":\{"value":(true|false)\}/g))
    featureValues[m[1]] = m[2] === "true";
  const payload = html.match(/"featureSwitchPayload":\{"features":\{([^{}]*)\}/)?.[1];
  if (payload)
    for (const m of payload.matchAll(/"([a-z0-9_]+)":(true|false)/g))
      featureValues[m[1]] = m[2] === "true";
  const scriptUrls = [
    ...new Set([...html.matchAll(/https:\/\/abs\.twimg\.com\/(?:responsive-web\/client-web(?:-legacy)?|x-web\/x-web)\/[^"'\s<>]+?\.js/g)].map((m) => m[0]))
  ];
  const chunkHashes = {};
  for (const m of html.matchAll(/["']((?:ondemand|endpoints|main|vendor)\.[\w.]+)["']\s*:\s*["']([0-9a-f]{5,})["']/g)) {
    chunkHashes[m[1]] = m[2];
  }
  return { verificationKey: key, frames, featureValues, scriptUrls, chunkHashes };
}
function extractClassicOperations(js) {
  const out = [];
  const re = /queryId:\s*["']([\w-]+)["'],\s*operationName:\s*["'](\w+)["'],\s*operationType:\s*["'](\w+)["'](?:,\s*metadata:\s*\{\s*featureSwitches:\s*\[([^\]]*)\](?:,\s*fieldToggles:\s*\[([^\]]*)\])?)?/g;
  const list = (s) => s ? [...s.matchAll(/["'](\w+)["']/g)].map((m) => m[1]) : [];
  for (const m of js.matchAll(re)) {
    out.push({
      id: m[1],
      name: m[2],
      kind: m[3],
      featureSwitches: list(m[4]),
      fieldToggles: list(m[5]),
      source: "classic"
    });
  }
  return out;
}
function extractRelayOperations(js) {
  const out = [];
  const re = /params:\s*\{\s*id:\s*[`"']([\w-]+)[`"'],\s*metadata:\s*\{[^}]*\},\s*name:\s*[`"'](\w+)[`"'],\s*operationKind:\s*[`"'](\w+)[`"']/g;
  let prevEnd = 0;
  for (const m of js.matchAll(re)) {
    const start = Math.max(prevEnd, m.index - 60000);
    const scope = js.slice(start, m.index);
    const args = [...new Set([...scope.matchAll(/kind:\s*[`"']LocalArgument[`"'],\s*name:\s*[`"'](\w+)[`"']/g)].map((a) => a[1]))];
    out.push({ id: m[1], name: m[2], kind: m[3], args, source: "relay" });
    prevEnd = m.index + m[0].length;
  }
  return out;
}
function relativeImports(js, fileUrl) {
  const out = new Set;
  for (const m of js.matchAll(/["'`](\.{1,2}\/[\w./-]+?\.js)["'`]/g)) {
    const spec = m[1];
    if (/messages-|\/i18n\/|\.css/.test(spec))
      continue;
    out.add(new URL(spec, fileUrl).toString());
  }
  return [...out];
}
function classicChunkUrls(text, baseUrl) {
  const out = new Set;
  for (const m of text.matchAll(/["']((?:endpoints|ondemand)\.[\w.]+)["']\s*:\s*["']([0-9a-f]{5,})["']/g)) {
    out.add(new URL(`${m[1]}.${m[2]}a.js`, baseUrl).toString());
  }
  return [...out];
}
async function discover(fetchText, homeHtml) {
  const home = parseHomePage(homeHtml);
  const queue = [...home.scriptUrls];
  const classicBase = "https://abs.twimg.com/responsive-web/client-web/";
  if (Object.keys(home.chunkHashes).length)
    queue.push(...classicChunkUrls(homeHtml, classicBase));
  const seen = new Set;
  const operations = {};
  let tx;
  const handle = (url, js) => {
    for (const op of [...extractClassicOperations(js), ...extractRelayOperations(js)]) {
      const prev = operations[op.name];
      if (!prev || prev.source === "relay" && op.source === "classic")
        operations[op.name] = op;
    }
    if (/ondemand\.s/.test(url) || js.includes("1682924400"))
      tx = parseIndices(js) ?? tx;
    for (const next of [...relativeImports(js, url), ...classicChunkUrls(js, classicBase)]) {
      if (!seen.has(next))
        queue.push(next);
    }
  };
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  debug(`discover: start, ${queue.length} entry scripts`);
  while (queue.length && seen.size < MAX_FILES) {
    if (Date.now() > deadline) {
      debug(`discover: time budget hit after ${seen.size} files`);
      break;
    }
    const batch = [];
    while (queue.length && batch.length < CONCURRENCY) {
      const u = queue.shift();
      if (seen.has(u))
        continue;
      seen.add(u);
      batch.push(u);
    }
    const texts = await Promise.all(batch.map((u) => fetchText(u).catch(() => "")));
    batch.forEach((u, i) => {
      if (!texts[i])
        return;
      const t = Date.now();
      handle(u, texts[i]);
      if (Date.now() - t > 500)
        debug(`discover: slow parse ${Date.now() - t}ms ${u} (${texts[i].length} chars)`);
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
    home
  };
}
var CACHE_TTL_MS, MAX_FILES, DISCOVERY_BUDGET_MS = 90000, CONCURRENCY = 24, FALLBACK_OPERATIONS, cachePath = () => join3(configDir(), "web-cache.json");
var init_web = __esm(() => {
  init_session();
  init_errors();
  init_transaction();
  CACHE_TTL_MS = Number(process.env.X_CLI_CACHE_TTL_MS ?? 12 * 3600 * 1000);
  MAX_FILES = Number(process.env.X_CLI_MAX_SCAN_FILES ?? 4000);
  FALLBACK_OPERATIONS = Object.fromEntries([
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
    ["BookmarkTimeline", "tBDOyYfnuB07j_kX4_KvqA", "query", ["count", "cursor", "__relay_internal__pv__xclientsfeaturesappviewerisloggedinrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationgroktranslatedpostenabledrelayprovider", "__relay_internal__pv__replydownvoteenabledrelayprovider", "__relay_internal__pv__postctafetchenabledrelayprovider", "__relay_internal__pv__xclientsfeaturestweetcomponentsgrokanalyzepostrelayprovider", "__relay_internal__pv__xclientsfeaturestranslationnoteautotranslationenabledrelayprovider", "__relay_internal__pv__liveeventpostcontextenabledrelayprovider", "__relay_internal__pv__sportspostcontextenabledrelayprovider", "__relay_internal__pv__timelineuserbioautotranslationrelayprovider"]]
  ].map(([name, id, kind, args]) => [name, { id, name, kind, args, source: "fallback" }]));
});

// src/client.ts
function isTrustedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && TRUSTED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
function hasPayload(d, depth = 0) {
  if (d === null || d === undefined || depth > 20)
    return false;
  if (typeof d !== "object")
    return d !== "" && d !== false;
  for (const [k, v] of Object.entries(d)) {
    if (k === "__typename")
      continue;
    if (hasPayload(v, depth + 1))
      return true;
  }
  return false;
}
function adaptVariables(op, vars, loggedIn) {
  if (!op.args?.length)
    return vars;
  const args = new Set(op.args);
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined)
      continue;
    if (args.has(k))
      out[k] = v;
    else if (args.has(camel(k)))
      out[camel(k)] = v;
  }
  for (const a of op.args) {
    if (a in out)
      continue;
    if (a.startsWith("__relay_internal__pv__"))
      out[a] = loggedIn && /isloggedin/.test(a);
    else if (/^(with|include)[A-Z]/.test(a))
      out[a] = false;
  }
  return out;
}

class XClient {
  session;
  fetchImpl;
  minIntervalMs;
  lastRequestAt = 0;
  crossProcessThrottle;
  web = null;
  webRefreshed = false;
  discoveryError;
  tx;
  homeHtml;
  graphqlBase = GRAPHQL_BASES[0];
  constructor(opts = {}) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const envInterval = Number(process.env.X_CLI_INTERVAL_MS);
    this.minIntervalMs = opts.minIntervalMs ?? (Number.isFinite(envInterval) && envInterval >= 0 ? Math.min(envInterval, 60000) : 1000);
    if (opts.web !== undefined)
      this.web = opts.web;
    if (process.env.X_CLI_NO_TRANSACTION_ID || opts.transactionIds === false)
      this.tx = null;
    this.crossProcessThrottle = opts.crossProcessThrottle ?? !opts.fetchImpl;
  }
  async getSession() {
    if (this.session === undefined)
      this.session = await loadSession();
    return this.session;
  }
  async requireSession() {
    const s = await this.getSession();
    if (!s || !hasAuth(s.cookies)) {
      throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `x-cli auth login` (or `x-cli auth import`).");
    }
    return s;
  }
  async throttle(write) {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0)
      await sleep(wait);
    if (this.crossProcessThrottle)
      await throttleAcrossProcesses(write ? Math.max(this.minIntervalMs, 3000) : this.minIntervalMs);
    this.lastRequestAt = Date.now();
  }
  async fetchText(url, withCookies = false) {
    const headers = { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8" };
    if (withCookies) {
      const s = await this.getSession();
      if (s)
        headers.Cookie = cookieHeader(s.cookies);
    }
    const res = await this.fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!res.ok)
      throw new CliError("API_ERROR", `GET ${url} failed (${res.status})`, { status: res.status });
    return res.text();
  }
  async homePage() {
    this.homeHtml ??= await this.fetchText("https://x.com/home", false);
    return this.homeHtml;
  }
  async webInfo(refresh = false) {
    this.web ??= await readCache();
    if (this.web && (this.webRefreshed || !refresh && isFresh(this.web)))
      return this.web;
    if (this.webRefreshed && this.discoveryError)
      throw this.discoveryError;
    if (refresh)
      this.homeHtml = undefined;
    this.webRefreshed = true;
    try {
      const result = await discover((u) => this.fetchText(u), await this.homePage());
      const { home: _home, ...cache } = result;
      if (Object.keys(cache.operations).length === 0)
        throw new Error("no operations found in the web bundle");
      await writeCache(cache).catch(() => {});
      this.web = cache;
      if (this.tx)
        this.tx = undefined;
      return cache;
    } catch (e) {
      if (this.web)
        return this.web;
      this.discoveryError = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
  }
  async operation(names) {
    const list = Array.isArray(names) ? names : [names];
    const find = (w) => {
      for (const n of list)
        if (w?.operations[n])
          return w.operations[n];
      return;
    };
    let web = null;
    try {
      web = await this.webInfo();
    } catch {}
    let op = find(web);
    if (!op && !this.webRefreshed)
      op = find(await this.webInfo(true).catch(() => null));
    if (!op) {
      for (const n of list)
        if (FALLBACK_OPERATIONS[n])
          return FALLBACK_OPERATIONS[n];
    }
    if (!op) {
      throw new CliError("OPERATION_NOT_FOUND", `GraphQL operation ${list.join(" / ")} was not found in x.com's web client. Run \`x-cli ops --refresh\` to re-scan, or \`x-cli ops --grep <word>\` to look for a renamed one.`);
    }
    return op;
  }
  async transactionId(method, url) {
    if (this.tx === null)
      return;
    if (this.tx === undefined) {
      try {
        const web = await this.webInfo();
        const home = parseHomePage(await this.homePage());
        if (!web.tx || !home.verificationKey || home.frames.length < 4)
          throw new Error("missing inputs");
        debug("transaction id: building context");
        this.tx = buildContext({ key: home.verificationKey, frames: home.frames, ...web.tx });
        debug("transaction id: ready");
      } catch {
        this.tx = null;
        return;
      }
    }
    return generateTransactionId(this.tx, method, url.pathname);
  }
  async request(url, opts = {}) {
    return (await this.requestRaw(url, opts)).data;
  }
  async requestRaw(urlStr, opts = {}) {
    const method = opts.method ?? (opts.json || opts.form ? "POST" : "GET");
    const url = new URL(urlStr);
    if (!isTrustedUrl(url))
      throw new CliError("USAGE", `Refusing to send the X session to ${url.origin}`);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined)
        url.searchParams.set(k, String(v));
    const headers = {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "ja,en;q=0.8",
      Authorization: `Bearer ${WEB_BEARER}`,
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": process.env.X_CLI_LANG ?? "ja",
      Origin: "https://x.com",
      Referer: "https://x.com/"
    };
    const session = opts.auth === false ? await this.getSession() : await this.requireSession();
    if (session && hasAuth(session.cookies)) {
      headers.Cookie = cookieHeader(session.cookies);
      headers["x-csrf-token"] = session.cookies.ct0;
      headers["x-twitter-auth-type"] = "OAuth2Session";
    }
    if (opts.transactionId !== false) {
      const tid = await this.transactionId(method, url);
      if (tid)
        headers["x-client-transaction-id"] = tid;
    }
    let body;
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
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      throw new CliError("RATE_LIMITED", "Rate limited by X. Wait before retrying.", {
        status: 429,
        detail: reset ? { resetAt: new Date(reset * 1000).toISOString() } : undefined
      });
    }
    const errors = data?.errors;
    if (!res.ok || errors?.length && !hasPayload(data?.data)) {
      const first = errors?.[0];
      const xcode = first?.code ?? first?.extensions?.code ?? Number(first?.message?.match(/\((\d{2,3})\)/)?.[1] ?? NaN);
      const code = Number.isFinite(xcode) && ERROR_CODES[xcode] || (res.status >= 300 && res.status < 400 ? "AUTH_ERROR" : undefined) || (res.status === 401 ? "AUTH_ERROR" : res.status === 403 ? "FORBIDDEN" : res.status === 404 ? "NOT_FOUND" : "API_ERROR");
      throw new CliError(code, first?.message ?? `${method} ${url.pathname} failed (${res.status})`, {
        status: res.status,
        detail: errors ?? (typeof data === "string" ? data.slice(0, 300) : data)
      });
    }
    return { status: res.status, headers: res.headers, data };
  }
  async captureCookies(headers) {
    const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const s = this.session;
    if (!s || !setCookies.length || s.savedAt === "probe")
      return;
    let changed = false;
    for (const c of setCookies) {
      const m = c.match(/^(ct0|auth_token)=([^;]*)/);
      if (m && m[2] && s.cookies[m[1]] !== m[2]) {
        s.cookies[m[1]] = m[2];
        changed = true;
      }
    }
    if (changed && s.savedAt !== "env")
      await saveSession(s).catch(() => {});
  }
  async graphql(names, variables, opts = {}) {
    let op = await this.operation(names);
    const session = await this.getSession();
    const loggedIn = !!session && hasAuth(session.cookies);
    const extraFeatures = { ...opts.features };
    let retriedFeatures = false;
    let retriedOps = false;
    let addedVars = 0;
    let bases = [this.graphqlBase, ...GRAPHQL_BASES.filter((b) => b !== this.graphqlBase)];
    let baseIdx = 0;
    for (;; ) {
      const web = this.web;
      const vars = adaptVariables(op, variables, loggedIn);
      const features = {};
      for (const f of op.featureSwitches ?? [])
        features[f] = web?.featureValues[f] ?? KNOWN_FEATURES[f] ?? false;
      Object.assign(features, extraFeatures);
      const fieldToggles = opts.fieldToggles;
      const base = bases[baseIdx];
      const url = `${base}/${op.id}/${op.name}`;
      try {
        const result = op.kind === "mutation" ? await this.request(url, {
          method: "POST",
          json: { variables: vars, features: Object.keys(features).length ? features : undefined, fieldToggles, queryId: op.id }
        }) : await this.request(url, {
          query: {
            variables: JSON.stringify(vars),
            features: Object.keys(features).length ? JSON.stringify(features) : undefined,
            fieldToggles: fieldToggles ? JSON.stringify(fieldToggles) : undefined
          }
        });
        this.graphqlBase = base;
        return result;
      } catch (e) {
        if (!(e instanceof CliError))
          throw e;
        const msg = `${e.message} ${JSON.stringify(e.detail ?? "")}`;
        const undefinedVar = /must be defined/.test(msg) ? msg.match(/"path":\["variable","(\w+)"\]/)?.[1] : undefined;
        if (undefinedVar && !(undefinedVar in variables) && addedVars < 3) {
          variables = { ...variables, [undefinedVar]: false };
          op = { ...op, args: op.args && !op.args.includes(undefinedVar) ? [...op.args, undefinedVar] : op.args };
          addedVars++;
          continue;
        }
        const missing = msg.match(/features cannot be null: ([\w, ]+)/)?.[1];
        if (missing && !retriedFeatures) {
          for (const f of missing.split(/,\s*/))
            if (f.trim())
              extraFeatures[f.trim()] = KNOWN_FEATURES[f.trim()] ?? true;
          retriedFeatures = true;
          continue;
        }
        if (e.status === 404 && baseIdx + 1 < bases.length) {
          baseIdx++;
          continue;
        }
        if (e.status === 404 && !retriedOps && !this.webRefreshed) {
          retriedOps = true;
          retriedFeatures = false;
          await this.webInfo(true).catch(() => null);
          const refreshed = await this.operation(names);
          if (refreshed.id === op.id)
            throw e;
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
var WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA", USER_AGENT, TRUSTED_HOSTS, REST_BASE = "https://api.x.com/1.1", UPLOAD_URL = "https://upload.x.com/i/media/upload.json", DEFAULT_GRAPHQL_BASES, GRAPHQL_BASES, KNOWN_FEATURES, ERROR_CODES, camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
var init_client = __esm(() => {
  init_errors();
  init_session();
  init_throttle();
  init_transaction();
  init_web();
  USER_AGENT = process.env.X_CLI_USER_AGENT ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  TRUSTED_HOSTS = new Set(["x.com", "api.x.com", "upload.x.com"]);
  DEFAULT_GRAPHQL_BASES = ["https://x.com/i/api/graphql", "https://api.x.com/graphql"];
  GRAPHQL_BASES = process.env.X_CLI_GRAPHQL_BASE && DEFAULT_GRAPHQL_BASES.includes(process.env.X_CLI_GRAPHQL_BASE.replace(/\/$/, "")) ? [process.env.X_CLI_GRAPHQL_BASE.replace(/\/$/, "")] : DEFAULT_GRAPHQL_BASES;
  KNOWN_FEATURES = {
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
    responsive_web_enhance_cards_enabled: false
  };
  ERROR_CODES = {
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
    385: "NOT_FOUND"
  };
});

// src/normalize.ts
function parseTwitterDate(s) {
  if (typeof s !== "string")
    return;
  const m = s.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const [, mon, day, hh, mm, ss, tz, year] = m;
  const offsetMin = (tz.startsWith("-") ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const ms = Date.UTC(Number(year), MONTHS[mon] ?? 0, Number(day), Number(hh), Number(mm), Number(ss)) - offsetMin * 60000;
  return new Date(ms).toISOString();
}
function unwrap(result) {
  let r = result;
  for (let i = 0;i < 3 && r; i++) {
    if (r.__typename === "TweetWithVisibilityResults" && r.tweet)
      r = r.tweet;
    else if (r.__typename === "UserWithVisibilityResults" && r.user)
      r = r.user;
    else if (r.result && !r.rest_id)
      r = r.result;
    else
      break;
  }
  return r;
}
function normalizeUser(raw) {
  const u = unwrap(raw);
  if (!u || u.__typename === "UserUnavailable" || !u.rest_id)
    return null;
  const l = u.legacy ?? {};
  const core = u.core ?? {};
  const screenName2 = core.screen_name ?? l.screen_name ?? u.screen_name;
  if (!screenName2)
    return null;
  const website = l.entities?.url?.urls?.[0]?.expanded_url;
  return {
    id: String(u.rest_id),
    screenName: screenName2,
    name: core.name ?? l.name ?? "",
    url: `https://x.com/${screenName2}`,
    description: u.profile_bio?.description ?? l.description ?? undefined,
    location: u.location?.location ?? l.location ?? undefined,
    followers: num(l.followers_count ?? u.relationship_counts?.followers),
    following: num(l.friends_count ?? u.relationship_counts?.following),
    tweets: num(l.statuses_count ?? u.tweet_counts?.tweets),
    likes: l.favourites_count !== undefined ? num(l.favourites_count) : undefined,
    media: l.media_count !== undefined ? num(l.media_count) : undefined,
    verified: !!(u.is_blue_verified || u.verification?.verified || l.verified),
    protected: !!(u.privacy?.protected ?? l.protected),
    createdAt: parseTwitterDate(core.created_at ?? l.created_at),
    avatar: u.avatar?.image_url ?? l.profile_image_url_https ?? undefined,
    website,
    pinnedTweetIds: l.pinned_tweet_ids_str?.length ? l.pinned_tweet_ids_str : undefined
  };
}
function normalizeTweet(raw, depth = 0) {
  const t = unwrap(raw);
  if (!t || !t.rest_id || t.__typename && t.__typename !== "Tweet")
    return null;
  const l = t.legacy ?? {};
  const user = normalizeUser(t.core?.user_results?.result ?? t.core?.user_result?.result);
  const screenName2 = user?.screenName ?? "i";
  const c = t.counts ?? {};
  const d = t.details ?? {};
  const mediaList = [l.extended_entities?.media, l.entities?.media, t.media_entities2, t.media_entities].find((xs) => Array.isArray(xs) && xs.some((m) => m?.media_url_https)) ?? [];
  const media = mediaList.filter((m) => m?.media_url_https).map((m) => {
    const variants = (m.video_info?.variants ?? []).filter((v) => v.content_type === "video/mp4");
    const best = variants.sort((a, b) => num(b.bitrate) - num(a.bitrate))[0];
    return { type: m.type, url: best?.url ?? m.media_url_https, altText: m.ext_alt_text ?? undefined };
  });
  const noteText = t.note_tweet?.note_tweet_results?.result?.text;
  const retweetedRaw = l.retweeted_status_result?.result ?? l.retweeted_status_results?.result;
  const quotedRaw = t.quoted_status_result?.result ?? t.quoted_tweet_results?.result;
  const replyToId = l.in_reply_to_status_id_str ?? t.reply_to_results?.rest_id ?? undefined;
  const createdAt = parseTwitterDate(l.created_at) ?? (typeof d.created_at_ms === "number" ? new Date(d.created_at_ms).toISOString() : undefined);
  const tweet = {
    id: String(t.rest_id),
    url: `https://x.com/${screenName2}/status/${t.rest_id}`,
    text: decodeEntities(noteText ?? l.full_text ?? d.full_text ?? ""),
    author: {
      id: user?.id ?? String(l.user_id_str ?? ""),
      screenName: screenName2,
      name: user?.name ?? "",
      followers: user?.followers ?? 0,
      verified: user?.verified ?? false
    },
    createdAt,
    lang: l.lang,
    likeCount: num(l.favorite_count ?? c.favorite_count),
    retweetCount: num(l.retweet_count ?? c.retweet_count),
    replyCount: num(l.reply_count ?? c.reply_count),
    quoteCount: num(l.quote_count ?? c.quote_count),
    bookmarkCount: num(l.bookmark_count ?? c.bookmark_count),
    viewCount: t.views?.count !== undefined ? num(t.views.count) : undefined,
    hashtags: (l.entities?.hashtags ?? d.hashtag_entities ?? []).map((h) => h.text ?? h.tag).filter(Boolean),
    urls: (l.entities?.urls ?? t.url_entities ?? []).map((u) => u.expanded_url).filter(Boolean),
    mentions: (l.entities?.user_mentions ?? t.mention_entities ?? []).map((m) => m.screen_name).filter(Boolean),
    media,
    conversationId: l.conversation_id_str,
    inReplyToId: replyToId,
    inReplyToScreenName: l.in_reply_to_screen_name ?? t.reply_to_user_results?.result?.core?.screen_name ?? undefined,
    isReply: !!replyToId,
    isRetweet: !!retweetedRaw,
    isQuote: !!(l.is_quote_status ?? quotedRaw)
  };
  if (depth < 1) {
    if (retweetedRaw)
      tweet.retweeted = normalizeTweet(retweetedRaw, depth + 1) ?? undefined;
    if (quotedRaw)
      tweet.quoted = normalizeTweet(quotedRaw, depth + 1) ?? undefined;
  }
  return tweet;
}
function findInstructions(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 12)
    return out;
  if (Array.isArray(node)) {
    for (const n of node)
      findInstructions(n, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "instructions" && Array.isArray(v))
      out.push(v);
    else if (v && typeof v === "object")
      findInstructions(v, out, depth + 1);
  }
  return out;
}
function entriesOf(instruction) {
  if (Array.isArray(instruction.entries))
    return instruction.entries;
  if (instruction.entry)
    return [instruction.entry];
  if (Array.isArray(instruction.moduleItems))
    return instruction.moduleItems;
  return [];
}
function parseTimeline(data, kind) {
  const items = [];
  const skipped = [];
  const seen = new Set;
  let bottomCursor;
  let topCursor;
  const cursorFrom = (c) => {
    const type = c?.cursorType ?? c?.cursor_type;
    const value = c?.value;
    if (!type || !value)
      return;
    if (type === "Bottom")
      bottomCursor = value;
    else if (type === "Top")
      topCursor = value;
    else if (type === "ShowMore" || type === "ShowMoreThreads" || type === "ShowMoreThreadsPrompt")
      bottomCursor ??= value;
  };
  const take = (itemContent, entryId) => {
    if (!itemContent)
      return;
    if (/promoted/i.test(entryId ?? "") || itemContent.promotedMetadata)
      return;
    if (itemContent.cursorType || itemContent.cursor_type)
      return cursorFrom(itemContent);
    if (itemContent.tombstoneInfo || itemContent.itemType === "TimelineTombstone") {
      skipped.push({ entryId, reason: "Tombstone" });
      return;
    }
    const raw = kind === "tweet" ? itemContent.tweet_results?.result ?? itemContent.tweetResult?.result : itemContent.user_results?.result ?? itemContent.userResult?.result;
    if (!raw)
      return;
    const n = kind === "tweet" ? normalizeTweet(raw) : normalizeUser(raw);
    if (!n) {
      skipped.push({ entryId, reason: unwrap(raw)?.__typename ?? "unparsable" });
      return;
    }
    if (seen.has(n.id))
      return;
    seen.add(n.id);
    items.push(n);
  };
  for (const instructions of findInstructions(data)) {
    for (const ins of instructions) {
      for (const entry of entriesOf(ins)) {
        const entryId = entry.entryId ?? entry.entry_id;
        const content = entry.content ?? entry.item ?? {};
        if (content.cursorType || content.cursor_type)
          cursorFrom(content);
        else if (/^cursor-(bottom|top)/.test(entryId ?? "") && content.value)
          cursorFrom({ cursorType: /bottom/.test(entryId ?? "") ? "Bottom" : "Top", value: content.value });
        take(content.itemContent ?? content.content ?? entry.itemContent, entryId);
        for (const it of content.items ?? [])
          take(it.item?.itemContent ?? it.item?.content ?? it.itemContent, it.entryId ?? it.entry_id ?? entryId);
      }
      if (ins.type === "TimelineReplaceEntry" && /cursor-bottom/.test(ins.entry_id_to_replace ?? "")) {
        bottomCursor = ins.entry?.content?.value ?? bottomCursor;
      }
    }
  }
  return { items, bottomCursor, topCursor, skipped };
}
function findTyped(node, typename, depth = 0) {
  if (!node || typeof node !== "object" || depth > 10)
    return;
  if (!Array.isArray(node) && node.__typename === typename && node.rest_id)
    return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = findTyped(v, typename, depth + 1);
    if (f)
      return f;
  }
  return;
}
function parseSingleTweet(data) {
  const d = data?.data ?? data;
  const raw = d?.tweetResult?.result ?? d?.tweet_result?.result ?? d?.tweetResult ?? d?.tweet_result ?? findTyped(d, "Tweet");
  return raw ? normalizeTweet(raw) : null;
}
function parseSingleUser(data) {
  const d = data?.data ?? data;
  const raw = d?.user?.result ?? d?.user_result?.result ?? d?.user_result_by_screen_name?.result ?? findTyped(d, "User");
  return raw ? normalizeUser(raw) : null;
}
var decodeEntities = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"), num = (v) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}, MONTHS;
var init_normalize = __esm(() => {
  MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
});

// src/api.ts
import { readFile as readFile4, stat as stat2 } from "fs/promises";
import { basename, extname } from "path";
async function paginate(limit, fetchPage, startCursor) {
  const items = [];
  const seen = new Set;
  const skipped = [];
  let cursor = startCursor;
  let exhausted = false;
  let emptyPages = 0;
  for (let page = 0;items.length < limit && page < 50; page++) {
    const res = await fetchPage(cursor, Math.min(Math.max(limit - items.length, 20), 100));
    skipped.push(...res.skipped);
    let added = 0;
    for (const it of res.items) {
      if (seen.has(it.id))
        continue;
      seen.add(it.id);
      items.push(it);
      added++;
    }
    if (!res.bottomCursor || res.bottomCursor === cursor) {
      exhausted = true;
      break;
    }
    cursor = res.bottomCursor;
    emptyPages = added === 0 ? emptyPages + 1 : 0;
    if (emptyPages >= 3)
      break;
  }
  return { items, exhausted, nextCursor: exhausted ? undefined : cursor, ...skipped.length ? { skipped } : {} };
}
async function accountSettings(client) {
  const s = await client.request(`${REST_BASE}/account/settings.json`, {
    query: { include_ext_sharing_audiospaces_listening_data_with_followers: true, include_mention_filter: true, include_nsfw_user_flag: true, include_nsfw_admin_flag: true, include_ranked_timeline: true, include_alt_text_compose: true, ext: "ssoConnections", include_country_code: true, include_ext_dm_nsfw_media_filter: true }
  });
  if (!s?.screen_name)
    throw new CliError("AUTH_ERROR", "Could not read the logged-in account.");
  return { screenName: s.screen_name };
}
async function me(client) {
  const { screenName: screenName2 } = await accountSettings(client);
  return userByScreenName(client, screenName2);
}
async function userByScreenName(client, screenName2) {
  const data = await client.graphql(["UserByScreenName", "UserResultByScreenName"], { screen_name: screenName2, withSafetyModeUserFields: true, withGrokTranslatedBio: false, withIdentity: true }, { fieldToggles: { withAuxiliaryUserLabels: false } });
  const user = parseSingleUser(data);
  if (!user)
    throw new CliError("NOT_FOUND", `User @${screenName2} not found (or suspended).`);
  return user;
}
async function userTweets(client, user, limit, opts = {}) {
  const op = opts.replies ? ["UserTweetsAndReplies", "UserRepliesTimeline"] : ["UserTweets"];
  const vars = { userId: user.id, screenName: user.screenName, sortByMostLiked: false, ...TIMELINE_VARS };
  return paginate(limit, async (cursor, count) => parseTimeline(await client.graphql(op, { ...vars, count, cursor }, { fieldToggles: { withArticlePlainText: false } }), "tweet"), opts.cursor);
}
async function userLikes(client, userId, limit, cursor) {
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(["Likes", "likesQuery"], { userId, count, cursor: c, ...TIMELINE_VARS }), "tweet"), cursor);
}
async function followList(client, which, user, limit, cursor) {
  const op = which === "followers" ? ["Followers", "followersQuery"] : ["Following", "followingQuery"];
  const vars = { userId: user.id, screenName: user.screenName, includePromotedContent: false };
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(op, { ...vars, count, cursor: c }), "user"), cursor);
}
async function userIdOf(client, screenName2) {
  return (await userByScreenName(client, screenName2)).id;
}
async function follow(client, screenName2, on) {
  const user_id = await userIdOf(client, screenName2);
  const res = await client.request(`${REST_BASE}/friendships/${on ? "create" : "destroy"}.json`, {
    form: { include_profile_interstitial_type: "1", include_blocking: "1", include_blocked_by: "1", include_followed_by: "1", include_want_retweets: "1", include_mute_edge: "1", include_can_dm: "1", include_can_media_tag: "1", skip_status: "1", user_id }
  });
  return { ok: true, screenName: res?.screen_name ?? screenName2, userId: user_id, following: on };
}
async function tweetById(client, id) {
  const data = await client.graphql(["TweetResultById", "TweetResultByRestId"], { rest_id: id, tweetId: id, includesVideo: true, withFocalTweet: true, withCommunity: false, includePromotedContent: false, withVoice: false }, { fieldToggles: TWEET_FIELD_TOGGLES });
  const t = parseSingleTweet(data);
  if (!t)
    throw new CliError("NOT_FOUND", `Post ${id} not found (deleted, protected or unavailable).`);
  return t;
}
async function tweetDetail(client, id, replies) {
  const vars = { focalTweetId: id, with_rux_injections: false, rankingMode: "Relevance", referrer: "tweet", withFocalTweet: true, includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true };
  const all = new Map;
  let cursor;
  let exhausted = false;
  const older = (t) => BigInt(t.id) < BigInt(id);
  const replyCount = () => [...all.values()].filter((t) => t.id !== id && !older(t)).length;
  for (let page = 0;page < 20 && (page === 0 || replyCount() < replies); page++) {
    const res = parseTimeline(await client.graphql(["TweetDetail"], { ...vars, cursor }, { fieldToggles: TWEET_FIELD_TOGGLES }), "tweet");
    const before2 = all.size;
    for (const t of res.items)
      all.set(t.id, t);
    if (!res.bottomCursor || res.bottomCursor === cursor || all.size === before2) {
      exhausted = true;
      break;
    }
    cursor = res.bottomCursor;
  }
  const focal = all.get(id) ?? await tweetById(client, id);
  const byId = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1;
  const others = [...all.values()].filter((t) => t.id !== id);
  const before = others.filter(older).sort(byId);
  const replyItems = others.filter((t) => !older(t)).slice(0, replies);
  return { tweet: focal, before, replies: replyItems, exhausted };
}
async function search(client, query, product, limit, cursor) {
  const kind = product === "people" ? "user" : "tweet";
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(["SearchTimeline", "SearchByRawQuery"], { rawQuery: query, count, cursor: c, querySource: "typed_query", product: SEARCH_PRODUCTS[product], withGrokTranslatedBio: false }), kind), cursor);
}
async function home(client, latest, limit, cursor) {
  const ops = latest ? ["HomeLatestTimeline", "HomeTimeline"] : ["HomeTimeline"];
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(ops, { count, cursor: c, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", withCommunity: true, seenTweetIds: [] }), "tweet"), cursor);
}
async function bookmarks(client, limit, cursor) {
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(["Bookmarks", "BookmarkTimeline"], { count, cursor: c, includePromotedContent: false }), "tweet"), cursor);
}
async function engagers(client, which, tweetId2, limit, cursor) {
  const op = which === "likers" ? ["Favoriters", "tweetFavoritersQuery"] : ["Retweeters", "tweetRetweetersQuery"];
  return paginate(limit, async (c, count) => parseTimeline(await client.graphql(op, { tweetId: tweetId2, count, cursor: c, includePromotedContent: false, enableRanking: false }), "user"), cursor);
}
async function createTweet(client, p) {
  const vars = {
    tweet_text: p.text,
    dark_request: false,
    media: { media_entities: (p.mediaIds ?? []).map((media_id) => ({ media_id, tagged_users: [] })), possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null
  };
  if (p.replyTo)
    vars.reply = { in_reply_to_tweet_id: p.replyTo, exclude_reply_user_ids: [] };
  if (p.quote)
    vars.attachment_url = p.quote;
  const ops = p.long ? ["CreateNoteTweet", "createTweetNoteTweetMutation"] : ["CreateTweet"];
  const data = await client.graphql(ops, vars);
  const raw = data?.data?.create_tweet?.tweet_results?.result ?? data?.data?.notetweet_create?.tweet_results?.result;
  const t = raw ? parseSingleTweet({ tweetResult: { result: raw } }) : parseSingleTweet(data);
  if (t)
    return t;
  const id = raw?.rest_id;
  if (!id)
    throw new CliError("API_ERROR", "X accepted the request but returned no post. It may have been rejected silently; check the account.", { detail: data });
  return { id, url: `https://x.com/i/status/${id}` };
}
async function scheduleTweet(client, text, at, mediaIds = []) {
  const data = await client.graphql(["CreateScheduledTweet"], {
    post_tweet_request: { auto_populate_reply_metadata: false, status: text, exclude_reply_user_ids: [], media_ids: mediaIds },
    execute_at: Math.floor(at.getTime() / 1000)
  });
  const id = data?.data?.tweet?.rest_id ?? data?.data?.create_scheduled_tweet?.rest_id ?? data?.data?.createScheduledTweet?.rest_id;
  if (!id)
    throw new CliError("API_ERROR", "X did not confirm the scheduled post. Check x.com's scheduled posts before retrying.", { detail: data });
  return { ok: true, scheduledAt: at.toISOString(), id };
}
async function deleteTweet(client, id) {
  await client.graphql(["DeleteTweet", "deleteTweetMutation"], { tweet_id: id, dark_request: false });
  return { ok: true, id, deleted: true };
}
async function toggle(client, action, id, on) {
  const t = TOGGLES[action];
  try {
    await client.graphql(on ? t.on : t.off, t.vars(id));
    return { ok: true, id, action: on ? action : `un${action}` };
  } catch (e) {
    if (e instanceof CliError && e.code === "ALREADY_DONE")
      return { ok: true, id, action: on ? action : `un${action}`, alreadyDone: true };
    throw e;
  }
}
function mediaCategory(mime) {
  if (mime === "image/gif")
    return "tweet_gif";
  if (mime.startsWith("video/"))
    return "tweet_video";
  return "tweet_image";
}
async function checkMedia(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime)
    throw new CliError("USAGE", `Unsupported media type: ${path} (use jpg, png, webp, gif, mp4 or mov)`);
  const st = await stat2(path).catch(() => null);
  if (!st?.isFile())
    throw new CliError("USAGE", `Media file not found: ${path}`);
  const limit = mime.startsWith("video/") ? 512 * 1024 * 1024 : mime === "image/gif" ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
  if (st.size > limit)
    throw new CliError("USAGE", `${basename(path)} is too large (${st.size} bytes, max ${limit}).`);
  return { path, mime, size: st.size };
}
function checkMediaSet(files) {
  if (files.length > 4)
    throw new CliError("USAGE", "At most 4 media per post.");
  const heavy = files.filter((f) => f.mime === "image/gif" || f.mime.startsWith("video/"));
  if (heavy.length && files.length > 1)
    throw new CliError("USAGE", "A GIF or video must be the only media in its post.");
}
async function uploadMedia(client, path, altText) {
  const { mime, size } = await checkMedia(path);
  const category = mediaCategory(mime);
  const init = await client.request(UPLOAD_URL, { method: "POST", query: { command: "INIT", total_bytes: size, media_type: mime, media_category: category }, transactionId: false });
  const mediaId = init?.media_id_string;
  if (!mediaId)
    throw new CliError("API_ERROR", "Media upload INIT returned no media_id.", { detail: init });
  const buf = await readFile4(path);
  for (let i = 0, seg = 0;i < buf.length; i += CHUNK, seg++) {
    const form = new FormData;
    form.append("media", new Blob([buf.subarray(i, i + CHUNK)]), basename(path));
    await client.request(UPLOAD_URL, { method: "POST", query: { command: "APPEND", media_id: mediaId, segment_index: seg }, form, transactionId: false });
  }
  let fin = await client.request(UPLOAD_URL, { method: "POST", query: { command: "FINALIZE", media_id: mediaId, allow_async: true }, transactionId: false });
  const pollUntil = Date.now() + 10 * 60 * 1000;
  for (let i = 0;fin?.processing_info && i < 120 && Date.now() < pollUntil; i++) {
    const info = fin.processing_info;
    if (info.state === "succeeded")
      break;
    if (info.state === "failed")
      throw new CliError("API_ERROR", `Media processing failed: ${info.error?.message ?? "unknown"}`, { detail: info });
    await sleep(Math.min(Math.max(1, Number(info.check_after_secs) || 2), 30) * 1000);
    fin = await client.request(UPLOAD_URL, { query: { command: "STATUS", media_id: mediaId }, transactionId: false });
  }
  if (fin?.processing_info && fin.processing_info.state !== "succeeded") {
    throw new CliError("TIMEOUT", `Media ${basename(path)} is still processing; nothing was posted. Try again later.`, { detail: fin.processing_info });
  }
  if (altText) {
    await client.request(`${REST_BASE}/media/metadata/create.json`, { method: "POST", json: { media_id: mediaId, alt_text: { text: altText.slice(0, 1000) } } });
  }
  return mediaId;
}
var TIMELINE_VARS, TWEET_FIELD_TOGGLES, SEARCH_PRODUCTS, TOGGLES, MIME, CHUNK;
var init_api = __esm(() => {
  init_errors();
  init_client();
  init_normalize();
  TIMELINE_VARS = {
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true
  };
  TWEET_FIELD_TOGGLES = { withArticleRichContentState: false, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false };
  SEARCH_PRODUCTS = { top: "Top", latest: "Latest", people: "People", media: "Media" };
  TOGGLES = {
    like: { on: ["FavoriteTweet"], off: ["UnfavoriteTweet", "likeButtonControlUnfavoriteMutation"], vars: (id) => ({ tweet_id: id }) },
    retweet: { on: ["CreateRetweet"], off: ["DeleteRetweet", "retweetButtonUnretweetMutation"], vars: (id) => ({ tweet_id: id, source_tweet_id: id, dark_request: false }) },
    bookmark: { on: ["CreateBookmark", "BookmarkAdd"], off: ["DeleteBookmark", "BookmarkDelete"], vars: (id) => ({ tweet_id: id }) }
  };
  MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime" };
  CHUNK = 4 * 1024 * 1024;
});

// src/login.ts
import { Database } from "bun:sqlite";
import { spawn } from "child_process";
import { existsSync, rmSync } from "fs";
import { chmod as chmod2, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join as join4 } from "path";
function browserCandidates() {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ];
    case "win32": {
      const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
      return roots.flatMap((r) => [
        join4(r, "Google/Chrome/Application/chrome.exe"),
        join4(r, "Microsoft/Edge/Application/msedge.exe")
      ]);
    }
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
}
function findBrowser(explicit) {
  const path = explicit || process.env.X_CLI_BROWSER || browserCandidates().find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new CliError("BROWSER_NOT_FOUND", "No Chrome/Edge/Chromium found. Pass --browser <path> (or set X_CLI_BROWSER), or use `x-cli auth import`.");
  }
  return path;
}

class PipeCdp {
  input;
  nextId = 1;
  buf = "";
  pending = new Map;
  constructor(input, output) {
    this.input = input;
    output.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\x00")) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        const p = msg.id ? this.pending.get(msg.id) : undefined;
        if (!p)
          continue;
        this.pending.delete(msg.id);
        if (msg.error)
          p.reject(new Error(msg.error.message));
        else
          p.resolve(msg.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 1e4) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      });
      this.input.write(`${JSON.stringify({ id, method, params })}\x00`);
    });
  }
}
function profileHasSession(profileDir) {
  for (const rel of ["Default/Network/Cookies", "Default/Cookies"]) {
    const path = join4(profileDir, rel);
    if (!existsSync(path))
      continue;
    try {
      const db = new Database(path, { readonly: true });
      try {
        const row = db.query("select count(*) as n from cookies where name = 'auth_token' and (host_key = '.x.com' or host_key = 'x.com')").get();
        if (row && row.n > 0)
          return true;
      } finally {
        db.close();
      }
    } catch {}
  }
  return false;
}
async function waitForExit(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null || proc.killed && proc.exitCode !== null)
    return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
async function readProfileCookies(executable, profileDir) {
  const proc = spawn(executable, [`--user-data-dir=${profileDir}`, "--headless=new", "--remote-debugging-pipe", "--no-first-run", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"]
  });
  try {
    const cdp = new PipeCdp(proc.stdio[3], proc.stdio[4]);
    const res = await cdp.send("Storage.getCookies", {}, 20000);
    return Object.fromEntries(res.cookies.filter((c) => /(^|\.)x\.com$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]));
  } finally {
    proc.kill();
    await waitForExit(proc, 5000);
  }
}
async function browserLogin(opts) {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join4(tmpdir(), "x-cli-login-"));
  await chmod2(profileDir, 448).catch(() => {});
  const procs = [];
  let cleaned = false;
  const cleanupSync = () => {
    if (cleaned)
      return;
    cleaned = true;
    for (const p of procs) {
      try {
        p.kill();
      } catch {}
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  };
  const onSignal = (sig) => {
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
    login.once("exit", () => loginExited = true);
    login.once("error", () => loginExited = true);
    console.error("Log in to X in the Chrome window that opened. It closes by itself about 30 seconds after you're logged in (or quit it with Cmd+Q once logged in).");
    const deadline = Date.now() + opts.timeoutSec * 1000;
    let found = false;
    while (Date.now() < deadline) {
      if (profileHasSession(profileDir)) {
        found = true;
        break;
      }
      if (loginExited)
        break;
      await sleep(2000);
    }
    debug(`login: wait loop done (found=${found}, browserExited=${loginExited})`);
    if (!loginExited) {
      login.kill("SIGTERM");
      if (!await waitForExit(login, 1e4))
        login.kill("SIGKILL");
    }
    debug("login: reading cookies headless");
    const cookies = await readProfileCookies(executable, profileDir).catch(() => ({}));
    debug(`login: got cookies [${Object.keys(cookies).join(",")}]`);
    if (!cookies.auth_token || !cookies.ct0) {
      const timedOut = !found && Date.now() >= deadline;
      throw new CliError(timedOut ? "LOGIN_TIMEOUT" : "LOGIN_ABORTED", timedOut ? `Login was not completed within ${opts.timeoutSec}s (no X session in the browser). Run it again with a longer --timeout, or use \`x-cli auth import\`.` : "The browser was closed before login completed, or it did not keep an X session. Try again, or use `x-cli auth import`.");
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
var init_login = __esm(() => {
  init_errors();
});

// src/cli.ts
var exports_cli = {};
__export(exports_cli, {
  main: () => main,
  helpText: () => helpText
});
import { readFile as readFile5 } from "fs/promises";
import { parseArgs } from "util";
function mediaWithAlt(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.kind !== "option")
      continue;
    if (t.name === "media" && t.value !== undefined)
      out.push({ path: t.value });
    else if (t.name === "alt" && t.value !== undefined) {
      const last = out[out.length - 1];
      if (!last || last.alt !== undefined)
        throw new CliError("USAGE", "Each --alt must come right after the --media it describes.");
      last.alt = t.value;
    }
  }
  return out;
}
function toggleCommands(action, onSummary, offSummary) {
  const make = (on) => ({
    usage: `${on ? "" : "un"}${action} <id|url>`,
    summary: on ? onSummary : offSummary,
    args: 1,
    async run({ positionals, client }) {
      return toggle(client, action, tweetId(positionals[0]), on);
    }
  });
  return { [action]: make(true), [`un${action}`]: make(false) };
}
async function finishLogin(cookies, opts = {}) {
  const keep = Object.fromEntries(Object.entries(cookies).filter(([k]) => ["auth_token", "ct0", "twid", "lang"].includes(k)));
  const client = new XClient({ session: { cookies: keep, savedAt: "probe" }, minIntervalMs: 0, crossProcessThrottle: false });
  if (opts.saveUnverified && !await loadSession().catch(() => null)) {
    await saveSession({ cookies: keep, savedAt: new Date().toISOString() });
    debug("login: saved session before verification");
  }
  try {
    debug("login: verifying with X");
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CliError("TIMEOUT", "Checking the session with X took longer than 120s.")), 120000);
    });
    const { screenName: screenName2 } = await Promise.race([accountSettings(client), timeout]).finally(() => clearTimeout(timer));
    const path = await saveSession({ cookies: keep, screenName: screenName2, savedAt: new Date().toISOString() });
    return { loggedIn: true, screenName: screenName2, sessionPath: path };
  } catch (e) {
    const rejected = e instanceof CliError && ["AUTH_ERROR", "NOT_LOGGED_IN", "FORBIDDEN", "SUSPENDED"].includes(e.code);
    if (!opts.saveUnverified || rejected)
      throw e;
    const path = await saveSession({ cookies: keep, savedAt: new Date().toISOString() });
    const secrets = Object.values(keep).filter((v) => v.length >= 8);
    const scrub = (m) => secrets.reduce((acc, v) => acc.split(v).join("[redacted]"), m).slice(0, 300);
    const err = e instanceof CliError ? { code: e.code, message: scrub(e.message), status: e.status } : { code: "UNKNOWN", message: scrub(String(e)) };
    const userId = /^u(?:%3D|=)(\d+)$/.exec(keep.twid ?? "")?.[1];
    process.stderr.write(`warning: saved the browser session but could not confirm it with X (${err.code}).
`);
    return { saved: true, verified: false, userId, verifyError: err, sessionPath: path };
  }
}
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin)
    chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function int(v, name) {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n))
    throw new CliError("USAGE", `--${name} must be a non-negative integer`);
  return n;
}
function oneOf(v, allowed, name) {
  if (typeof v !== "string" || !allowed.includes(v))
    throw new CliError("USAGE", `--${name} must be one of ${allowed.join(", ")}`);
  return v;
}
function json(v, name) {
  try {
    return JSON.parse(String(v));
  } catch {
    throw new CliError("USAGE", `--${name} must be JSON`);
  }
}
function parseDate(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime()))
    throw new CliError("USAGE", `Invalid date: ${s} (use ISO 8601, e.g. 2026-11-20T09:00:00+09:00)`);
  if (d.getTime() < Date.now() + 60000)
    throw new CliError("USAGE", "--schedule must be at least a minute in the future");
  return d;
}
function findCommand(argv) {
  const two = `${argv[0]} ${argv[1]}`;
  if (argv.length >= 2 && COMMANDS[two])
    return { cmd: COMMANDS[two], rest: argv.slice(2) };
  if (COMMANDS[argv[0]])
    return { cmd: COMMANDS[argv[0]], rest: argv.slice(1) };
  return null;
}
function helpText() {
  const lines = Object.values(COMMANDS).map((c) => `  x-cli ${c.usage}
      ${c.summary}`);
  return [
    "x-cli \u2014 unofficial X (Twitter) CLI. All output is JSON.",
    "",
    "Commands:",
    ...lines,
    "",
    "Environment (ignored when they come from a .env file): X_COOKIE (Cookie header, overrides the saved session),",
    "             X_CLI_HOME, X_CLI_INTERVAL_MS (default 1000), X_CLI_TZ (default Asia/Tokyo), X_CLI_NO_TRANSACTION_ID"
  ].join(`
`);
}
async function main(argv, deps = {}) {
  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) {
    console.log(helpText());
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log("0.1.0");
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group2 = Object.values(COMMANDS).filter((c) => c.usage.startsWith(`${argv[0]} `));
    const message = group2.length ? `Usage:
${group2.map((c) => `  x-cli ${c.usage}`).join(`
`)}` : `Unknown command: ${argv[0]}. Run \`x-cli --help\`.`;
    console.error(JSON.stringify({ error: { code: "USAGE", message } }, null, 2));
    return 2;
  }
  const { cmd, rest } = found;
  const beforeDashDash = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (beforeDashDash.includes("--help") || beforeDashDash.includes("-h")) {
    console.log(`x-cli ${cmd.usage}
  ${cmd.summary}`);
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
    if (positionals.length < (cmd.args ?? 0))
      throw new CliError("USAGE", `Usage: x-cli ${cmd.usage}`);
    const client = deps.client ?? new XClient;
    const result = await cmd.run({ values, positionals, client, deps, tokens: tokens ?? [] });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if (e.code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(JSON.stringify({ error: { code: "USAGE", message: `${e.message}. Usage: x-cli ${cmd.usage}` } }, null, 2));
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: e.stack ?? String(e) } }, null, 2));
    return 1;
  }
}
var limitOpt = (def) => ({ limit: { type: "string", default: def }, cursor: { type: "string" } }), COMMANDS, str = (v) => typeof v === "string" ? v : undefined;
var init_cli = __esm(() => {
  init_analyze();
  init_api();
  init_client();
  init_errors();
  init_login();
  init_session();
  init_text();
  init_web();
  COMMANDS = {
    "auth login": {
      usage: "auth login [--timeout <sec, default 280>] [--browser <path>]",
      summary: "Open a browser, log in to X by hand, and save the session cookies",
      options: { timeout: { type: "string", default: "280" }, browser: { type: "string" } },
      async run({ values, deps }) {
        const login = deps.login ?? browserLogin;
        const cookies = await login({
          timeoutSec: int(values.timeout, "timeout"),
          browser: str(values.browser)
        });
        return finishLogin(cookies, { saveUnverified: true });
      }
    },
    "auth import": {
      usage: "auth import   (pipe the Cookie header or 'auth_token=..; ct0=..' via stdin; --cookie/--auth-token/--ct0 also work but end up in shell history)",
      summary: "Save a session from cookies copied from browser DevTools (auth_token and ct0 are required)",
      options: { cookie: { type: "string" }, "auth-token": { type: "string" }, ct0: { type: "string" } },
      async run({ values, deps }) {
        let cookies;
        if (str(values["auth-token"]) || str(values.ct0))
          cookies = { auth_token: str(values["auth-token"]) ?? "", ct0: str(values.ct0) ?? "" };
        else
          cookies = parseCookieHeader(str(values.cookie) ?? await (deps.readStdin ?? readStdin)());
        if (!hasAuth(cookies))
          throw new CliError("USAGE", "The cookies must include both auth_token and ct0.");
        return finishLogin(cookies);
      }
    },
    "auth status": {
      usage: "auth status",
      summary: "Show whether the saved session works and which account it belongs to",
      async run({ client }) {
        const session = await loadSession();
        if (!session || !hasAuth(session.cookies))
          return { loggedIn: false, sessionPath: sessionPath() };
        try {
          const { screenName: screenName2 } = await accountSettings(client);
          return { loggedIn: true, screenName: screenName2, savedAt: session.savedAt };
        } catch (e) {
          if (e instanceof CliError && ["AUTH_ERROR", "NOT_LOGGED_IN", "FORBIDDEN"].includes(e.code)) {
            return { loggedIn: false, expired: true, reason: e.message, sessionPath: sessionPath() };
          }
          if (e instanceof CliError)
            return { loggedIn: "unknown", reason: `${e.code}: ${e.message}`, savedAt: session.savedAt, sessionPath: sessionPath() };
          throw e;
        }
      }
    },
    "auth logout": {
      usage: "auth logout",
      summary: "Delete the saved session (does not log out other devices)",
      async run() {
        return { removed: await clearSession(), sessionPath: sessionPath() };
      }
    },
    whoami: {
      usage: "whoami",
      summary: "Profile of the logged-in account",
      async run({ client }) {
        return me(client);
      }
    },
    user: {
      usage: "user <screen_name> [--limit 20] [--replies] [--cursor <c>]",
      summary: "Profile and recent posts of a user (--limit 0 for profile only)",
      args: 1,
      options: { ...limitOpt("20"), replies: { type: "boolean", default: false } },
      async run({ values, positionals, client }) {
        const limit = int(values.limit, "limit");
        const user = await userByScreenName(client, screenName(positionals[0]));
        if (limit === 0)
          return { user };
        const posts = await userTweets(client, user, limit, { replies: !!values.replies, cursor: str(values.cursor) });
        return { user, posts: posts.items, exhausted: posts.exhausted, nextCursor: posts.nextCursor, skipped: posts.skipped };
      }
    },
    followers: {
      usage: "followers <screen_name> [--limit 50] [--cursor <c>]",
      summary: "Followers of a user",
      args: 1,
      options: limitOpt("50"),
      async run({ values, positionals, client }) {
        const limit = int(values.limit, "limit");
        const user = await userByScreenName(client, screenName(positionals[0]));
        return followList(client, "followers", user, limit, str(values.cursor));
      }
    },
    following: {
      usage: "following <screen_name> [--limit 50] [--cursor <c>]",
      summary: "Accounts a user follows",
      args: 1,
      options: limitOpt("50"),
      async run({ values, positionals, client }) {
        const limit = int(values.limit, "limit");
        const user = await userByScreenName(client, screenName(positionals[0]));
        return followList(client, "following", user, limit, str(values.cursor));
      }
    },
    likes: {
      usage: "likes [<screen_name>] [--limit 20]",
      summary: "Posts a user liked (defaults to yourself; others' likes are private since 2024)",
      options: limitOpt("20"),
      async run({ values, positionals, client }) {
        const user = positionals[0] ? await userByScreenName(client, screenName(positionals[0])) : await me(client);
        return userLikes(client, user.id, int(values.limit, "limit"), str(values.cursor));
      }
    },
    post: {
      usage: "post [<text> | -] [--file <path>] [--no-thread] [--reply-to <id|url>] [--quote <id|url>] [--media <path> [--alt <text>]]... [--schedule <ISO time>] [--long] [--dry-run]",
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
        "dry-run": { type: "boolean", default: false }
      },
      async run({ values, positionals, client, deps, tokens }) {
        let text = positionals.join(" ");
        if (str(values.file)) {
          if (text)
            throw new CliError("USAGE", "Pass the text or --file, not both.");
          text = await readFile5(str(values.file), "utf8");
        } else if (text === "-")
          text = await (deps.readStdin ?? readStdin)();
        const posts = splitThread(text, !values["no-thread"]);
        if (!posts.length)
          throw new CliError("USAGE", "Nothing to post. Pass the text, --file <path>, or '-' to read stdin.");
        const lengths = checkLength(posts, !!values.long);
        const pairs = mediaWithAlt(tokens);
        const alts = pairs.map((p) => p.alt);
        const media = await Promise.all(pairs.map((p) => checkMedia(p.path)));
        checkMediaSet(media);
        const replyTo = str(values["reply-to"]) ? tweetId(str(values["reply-to"])) : undefined;
        const quoteId = str(values.quote) ? tweetId(str(values.quote)) : undefined;
        const scheduleAt = str(values.schedule) ? parseDate(str(values.schedule)) : undefined;
        if (scheduleAt && (posts.length > 1 || replyTo || quoteId))
          throw new CliError("USAGE", "--schedule supports a single post without --reply-to/--quote.");
        const plan = {
          posts: posts.map((p, i) => ({
            text: p,
            weightedLength: lengths[i].weightedLength,
            ...i === 0 && media.length ? { media: media.map((m, j) => ({ path: m.path, alt: alts[j] })) } : {},
            ...i === 0 && replyTo ? { replyTo } : {},
            ...i === 0 && quoteId ? { quote: quoteId } : {}
          })),
          ...posts.length > 1 ? { thread: posts.length } : {},
          ...scheduleAt ? { scheduleAt: scheduleAt.toISOString() } : {}
        };
        if (values["dry-run"])
          return { dryRun: true, ...plan };
        const mediaIds = [];
        for (const [i, m] of media.entries())
          mediaIds.push(await uploadMedia(client, m.path, alts[i]));
        if (scheduleAt)
          return scheduleTweet(client, posts[0], scheduleAt, mediaIds);
        const quoteUrl = quoteId ? (await tweetById(client, quoteId)).url : undefined;
        const published = [];
        let parent = replyTo;
        for (const [i, p] of posts.entries()) {
          try {
            const t = await createTweet(client, { text: p, long: lengths[i].weightedLength > 280, replyTo: parent, quote: i === 0 ? quoteUrl : undefined, mediaIds: i === 0 ? mediaIds : [] });
            published.push(t);
            parent = t.id;
          } catch (e) {
            if (!published.length)
              throw e;
            const err = e instanceof CliError ? e : new CliError("UNEXPECTED", String(e));
            throw new CliError("PARTIAL_THREAD", `Posts 1-${published.length} of ${posts.length} were published, then post ${i + 1} failed (${err.code}: ${err.message}). Do NOT re-run the whole thread. To continue, post the remaining text with --reply-to ${parent}.`, { detail: { published: published.map((t) => ({ id: t.id, url: t.url })), failedIndex: i, remaining: posts.slice(i), cause: { code: err.code, detail: err.detail } } });
          }
        }
        return published.length === 1 ? { ok: true, post: published[0] } : { ok: true, thread: published };
      }
    },
    delete: {
      usage: "delete <id|url>",
      summary: "Delete one of your posts",
      args: 1,
      async run({ positionals, client }) {
        return deleteTweet(client, tweetId(positionals[0]));
      }
    },
    tweet: {
      usage: "tweet <id|url> [--replies 20]",
      summary: "A post with its thread context and replies",
      args: 1,
      options: { replies: { type: "string", default: "20" } },
      async run({ values, positionals, client }) {
        const id = tweetId(positionals[0]);
        const replies = int(values.replies, "replies");
        if (replies === 0)
          return { tweet: await tweetById(client, id) };
        return tweetDetail(client, id, replies);
      }
    },
    search: {
      usage: "search <query> [--product top|latest|people|media] [--limit 20] [--cursor <c>]",
      summary: "Search posts (or people). Supports X operators: from:, since:, min_faves:, lang:, -filter:replies ...",
      args: 1,
      options: { ...limitOpt("20"), product: { type: "string", default: "top" } },
      async run({ values, positionals, client }) {
        const product = oneOf(values.product, Object.keys(SEARCH_PRODUCTS), "product");
        return search(client, positionals.join(" "), product, int(values.limit, "limit"), str(values.cursor));
      }
    },
    home: {
      usage: "home [--latest] [--limit 20] [--cursor <c>]",
      summary: "Your home timeline (For you, or Following with --latest)",
      options: { ...limitOpt("20"), latest: { type: "boolean", default: false } },
      async run({ values, client }) {
        return home(client, !!values.latest, int(values.limit, "limit"), str(values.cursor));
      }
    },
    bookmarks: {
      usage: "bookmarks [--limit 20] [--cursor <c>]",
      summary: "Your bookmarks",
      options: limitOpt("20"),
      async run({ values, client }) {
        return bookmarks(client, int(values.limit, "limit"), str(values.cursor));
      }
    },
    likers: {
      usage: "likers <id|url> [--limit 50]",
      summary: "Who liked a post (only visible for your own posts)",
      args: 1,
      options: limitOpt("50"),
      async run({ values, positionals, client }) {
        return engagers(client, "likers", tweetId(positionals[0]), int(values.limit, "limit"), str(values.cursor));
      }
    },
    retweeters: {
      usage: "retweeters <id|url> [--limit 50]",
      summary: "Who reposted a post",
      args: 1,
      options: limitOpt("50"),
      async run({ values, positionals, client }) {
        return engagers(client, "retweeters", tweetId(positionals[0]), int(values.limit, "limit"), str(values.cursor));
      }
    },
    ...toggleCommands("like", "Like a post", "Remove a like"),
    ...toggleCommands("retweet", "Repost a post", "Undo a repost"),
    ...toggleCommands("bookmark", "Bookmark a post", "Remove a bookmark"),
    follow: {
      usage: "follow <screen_name>",
      summary: "Follow a user",
      args: 1,
      async run({ positionals, client }) {
        return follow(client, screenName(positionals[0]), true);
      }
    },
    unfollow: {
      usage: "unfollow <screen_name>",
      summary: "Unfollow a user",
      args: 1,
      async run({ positionals, client }) {
        return follow(client, screenName(positionals[0]), false);
      }
    },
    "analyze search": {
      usage: "analyze search <query> [--product top|latest] [--limit 100] [--top 10]",
      summary: "Collect search results and summarize engagement, timing, media/link effects, top authors and posts",
      args: 1,
      options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" }, product: { type: "string", default: "top" } },
      async run({ values, positionals, client }) {
        const product = oneOf(values.product, ["top", "latest", "media"], "product");
        const res = await search(client, positionals.join(" "), product, int(values.limit, "limit"));
        return { query: positionals.join(" "), product, ...analyzeTweets(res.items, { top: int(values.top, "top") }) };
      }
    },
    "analyze user": {
      usage: "analyze user [<screen_name>] [--limit 100] [--top 10]",
      summary: "Summarize a user's recent posts (defaults to yourself)",
      options: { limit: { type: "string", default: "100" }, top: { type: "string", default: "10" } },
      async run({ values, positionals, client }) {
        const user = positionals[0] ? await userByScreenName(client, screenName(positionals[0])) : await me(client);
        const res = await userTweets(client, user, int(values.limit, "limit"));
        const own = res.items.filter((t) => t.author.id === user.id);
        const pinned = new Set(user.pinnedTweetIds ?? []);
        const sample = own.filter((t) => !pinned.has(t.id));
        return { user: { screenName: user.screenName, followers: user.followers }, ...analyzeTweets(sample, { top: int(values.top, "top") }) };
      }
    },
    count: {
      usage: "count <text | -> [--file <path>]",
      summary: "Weighted character count as X counts it (Japanese = 2, URL = 23, max 280), per thread post",
      options: { file: { type: "string" } },
      async run({ values, positionals, deps }) {
        let text = positionals.join(" ");
        if (str(values.file))
          text = await readFile5(str(values.file), "utf8");
        else if (text === "-" || !text)
          text = await (deps.readStdin ?? readStdin)();
        return { posts: splitThread(text).map((p) => ({ weightedLength: weightedLength(p), max: 280, ok: weightedLength(p) <= 280, text: p })) };
      }
    },
    ops: {
      usage: "ops [--grep <word>] [--refresh]",
      summary: "List GraphQL operations discovered in x.com's web client (debugging)",
      options: { grep: { type: "string" }, refresh: { type: "boolean", default: false } },
      async run({ values, client }) {
        const web = await client.webInfo(!!values.refresh);
        const re = str(values.grep) ? new RegExp(str(values.grep), "i") : null;
        const ops = Object.values(web.operations).filter((o) => !re || re.test(o.name)).map((o) => ({ name: o.name, id: o.id, kind: o.kind, source: o.source, args: o.args?.filter((a) => !a.startsWith("__relay")) }));
        return { fetchedAt: web.fetchedAt, scannedFiles: web.scannedFiles, transactionIdReady: !!web.tx, cachePath: cachePath(), count: ops.length, operations: ops };
      }
    },
    raw: {
      usage: "raw <OperationName> [--vars '<json>'] [--field-toggles '<json>'] [--allow-mutation]",
      summary: "Call a discovered GraphQL query and print the raw response (debugging). Mutations need --allow-mutation",
      args: 1,
      options: { vars: { type: "string", default: "{}" }, "field-toggles": { type: "string" }, "allow-mutation": { type: "boolean", default: false } },
      async run({ values, positionals, client }) {
        const op = await client.operation(positionals[0]);
        if (op.kind !== "query" && !values["allow-mutation"]) {
          throw new CliError("USAGE", `${op.name} is a ${op.kind} (it changes something on X). Only run it with the user's explicit OK, and pass --allow-mutation.`);
        }
        const vars = json(values.vars, "vars");
        const ft = str(values["field-toggles"]) ? json(values["field-toggles"], "field-toggles") : undefined;
        return client.graphql(positionals[0], vars, { fieldToggles: ft });
      }
    },
    doctor: {
      usage: "doctor",
      summary: "Check the session, operation discovery and transaction-id generation",
      async run({ client }) {
        const session = await loadSession();
        const out = { sessionPath: sessionPath(), hasSession: !!session && hasAuth(session.cookies) };
        try {
          const web = await client.webInfo(true);
          const needed = [["UserByScreenName"], ["UserTweets"], ["SearchTimeline", "SearchByRawQuery"], ["TweetDetail"], ["CreateTweet"], ["FavoriteTweet"], ["CreateRetweet"], ["Followers", "followersQuery"], ["HomeTimeline"]];
          const optional = [["DeleteTweet", "deleteTweetMutation"], ["CreateScheduledTweet"], ["UnfavoriteTweet", "likeButtonControlUnfavoriteMutation"]];
          const missing = (groups) => groups.filter((g) => !g.some((n) => web.operations[n])).map((g) => g.join(" / "));
          out.operations = { count: Object.keys(web.operations).length, scannedFiles: web.scannedFiles, missing: missing(needed), missingOptional: missing(optional) };
          out.transactionIdReady = !!web.tx;
        } catch (e) {
          out.discoveryError = e.message;
        }
        if (out.hasSession) {
          try {
            out.account = (await accountSettings(client)).screenName;
          } catch (e) {
            out.accountError = e.message;
          }
        }
        const cache = await readCache();
        out.cacheFetchedAt = cache?.fetchedAt;
        return out;
      }
    }
  };
});

// src/bin.ts
import { readdirSync, readFileSync } from "fs";
var SENSITIVE = /^(X_COOKIE|X_CLI_\w+|XDG_CONFIG_HOME|HOME|USERPROFILE|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|NODE_TLS_\w+|NODE_EXTRA_CA_CERTS|SSL_CERT_\w+)$/;
function unquote(raw) {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'" || q === "`") && v.endsWith(q) && v.length >= 2)
    return v.slice(1, -1);
  return v.replace(/\s+#.*$/, "");
}
function dropDotenvSettings() {
  let files = [];
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
      const name = m[1];
      if (!SENSITIVE.test(name))
        continue;
      const value = unquote(m[2]);
      if (process.env[name] !== undefined && process.env[name] === value) {
        delete process.env[name];
        console.error(`x-cli: ignoring ${name} from ${f} (set it in your shell instead)`);
      }
    }
  }
}
dropDotenvSettings();
if (process.env.X_COOKIE)
  console.error("x-cli: using the session from X_COOKIE, not the saved one");
var { main: main2 } = await Promise.resolve().then(() => (init_cli(), exports_cli));
process.exitCode = await main2(process.argv.slice(2));
