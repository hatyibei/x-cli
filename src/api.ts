import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { CliError, sleep } from "./errors.ts";
import { REST_BASE, UPLOAD_URL, type XClient } from "./client.ts";
import { parseSingleTweet, parseSingleUser, parseTimeline, type Skipped, type TimelinePage, type Tweet, type User } from "./normalize.ts";

// ---------------------------------------------------------------- shared variables

const TIMELINE_VARS = {
  includePromotedContent: false,
  withQuickPromoteEligibilityTweetFields: true,
  withVoice: true,
  withV2Timeline: true,
};

const TWEET_FIELD_TOGGLES = { withArticleRichContentState: false, withArticlePlainText: false, withGrokAnalyze: false, withDisallowedReplyControls: false };

export interface ListResult<T> {
  items: T[];
  /** No more results exist (the API stopped returning new items or a cursor). */
  exhausted: boolean;
  nextCursor?: string;
  skipped?: Skipped[];
}

/** Page through a cursor-based timeline until `limit` items are collected. */
export async function paginate<T extends { id: string }>(
  limit: number,
  fetchPage: (cursor: string | undefined, count: number) => Promise<TimelinePage<T>>,
  startCursor?: string,
): Promise<ListResult<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  const skipped: Skipped[] = [];
  let cursor = startCursor;
  let exhausted = false;
  let emptyPages = 0;
  for (let page = 0; items.length < limit && page < 50; page++) {
    const res = await fetchPage(cursor, Math.min(Math.max(limit - items.length, 20), 100));
    skipped.push(...res.skipped);
    let added = 0;
    for (const it of res.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      items.push(it);
      added++;
    }
    if (!res.bottomCursor || res.bottomCursor === cursor) {
      exhausted = true;
      break;
    }
    cursor = res.bottomCursor;
    // A page of only ads/tombstones can still be followed by real results; give up after a few in a row.
    emptyPages = added === 0 ? emptyPages + 1 : 0;
    if (emptyPages >= 3) break;
  }
  // Items are never trimmed: trimming would make `nextCursor` skip the cut-off ones. So a page may
  // overshoot `limit` a little.
  return { items, exhausted, nextCursor: exhausted ? undefined : cursor, ...(skipped.length ? { skipped } : {}) };
}

// ---------------------------------------------------------------- account

export async function accountSettings(client: XClient): Promise<{ screenName: string }> {
  const s = await client.request(`${REST_BASE}/account/settings.json`, {
    query: { include_ext_sharing_audiospaces_listening_data_with_followers: true, include_mention_filter: true, include_nsfw_user_flag: true, include_nsfw_admin_flag: true, include_ranked_timeline: true, include_alt_text_compose: true, ext: "ssoConnections", include_country_code: true, include_ext_dm_nsfw_media_filter: true },
  });
  if (!s?.screen_name) throw new CliError("AUTH_ERROR", "Could not read the logged-in account.");
  return { screenName: s.screen_name };
}

export async function me(client: XClient): Promise<User> {
  const { screenName } = await accountSettings(client);
  return userByScreenName(client, screenName);
}

// ---------------------------------------------------------------- users

export async function userByScreenName(client: XClient, screenName: string): Promise<User> {
  const data = await client.graphql(["UserByScreenName", "UserResultByScreenName"], { screen_name: screenName, withSafetyModeUserFields: true, withGrokTranslatedBio: false, withIdentity: true }, { fieldToggles: { withAuxiliaryUserLabels: false } });
  const user = parseSingleUser(data);
  if (!user) throw new CliError("NOT_FOUND", `User @${screenName} not found (or suspended).`);
  return user;
}

type UserRef = Pick<User, "id" | "screenName">;

export async function userTweets(client: XClient, user: UserRef, limit: number, opts: { replies?: boolean; cursor?: string } = {}) {
  const op = opts.replies ? ["UserTweetsAndReplies", "UserRepliesTimeline"] : ["UserTweets"];
  const vars = { userId: user.id, screenName: user.screenName, sortByMostLiked: false, ...TIMELINE_VARS };
  return paginate<Tweet>(limit, async (cursor, count) => parseTimeline(await client.graphql(op, { ...vars, count, cursor }, { fieldToggles: { withArticlePlainText: false } }), "tweet"), opts.cursor);
}

export async function userLikes(client: XClient, userId: string, limit: number, cursor?: string) {
  return paginate<Tweet>(limit, async (c, count) => parseTimeline(await client.graphql(["Likes", "likesQuery"], { userId, count, cursor: c, ...TIMELINE_VARS }), "tweet"), cursor);
}

