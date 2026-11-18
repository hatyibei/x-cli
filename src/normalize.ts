/**
 * Turn X's GraphQL timeline responses into flat, stable objects. The response shape differs
 * between operations and between the classic and Relay web clients, so everything here walks
 * the tree defensively instead of relying on fixed paths.
 */

export interface User {
  id: string;
  screenName: string;
  name: string;
  url: string;
  description?: string;
  location?: string;
  followers: number;
  following: number;
  tweets: number;
  likes?: number;
  media?: number;
  verified: boolean;
  protected: boolean;
  createdAt?: string;
  avatar?: string;
  website?: string;
  pinnedTweetIds?: string[];
}

export interface Media {
  type: string;
  url: string;
  altText?: string;
}

export interface Tweet {
  id: string;
  url: string;
  text: string;
  author: Pick<User, "id" | "screenName" | "name" | "followers" | "verified">;
  createdAt?: string;
  lang?: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  bookmarkCount: number;
  viewCount?: number;
  hashtags: string[];
  urls: string[];
  mentions: string[];
  media: Media[];
  conversationId?: string;
  inReplyToId?: string;
  inReplyToScreenName?: string;
  isReply: boolean;
  isRetweet: boolean;
  isQuote: boolean;
  retweeted?: Tweet;
  quoted?: Tweet;
}

export interface Skipped {
  entryId?: string;
  reason: string;
}

export interface TimelinePage<T> {
  items: T[];
  bottomCursor?: string;
  topCursor?: string;
  skipped: Skipped[];
}

/** X escapes &, < and > in post text. */
export const decodeEntities = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "Wed Oct 10 20:19:24 +0000 2018" -> ISO string. */
export function parseTwitterDate(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  const [, mon, day, hh, mm, ss, tz, year] = m;
  const offsetMin = (tz!.startsWith("-") ? -1 : 1) * (Number(tz!.slice(1, 3)) * 60 + Number(tz!.slice(3, 5)));
  const ms = Date.UTC(Number(year), MONTHS[mon!] ?? 0, Number(day), Number(hh), Number(mm), Number(ss)) - offsetMin * 60000;
  return new Date(ms).toISOString();
}

function unwrap(result: any): any {
  let r = result;
  for (let i = 0; i < 3 && r; i++) {
    if (r.__typename === "TweetWithVisibilityResults" && r.tweet) r = r.tweet;
    else if (r.__typename === "UserWithVisibilityResults" && r.user) r = r.user;
    else if (r.result && !r.rest_id) r = r.result;
    else break;
  }
  return r;
}

export function normalizeUser(raw: any): User | null {
  const u = unwrap(raw);
  if (!u || u.__typename === "UserUnavailable" || !u.rest_id) return null;
  const l = u.legacy ?? {};
  const core = u.core ?? {};
  const screenName = core.screen_name ?? l.screen_name ?? u.screen_name;
  if (!screenName) return null;
  const website = l.entities?.url?.urls?.[0]?.expanded_url;
  return {
    id: String(u.rest_id),
    screenName,
    name: core.name ?? l.name ?? "",
    url: `https://x.com/${screenName}`,
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
    pinnedTweetIds: l.pinned_tweet_ids_str?.length ? l.pinned_tweet_ids_str : undefined,
  };
}

