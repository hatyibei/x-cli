import { CliError } from "./errors.ts";

export const MAX_WEIGHTED_LENGTH = 280;
const URL_LENGTH = 23;
/** Scheme URLs: only ASCII URL characters, so Japanese text written right after a URL is not swallowed. */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g;
const URL_PATH = String.raw`[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*`;
/** Generic TLDs: X links `example.com` even without a path. */
const GTLDS = "com|net|org|edu|gov|mil|int|info|biz|name|pro|aero|coop|museum|mobi|asia|tel|travel|jobs|app|dev|xyz|news|blog|tech|site|shop|page|online|store|cloud|live|art|media|world|top|club|link|space|website|design|studio|life|today|games|wiki";
/**
 * Bare domains X also links. Like twitter-text, a two-letter country TLD (`bit.ly`, `example.jp`,
 * `file.co`) only counts as a link when a path follows.
 */
const BARE_DOMAIN_RE = new RegExp(
  String.raw`(?<![\w@.\-/])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:(?:${GTLDS})(?![a-z0-9-])(?:\/${URL_PATH})?|[a-z]{2}(?![a-z0-9-])\/${URL_PATH})`,
  "gi",
);
const TRAILING_PUNCT = /[.,!?:;'")\]]+$/;

/** Ranges counted as weight 1 by twitter-text (Latin, punctuation...). Everything else (CJK, emoji) is 2. */
const LIGHT_RANGES: Array<[number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Weighted length as X counts it (twitter-text v3 rules): 280 max, CJK characters and emoji count 2,
 * every URL counts 23 (trailing punctuation is not part of the URL), an emoji sequence counts once.
 */
export function weightedLength(text: string): number {
  let len = 0;
  const replaceUrl = (url: string) => {
    const trailing = url.match(TRAILING_PUNCT)?.[0] ?? "";
    len += URL_LENGTH;
    return `\u0000${trailing}`;
  };
  const rest = text.normalize("NFC").replace(URL_RE, replaceUrl).replace(BARE_DOMAIN_RE, replaceUrl);
  for (const { segment } of segmenter.segment(rest)) {
    if (segment === "\u0000") continue;
    const cps = [...segment].map((c) => c.codePointAt(0)!);
    if (cps.length > 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)) {
      len += 2; // emoji sequence (ZWJ, skin tone, flag, keycap)
      continue;
    }
    for (const cp of cps) {
      if (cp === 0xfe0f || cp === 0x200d) continue;
      len += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
    }
  }
  return len;
}

/**
 * Split a thread written as posts separated by a line containing only `---`. Nothing is ever
 * dropped (front matter would become a post: check with --dry-run). With `thread: false` the
 * whole text is one post.
 */
export function splitThread(text: string, thread = true): string[] {
  const body = text.replace(/^\uFEFF/, "");
  if (!thread) return body.trim() ? [body.trim()] : [];
  return body
    .split(/^\s*---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkLength(posts: string[], allowLong: boolean): Array<{ index: number; weightedLength: number }> {
  const report = posts.map((p, index) => ({ index, weightedLength: weightedLength(p) }));
  if (!allowLong) {
    const over = report.filter((r) => r.weightedLength > MAX_WEIGHTED_LENGTH);
    if (over.length) {
      throw new CliError(
        "TOO_LONG",
        `Post ${over.map((o) => `#${o.index + 1} (${o.weightedLength})`).join(", ")} exceeds ${MAX_WEIGHTED_LENGTH} weighted characters (Japanese characters count 2). Shorten it, split it with a '---' line, or pass --long if the account has Premium.`,
        { detail: report },
      );
    }
  }
  return report;
}

const HOST = String.raw`^(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com`;
const RESERVED = new Set(["i", "home", "intent", "search", "settings", "explore", "notifications", "messages", "compose", "hashtag", "share", "login", "logout", "tos", "privacy"]);

/** Accept a tweet ID or a status URL (x.com / twitter.com). */
export function tweetId(input: string): string {
  const s = input.trim();
  if (/^\d{1,20}$/.test(s)) return s;
  const m = s.match(new RegExp(`${HOST}\\/(?:\\w{1,15}|i(?:\\/web)?)\\/status(?:es)?\\/(\\d{1,20})(?=[/?#]|$)`));
  if (m) return m[1]!;
  throw new CliError("USAGE", `Not a post ID or URL: ${input}`);
}

/** Accept "@name", "name" or a profile URL. */
export function screenName(input: string): string {
  const s = input.trim();
  const m = s.match(new RegExp(`${HOST}\\/@?(\\w+)(?=[/?#]|$)`));
  if (!m && /[/.]/.test(s)) throw new CliError("USAGE", `Not a profile URL: ${input}`);
  const name = (m ? m[1]! : s).replace(/^@/, "");
  if (m && RESERVED.has(name.toLowerCase())) throw new CliError("USAGE", `Not a profile URL: ${input}`);
  if (!/^\w{1,15}$/.test(name)) throw new CliError("USAGE", `Not a valid screen name: ${input}`);
  return name;
}