export async function followList(client: XClient, which: "followers" | "following", user: UserRef, limit: number, cursor?: string) {
  const op = which === "followers" ? ["Followers", "followersQuery"] : ["Following", "followingQuery"];
  const vars = { userId: user.id, screenName: user.screenName, includePromotedContent: false };
  return paginate<User>(limit, async (c, count) => parseTimeline(await client.graphql(op, { ...vars, count, cursor: c }), "user"), cursor);
}

async function userIdOf(client: XClient, screenName: string): Promise<string> {
  return (await userByScreenName(client, screenName)).id;
}

export async function follow(client: XClient, screenName: string, on: boolean) {
  const user_id = await userIdOf(client, screenName);
  const res = await client.request(`${REST_BASE}/friendships/${on ? "create" : "destroy"}.json`, {
    form: { include_profile_interstitial_type: "1", include_blocking: "1", include_blocked_by: "1", include_followed_by: "1", include_want_retweets: "1", include_mute_edge: "1", include_can_dm: "1", include_can_media_tag: "1", skip_status: "1", user_id },
  });
  return { ok: true, screenName: res?.screen_name ?? screenName, userId: user_id, following: on };
}

// ---------------------------------------------------------------- tweets

export async function tweetById(client: XClient, id: string): Promise<Tweet> {
  const data = await client.graphql(["TweetResultById", "TweetResultByRestId"], { rest_id: id, tweetId: id, includesVideo: true, withFocalTweet: true, withCommunity: false, includePromotedContent: false, withVoice: false }, { fieldToggles: TWEET_FIELD_TOGGLES });
  const t = parseSingleTweet(data);
  if (!t) throw new CliError("NOT_FOUND", `Post ${id} not found (deleted, protected or unavailable).`);
  return t;
}

/** A post plus its replies (conversation). */
export async function tweetDetail(client: XClient, id: string, replies: number) {
  const vars = { focalTweetId: id, with_rux_injections: false, rankingMode: "Relevance", referrer: "tweet", withFocalTweet: true, includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true };
  const all = new Map<string, Tweet>();
  let cursor: string | undefined;
  let exhausted = false;
  // Snowflake ids grow with time, so "before the focal post" is an id comparison.
  const older = (t: Tweet) => BigInt(t.id) < BigInt(id);
  const replyCount = () => [...all.values()].filter((t) => t.id !== id && !older(t)).length;
  for (let page = 0; page < 20 && (page === 0 || replyCount() < replies); page++) {
    const res = parseTimeline(await client.graphql(["TweetDetail"], { ...vars, cursor }, { fieldToggles: TWEET_FIELD_TOGGLES }), "tweet");
    const before = all.size;
    for (const t of res.items) all.set(t.id, t);
    // A deleted/unavailable post or the end of the replies: nothing new on this page.
    if (!res.bottomCursor || res.bottomCursor === cursor || all.size === before) {
      exhausted = true;
      break;
    }
    cursor = res.bottomCursor;
  }
  const focal = all.get(id) ?? (await tweetById(client, id));
  const byId = (a: Tweet, b: Tweet) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  const others = [...all.values()].filter((t) => t.id !== id);
  const before = others.filter(older).sort(byId);
  const replyItems = others.filter((t) => !older(t)).slice(0, replies);
  return { tweet: focal, before, replies: replyItems, exhausted };
}

export const SEARCH_PRODUCTS = { top: "Top", latest: "Latest", people: "People", media: "Media" } as const;

export async function search(client: XClient, query: string, product: keyof typeof SEARCH_PRODUCTS, limit: number, cursor?: string) {
  const kind = product === "people" ? "user" : "tweet";
  return paginate<any>(limit, async (c, count) =>
    parseTimeline(await client.graphql(["SearchTimeline", "SearchByRawQuery"], { rawQuery: query, count, cursor: c, querySource: "typed_query", product: SEARCH_PRODUCTS[product], withGrokTranslatedBio: false }), kind),
  cursor);
}