export function normalizeTweet(raw: any, depth = 0): Tweet | null {
  const t = unwrap(raw);
  if (!t || !t.rest_id || (t.__typename && t.__typename !== "Tweet")) return null;
  const l = t.legacy ?? {};
  const user = normalizeUser(t.core?.user_results?.result ?? t.core?.user_result?.result);
  const screenName = user?.screenName ?? "i";
  // 2026 Relay shape: counts.*, details.*, *_entities at the top level, *_results for RT/quote/reply.
  const c = t.counts ?? {};
  const d = t.details ?? {};
  // The new shape leaves placeholder `{}` items in legacy.entities.media; use the first real list.
  const mediaList: any[] = [l.extended_entities?.media, l.entities?.media, t.media_entities2, t.media_entities].find((xs) => Array.isArray(xs) && xs.some((m: any) => m?.media_url_https)) ?? [];
  const media: Media[] = mediaList.filter((m: any) => m?.media_url_https).map((m: any) => {
    const variants = (m.video_info?.variants ?? []).filter((v: any) => v.content_type === "video/mp4");
    const best = variants.sort((a: any, b: any) => num(b.bitrate) - num(a.bitrate))[0];
    return { type: m.type, url: best?.url ?? m.media_url_https, altText: m.ext_alt_text ?? undefined };
  });
  const noteText: string | undefined = t.note_tweet?.note_tweet_results?.result?.text;
  const retweetedRaw = l.retweeted_status_result?.result ?? l.retweeted_status_results?.result;
  const quotedRaw = t.quoted_status_result?.result ?? t.quoted_tweet_results?.result;
  const replyToId: string | undefined = l.in_reply_to_status_id_str ?? t.reply_to_results?.rest_id ?? undefined;
  const createdAt = parseTwitterDate(l.created_at) ?? (typeof d.created_at_ms === "number" ? new Date(d.created_at_ms).toISOString() : undefined);
  const tweet: Tweet = {
    id: String(t.rest_id),
    url: `https://x.com/${screenName}/status/${t.rest_id}`,
    text: decodeEntities(noteText ?? l.full_text ?? d.full_text ?? ""),
    author: {
      id: user?.id ?? String(l.user_id_str ?? ""),
      screenName,
      name: user?.name ?? "",
      followers: user?.followers ?? 0,
      verified: user?.verified ?? false,
    },
    createdAt,
    lang: l.lang,
    likeCount: num(l.favorite_count ?? c.favorite_count),
    retweetCount: num(l.retweet_count ?? c.retweet_count),
    replyCount: num(l.reply_count ?? c.reply_count),
    quoteCount: num(l.quote_count ?? c.quote_count),
    bookmarkCount: num(l.bookmark_count ?? c.bookmark_count),
    viewCount: t.views?.count !== undefined ? num(t.views.count) : undefined,
    hashtags: (l.entities?.hashtags ?? d.hashtag_entities ?? []).map((h: any) => h.text ?? h.tag).filter(Boolean),
    urls: (l.entities?.urls ?? t.url_entities ?? []).map((u: any) => u.expanded_url).filter(Boolean),
    mentions: (l.entities?.user_mentions ?? t.mention_entities ?? []).map((m: any) => m.screen_name).filter(Boolean),
    media,
    conversationId: l.conversation_id_str,
    inReplyToId: replyToId,
    inReplyToScreenName: l.in_reply_to_screen_name ?? t.reply_to_user_results?.result?.core?.screen_name ?? undefined,
    isReply: !!replyToId,
    isRetweet: !!retweetedRaw,
    isQuote: !!(l.is_quote_status ?? quotedRaw),
  };
  if (depth < 1) {
    if (retweetedRaw) tweet.retweeted = normalizeTweet(retweetedRaw, depth + 1) ?? undefined;
    if (quotedRaw) tweet.quoted = normalizeTweet(quotedRaw, depth + 1) ?? undefined;
  }
  return tweet;
}

/** Find every `instructions` array anywhere in the response. */
function findInstructions(node: any, out: any[][] = [], depth = 0): any[][] {
  if (!node || typeof node !== "object" || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const n of node) findInstructions(n, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "instructions" && Array.isArray(v)) out.push(v);
    else if (v && typeof v === "object") findInstructions(v, out, depth + 1);
  }
  return out;
}

function entriesOf(instruction: any): any[] {
  if (Array.isArray(instruction.entries)) return instruction.entries;
  if (instruction.entry) return [instruction.entry];
  if (Array.isArray(instruction.moduleItems)) return instruction.moduleItems;
  return [];
}

