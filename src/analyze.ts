import type { Tweet } from "./normalize.ts";
import { weightedLength } from "./text.ts";

export interface Stats {
  count: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
}

export function stats(values: number[]): Stats {
  if (!values.length) return { count: 0, mean: 0, median: 0, p90: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  };
  return {
    count: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    median: round(q(0.5)),
    p90: round(q(0.9)),
    max: s[s.length - 1]!,
  };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const median = (v: number[]) => stats(v).median;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(iso: string, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  return {
    weekday: parts.find((p) => p.type === "weekday")?.value ?? "?",
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0),
  };
}

function group<K extends string | number>(tweets: Tweet[], key: (t: Tweet) => K | undefined) {
  const m = new Map<K, number[]>();
  for (const t of tweets) {
    const k = key(t);
    if (k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(t.likeCount);
  }
  return m;
}

const engagements = (t: Tweet) => t.likeCount + t.retweetCount + t.replyCount + t.quoteCount;

/**
 * Summarize a set of posts: engagement distribution, what correlates with likes (media, links,
 * hashtags, length, posting time) and the top posts/authors/hashtags.
 */
export function analyzeTweets(all: Tweet[], opts: { top?: number; timeZone?: string } = {}) {
  const top = opts.top ?? 10;
  const timeZone = opts.timeZone ?? process.env.X_CLI_TZ ?? "Asia/Tokyo";
  const tweets = all.filter((t) => !t.isRetweet);

  const withViews = tweets.filter((t) => t.viewCount && t.viewCount > 0);
  const compare = (label: string, pred: (t: Tweet) => boolean) => {
    const yes = tweets.filter(pred);
    const no = tweets.filter((t) => !pred(t));
    return { feature: label, with: { count: yes.length, medianLikes: median(yes.map((t) => t.likeCount)) }, without: { count: no.length, medianLikes: median(no.map((t) => t.likeCount)) } };
  };

  const lengthBucket = (t: Tweet) => {
    const n = weightedLength(t.text);
    return n <= 50 ? "0-50" : n <= 100 ? "51-100" : n <= 180 ? "101-180" : n <= 280 ? "181-280" : "281+";
  };
  const byLength = [...group(tweets, lengthBucket)].map(([bucket, v]) => ({ bucket, count: v.length, medianLikes: median(v) }));

  const byWeekday = [...group(tweets, (t) => (t.createdAt ? localParts(t.createdAt, timeZone).weekday : undefined))]
    .map(([weekday, v]) => ({ weekday, count: v.length, medianLikes: median(v) }))
    .sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday));
  const byHour = [...group(tweets, (t) => (t.createdAt ? localParts(t.createdAt, timeZone).hour : undefined))]
    .map(([hour, v]) => ({ hour, count: v.length, medianLikes: median(v) }))
    .sort((a, b) => a.hour - b.hour);

  const tagCount = new Map<string, { count: number; likes: number[] }>();
  for (const t of tweets) {
    for (const h of new Set(t.hashtags.map((x) => x.toLowerCase()))) {
      const e = tagCount.get(h) ?? { count: 0, likes: [] };
      e.count++;
      e.likes.push(t.likeCount);
      tagCount.set(h, e);
    }
  }
  const authorCount = new Map<string, { screenName: string; name: string; followers: number; count: number; likes: number }>();
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
    views: stats(withViews.map((t) => t.viewCount!)),
    engagementRate: {
      note: "(likes + retweets + replies + quotes) / views, posts with view counts only",
      ...stats(withViews.map((t) => round((engagements(t) / t.viewCount!) * 100, 3))),
      unit: "%",
    },
    features: [
      compare("media", (t) => t.media.length > 0),
      compare("link", (t) => t.urls.length > 0),
      compare("hashtag", (t) => t.hashtags.length > 0),
      compare("reply", (t) => t.isReply),
      compare("quote", (t) => t.isQuote),
      compare("question", (t) => /[?？]/.test(t.text)),
    ],
    textLength: byLength,
    publishTime: { byWeekday, byHour },
    topHashtags: [...tagCount]
      .map(([tag, e]) => ({ tag, count: e.count, medianLikes: median(e.likes) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top),
    topAuthors: [...authorCount.values()].sort((a, b) => b.likes - a.likes).slice(0, top),
    topTweets: [...tweets]
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, top)
      .map((t) => ({ url: t.url, author: t.author.screenName, text: t.text.slice(0, 140), likeCount: t.likeCount, retweetCount: t.retweetCount, viewCount: t.viewCount, createdAt: t.createdAt })),
  };
}