export async function home(client: XClient, latest: boolean, limit: number, cursor?: string) {
  const ops = latest ? ["HomeLatestTimeline", "HomeTimeline"] : ["HomeTimeline"];
  return paginate<Tweet>(limit, async (c, count) =>
    parseTimeline(await client.graphql(ops, { count, cursor: c, includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", withCommunity: true, seenTweetIds: [] }), "tweet"),
  cursor);
}

export async function bookmarks(client: XClient, limit: number, cursor?: string) {
  return paginate<Tweet>(limit, async (c, count) => parseTimeline(await client.graphql(["Bookmarks", "BookmarkTimeline"], { count, cursor: c, includePromotedContent: false }), "tweet"), cursor);
}

export async function engagers(client: XClient, which: "likers" | "retweeters", tweetId: string, limit: number, cursor?: string) {
  const op = which === "likers" ? ["Favoriters", "tweetFavoritersQuery"] : ["Retweeters", "tweetRetweetersQuery"];
  return paginate<User>(limit, async (c, count) => parseTimeline(await client.graphql(op, { tweetId, count, cursor: c, includePromotedContent: false, enableRanking: false }), "user"), cursor);
}

// ---------------------------------------------------------------- write actions

export interface PostInput {
  text: string;
  /** Over 280 weighted characters: Premium "long post" (CreateNoteTweet). */
  long?: boolean;
  replyTo?: string;
  quote?: string;
  mediaIds?: string[];
}

export async function createTweet(client: XClient, p: PostInput): Promise<Tweet | { id: string; url: string }> {
  const vars: Record<string, unknown> = {
    tweet_text: p.text,
    dark_request: false,
    media: { media_entities: (p.mediaIds ?? []).map((media_id) => ({ media_id, tagged_users: [] })), possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_options: null,
  };
  if (p.replyTo) vars.reply = { in_reply_to_tweet_id: p.replyTo, exclude_reply_user_ids: [] };
  if (p.quote) vars.attachment_url = p.quote;
  const ops = p.long ? ["CreateNoteTweet", "createTweetNoteTweetMutation"] : ["CreateTweet"];
  const data = await client.graphql(ops, vars);
  const raw = data?.data?.create_tweet?.tweet_results?.result ?? data?.data?.notetweet_create?.tweet_results?.result;
  const t = raw ? parseSingleTweet({ tweetResult: { result: raw } }) : parseSingleTweet(data);
  if (t) return t;
  const id = raw?.rest_id;
  if (!id) throw new CliError("API_ERROR", "X accepted the request but returned no post. It may have been rejected silently; check the account.", { detail: data });
  return { id, url: `https://x.com/i/status/${id}` };
}

export async function scheduleTweet(client: XClient, text: string, at: Date, mediaIds: string[] = []) {
  // Same request body the web client builds for scheduleTweetCreateMutation (2026).
  const post_tweet_request: Record<string, unknown> = { status: text };
  if (mediaIds.length) Object.assign(post_tweet_request, { media_ids: mediaIds, possibly_sensitive: false });
  const data = await client.graphql(["scheduleTweetCreateMutation", "CreateScheduledTweet"], { post_tweet_request, execute_at: Math.floor(at.getTime() / 1000) });
  const d = data?.data ?? {};
  const id = d.scheduledtweet_v2_insert?.rest_id ?? d.tweet?.rest_id ?? d.create_scheduled_tweet?.rest_id ?? d.createScheduledTweet?.rest_id;
  if (!id) throw new CliError("API_ERROR", "X did not confirm the scheduled post. Check x.com's scheduled posts before retrying.", { detail: data });
  return { ok: true, scheduledAt: at.toISOString(), id: String(id) };
}

export async function scheduledTweets(client: XClient) {
  const data = await client.graphql(["scheduledPostsQuery", "FetchScheduledTweets"], {});
  const list: any[] = data?.data?.viewer_v2?.scheduled_tweet_list ?? data?.data?.viewer?.scheduled_tweet_list ?? [];
  return {
    items: list.map((x) => ({
      id: String(x.rest_id),
      executeAt: typeof x.scheduling_info?.execute_at === "number" ? new Date(x.scheduling_info.execute_at).toISOString() : undefined,
      state: x.scheduling_info?.state,
      text: x.tweet_create_request?.status ?? "",
      mediaIds: x.tweet_create_request?.media_ids,
    })),
  };
}

export async function unscheduleTweet(client: XClient, id: string) {
  const data = await client.graphql(["deleteScheduledTweetMutation", "DeleteScheduledTweet"], { scheduled_tweet_id: id });
  const d = data?.data ?? {};
  const result = Object.values(d)[0];
  if (result !== undefined && result !== "Done" && result !== true) throw new CliError("API_ERROR", "X did not confirm cancelling the scheduled post.", { detail: data });
  return { ok: true, id, unscheduled: true };
}

export async function deleteTweet(client: XClient, id: string) {
  await client.graphql(["DeleteTweet", "deleteTweetMutation"], { tweet_id: id, dark_request: false });
  return { ok: true, id, deleted: true };
}

type Toggle = { on: string[]; off: string[]; vars: (id: string) => Record<string, unknown> };
const TOGGLES: Record<"like" | "retweet" | "bookmark", Toggle> = {
  like: { on: ["FavoriteTweet"], off: ["UnfavoriteTweet", "likeButtonControlUnfavoriteMutation"], vars: (id) => ({ tweet_id: id }) },
  retweet: { on: ["CreateRetweet"], off: ["DeleteRetweet", "retweetButtonUnretweetMutation"], vars: (id) => ({ tweet_id: id, source_tweet_id: id, dark_request: false }) },
  bookmark: { on: ["CreateBookmark", "BookmarkAdd"], off: ["DeleteBookmark", "BookmarkDelete"], vars: (id) => ({ tweet_id: id }) },
};

/** like / unlike, retweet / unretweet, bookmark / unbookmark. Already-done states are reported, not thrown. */
export async function toggle(client: XClient, action: keyof typeof TOGGLES, id: string, on: boolean) {
  const t = TOGGLES[action];
  try {
    await client.graphql(on ? t.on : t.off, t.vars(id));
    return { ok: true, id, action: on ? action : `un${action}` };
  } catch (e) {
    if (e instanceof CliError && e.code === "ALREADY_DONE") return { ok: true, id, action: on ? action : `un${action}`, alreadyDone: true };
    throw e;
  }
}

// ---------------------------------------------------------------- media

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime" };
const CHUNK = 4 * 1024 * 1024;

export function mediaCategory(mime: string): string {
  if (mime === "image/gif") return "tweet_gif";
  if (mime.startsWith("video/")) return "tweet_video";
  return "tweet_image";
}

/** Check a media file before anything is uploaded or posted. */
export async function checkMedia(path: string): Promise<{ path: string; mime: string; size: number }> {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new CliError("USAGE", `Unsupported media type: ${path} (use jpg, png, webp, gif, mp4 or mov)`);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new CliError("USAGE", `Media file not found: ${path}`);
  const limit = mime.startsWith("video/") ? 512 * 1024 * 1024 : mime === "image/gif" ? 15 * 1024 * 1024 : 5 * 1024 * 1024;
  if (st.size > limit) throw new CliError("USAGE", `${basename(path)} is too large (${st.size} bytes, max ${limit}).`);
  return { path, mime, size: st.size };
}

/** Rules X applies to one post's media: up to 4 images, or exactly one GIF/video. */
export function checkMediaSet(files: Array<{ mime: string }>): void {
  if (files.length > 4) throw new CliError("USAGE", "At most 4 media per post.");
  const heavy = files.filter((f) => f.mime === "image/gif" || f.mime.startsWith("video/"));
  if (heavy.length && files.length > 1) throw new CliError("USAGE", "A GIF or video must be the only media in its post.");
}

/** Chunked media upload (INIT / APPEND / FINALIZE / STATUS). Returns the media_id string. */
export async function uploadMedia(client: XClient, path: string, altText?: string): Promise<string> {
  const { mime, size } = await checkMedia(path);
  const category = mediaCategory(mime);

  const init = await client.request(UPLOAD_URL, { method: "POST", query: { command: "INIT", total_bytes: size, media_type: mime, media_category: category }, transactionId: false });
  const mediaId: string = init?.media_id_string;
  if (!mediaId) throw new CliError("API_ERROR", "Media upload INIT returned no media_id.", { detail: init });

  const buf = await readFile(path);
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.append("media", new Blob([buf.subarray(i, i + CHUNK)]), basename(path));
    await client.request(UPLOAD_URL, { method: "POST", query: { command: "APPEND", media_id: mediaId, segment_index: seg }, form, transactionId: false, continuation: true });
  }
  let fin = await client.request(UPLOAD_URL, { method: "POST", query: { command: "FINALIZE", media_id: mediaId, allow_async: true }, transactionId: false, continuation: true });
  const pollUntil = Date.now() + 10 * 60 * 1000;
  for (let i = 0; fin?.processing_info && i < 120 && Date.now() < pollUntil; i++) {
    const info = fin.processing_info;
    if (info.state === "succeeded") break;
    if (info.state === "failed") throw new CliError("API_ERROR", `Media processing failed: ${info.error?.message ?? "unknown"}`, { detail: info });
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