type Kind = "tweet" | "user";

/** Collect tweets (or users) and cursors from a timeline-shaped response. */
export function parseTimeline<K extends Kind>(data: any, kind: K): TimelinePage<K extends "tweet" ? Tweet : User> {
  const items: any[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;

  const cursorFrom = (c: any) => {
    const type = c?.cursorType ?? c?.cursor_type;
    const value = c?.value;
    if (!type || !value) return;
    if (type === "Bottom") bottomCursor = value;
    else if (type === "Top") topCursor = value;
    // TweetDetail's "show more replies" cursors (also inside modules).
    else if (type === "ShowMore" || type === "ShowMoreThreads" || type === "ShowMoreThreadsPrompt") bottomCursor ??= value;
  };

  const take = (itemContent: any, entryId?: string) => {
    if (!itemContent) return;
    if (/promoted/i.test(entryId ?? "") || itemContent.promotedMetadata) return;
    if (itemContent.cursorType || itemContent.cursor_type) return cursorFrom(itemContent);
    if (itemContent.tombstoneInfo || itemContent.itemType === "TimelineTombstone") {
      skipped.push({ entryId, reason: "Tombstone" });
      return;
    }
    const raw = kind === "tweet" ? itemContent.tweet_results?.result ?? itemContent.tweetResult?.result : itemContent.user_results?.result ?? itemContent.userResult?.result;
    if (!raw) return;
    const n = kind === "tweet" ? normalizeTweet(raw) : normalizeUser(raw);
    if (!n) {
      skipped.push({ entryId, reason: unwrap(raw)?.__typename ?? "unparsable" });
      return;
    }
    if (seen.has(n.id)) return;
    seen.add(n.id);
    items.push(n);
  };

  for (const instructions of findInstructions(data)) {
    for (const ins of instructions) {
      for (const entry of entriesOf(ins)) {
        const entryId: string | undefined = entry.entryId ?? entry.entry_id;
        const content = entry.content ?? entry.item ?? {};
        if (content.cursorType || content.cursor_type) cursorFrom(content);
        else if (/^cursor-(bottom|top)/.test(entryId ?? "") && content.value) cursorFrom({ cursorType: /bottom/.test(entryId ?? "") ? "Bottom" : "Top", value: content.value });
        take(content.itemContent ?? content.content ?? entry.itemContent, entryId);
        for (const it of content.items ?? []) take(it.item?.itemContent ?? it.item?.content ?? it.itemContent, it.entryId ?? it.entry_id ?? entryId);
      }
      if (ins.type === "TimelineReplaceEntry" && /cursor-bottom/.test(ins.entry_id_to_replace ?? "")) {
        bottomCursor = ins.entry?.content?.value ?? bottomCursor;
      }
    }
  }
  return { items, bottomCursor, topCursor, skipped } as any;
}

/** Depth-first search for the first object with the given __typename and a rest_id. */
function findTyped(node: any, typename: string, depth = 0): any {
  if (!node || typeof node !== "object" || depth > 10) return undefined;
  if (!Array.isArray(node) && node.__typename === typename && node.rest_id) return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const f = findTyped(v, typename, depth + 1);
    if (f) return f;
  }
  return undefined;
}

/** A single tweet from TweetResultByRestId-like responses. */
export function parseSingleTweet(data: any): Tweet | null {
  const d = data?.data ?? data;
  const raw = d?.tweetResult?.result ?? d?.tweet_result?.result ?? d?.tweetResult ?? d?.tweet_result ?? findTyped(d, "Tweet");
  return raw ? normalizeTweet(raw) : null;
}

/** A single user from UserByScreenName-like responses. */
export function parseSingleUser(data: any): User | null {
  const d = data?.data ?? data;
  const raw = d?.user?.result ?? d?.user_result?.result ?? d?.user_result_by_screen_name?.result ?? findTyped(d, "User");
  return raw ? normalizeUser(raw) : null;
}
