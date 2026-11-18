import { describe, expect, test } from "bun:test";
import { analyzeTweets, stats } from "../src/analyze.ts";
import { parseSingleUser, parseTimeline, parseTwitterDate } from "../src/normalize.ts";
import { checkLength, screenName, splitThread, tweetId, weightedLength } from "../src/text.ts";

const user = (id: string, sn: string, followers = 100) => ({
  __typename: "User",
  rest_id: id,
  core: { screen_name: sn, name: sn.toUpperCase(), created_at: "Wed Oct 10 20:19:24 +0000 2018" },
  is_blue_verified: true,
  legacy: { followers_count: followers, friends_count: 5, statuses_count: 10, description: "bio" },
});

const tweet = (id: string, opts: Record<string, any> = {}) => ({
  __typename: "Tweet",
  rest_id: id,
  core: { user_results: { result: user("u1", "alice") } },
  views: { count: "1000", state: "EnabledWithCount" },
  legacy: {
    full_text: `post ${id}`,
    created_at: "Mon Nov 17 12:00:00 +0000 2026",
    favorite_count: 10,
    retweet_count: 2,
    reply_count: 1,
    quote_count: 0,
    bookmark_count: 3,
    conversation_id_str: id,
    lang: "ja",
    entities: { hashtags: [{ text: "AI" }], urls: [], user_mentions: [] },
    ...opts,
  },
});

const timeline = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              { type: "TimelinePinEntry", entry: { entryId: "tweet-1", content: { itemContent: { tweet_results: { result: tweet("1") } } } } },
              {
                type: "TimelineAddEntries",
                entries: [
                  { entryId: "tweet-2", content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: tweet("2") } } } } },
                  { entryId: "promoted-tweet-9", content: { itemContent: { tweet_results: { result: tweet("9") } } } },
                  { entryId: "tweet-3", content: { itemContent: { tweet_results: { result: { __typename: "TweetTombstone" } } } } },
                  {
                    entryId: "profile-conversation-4",
                    content: { items: [{ entryId: "x-4", item: { itemContent: { tweet_results: { result: tweet("4", { in_reply_to_status_id_str: "2" }) } } } }] },
                  },
                  { entryId: "tweet-1-dup", content: { itemContent: { tweet_results: { result: tweet("1") } } } },
                  { entryId: "cursor-top-1", content: { cursorType: "Top", value: "TOP" } },
                  { entryId: "cursor-bottom-1", content: { cursorType: "Bottom", value: "BOTTOM" } },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

describe("normalize", () => {
  test("parseTwitterDate", () => {
    expect(parseTwitterDate("Wed Oct 10 20:19:24 +0000 2018")).toBe("2018-10-10T20:19:24.000Z");
    expect(parseTwitterDate("Wed Oct 10 20:19:24 +0900 2018")).toBe("2018-10-10T11:19:24.000Z");
    expect(parseTwitterDate(undefined)).toBeUndefined();
  });

  test("parseTimeline collects tweets, skips promoted/tombstones, dedupes, finds cursors", () => {
    const page = parseTimeline(timeline, "tweet");
    expect(page.items.map((t) => t.id)).toEqual(["1", "2", "4"]);
    expect(page.bottomCursor).toBe("BOTTOM");
    expect(page.topCursor).toBe("TOP");
    expect(page.skipped).toEqual([{ entryId: "tweet-3", reason: "TweetTombstone" }]);
    const t = page.items[2]!;
    expect(t).toMatchObject({
      url: "https://x.com/alice/status/4",
      text: "post 4",
      author: { id: "u1", screenName: "alice", name: "ALICE", followers: 100, verified: true },
      createdAt: "2026-11-17T12:00:00.000Z",
      likeCount: 10,
      viewCount: 1000,
      hashtags: ["AI"],
      isReply: true,
      inReplyToId: "2",
    });
  });

  test("long posts use note_tweet text and retweets nest the original", () => {
    const rt = tweet("5", { retweeted_status_result: { result: { ...tweet("6"), note_tweet: { note_tweet_results: { result: { text: "long text" } } } } } });
    const [t] = parseTimeline({ instructions: [{ entries: [{ entryId: "tweet-5", content: { itemContent: { tweet_results: { result: rt } } } }] }] }, "tweet").items;
    expect(t!.isRetweet).toBe(true);
    expect(t!.retweeted?.text).toBe("long text");
  });

  test("decodes entities, records tombstones, reads ShowMore cursors inside modules", () => {
    const data = {
      instructions: [
        {
          entries: [
            { entryId: "tweet-1", content: { itemContent: { tweet_results: { result: tweet("1", { full_text: "A &amp; B &lt;3" }) } } } },
            { entryId: "tweet-2", content: { itemContent: { itemType: "TimelineTombstone", tombstoneInfo: { text: "deleted" } } } },
            { entryId: "conversationthread-3", content: { items: [{ entryId: "c-3", item: { itemContent: { cursorType: "ShowMore", value: "MORE" } } }] } },
          ],
        },
      ],
    };
    const page = parseTimeline(data, "tweet");
    expect(page.items[0]!.text).toBe("A & B <3");
    expect(page.skipped).toEqual([{ entryId: "tweet-2", reason: "Tombstone" }]);
    expect(page.bottomCursor).toBe("MORE");
  });

  test("parseSingleUser finds the user anywhere in the response", () => {
    expect(parseSingleUser({ data: { user_result_by_screen_name: { result: user("7", "bob", 42) } } })).toMatchObject({ id: "7", screenName: "bob", followers: 42, url: "https://x.com/bob" });
    expect(parseSingleUser({ data: { somethingNew: { deep: user("8", "carol") } } })?.screenName).toBe("carol");
  });
});

describe("text", () => {
  test("weightedLength counts CJK as 2 and URLs as 23", () => {
    expect(weightedLength("hello")).toBe(5);
    expect(weightedLength("こんにちは")).toBe(10);
    expect(weightedLength("見て https://example.com/a/very/long/path?x=1")).toBe(4 + 1 + 23);
    expect(weightedLength("🎉")).toBe(2);
    expect(weightedLength("👨‍👩‍👧")).toBe(2);
    expect(weightedLength("🇯🇵")).toBe(2);
    expect(weightedLength("example.com")).toBe(23);
    expect(weightedLength("https://example.com/pathです")).toBe(27);
    expect(weightedLength("https://example.com.")).toBe(24);
    expect(weightedLength("a.b")).toBe(3);
    expect(weightedLength("example.edu")).toBe(23);
    expect(weightedLength("file.co")).toBe(7);
    expect(weightedLength("bit.ly/abc")).toBe(23);
    expect(weightedLength("node.js")).toBe(7);
    expect(weightedLength("詳細はexample.jpへ")).toBe(6 + 10 + 2);
  });

  test("splitThread and checkLength", () => {
    expect(splitThread("one\n---\ntwo\n\n---\n\nthree")).toEqual(["one", "two", "three"]);
    expect(splitThread("---\nTip: use x-cli\n---\nsecond post")).toEqual(["Tip: use x-cli", "second post"]);
    expect(splitThread("a\n---\nb", false)).toEqual(["a\n---\nb"]);
    expect(() => checkLength(["あ".repeat(141)], false)).toThrow(/exceeds 280/);
    expect(checkLength(["あ".repeat(141)], true)[0]!.weightedLength).toBe(282);
  });

  test("tweetId and screenName accept URLs", () => {
    expect(tweetId("https://x.com/alice/status/123?s=20")).toBe("123");
    expect(tweetId("https://twitter.com/i/web/status/456")).toBe("456");
    expect(tweetId("789")).toBe("789");
    expect(() => tweetId("abc")).toThrow();
    expect(screenName("@alice")).toBe("alice");
    expect(screenName("https://x.com/bob_1")).toBe("bob_1");
    expect(() => screenName("https://x.com/abcdefghijklmnopq")).toThrow();
    expect(() => screenName("https://x.com/home")).toThrow();
    expect(() => tweetId("https://notx.com/a/status/1")).toThrow();
  });
});

describe("analyze", () => {
  test("stats", () => {
    expect(stats([1, 2, 3, 4, 100])).toEqual({ count: 5, mean: 22, median: 3, p90: 61.6, max: 100 });
    expect(stats([]).count).toBe(0);
  });

  test("analyzeTweets excludes retweets and buckets by JST", () => {
    const page = parseTimeline(timeline, "tweet").items;
    const rt = { ...page[0]!, id: "rt", isRetweet: true };
    const a = analyzeTweets([...page, rt], { timeZone: "Asia/Tokyo" });
    expect(a.sample).toEqual({ total: 4, analyzed: 3, retweetsExcluded: 1, timeZone: "Asia/Tokyo" });
    expect(a.publishTime.byHour).toEqual([{ hour: 21, count: 3, medianLikes: 10 }]);
    expect(a.publishTime.byWeekday[0]!.weekday).toBe("Tue");
    expect(a.engagementRate.median).toBe(1.3);
    expect(a.topHashtags[0]).toEqual({ tag: "ai", count: 3, medianLikes: 10 });
  });
});

describe("2026 relay timeline shape", () => {
  const user = { __typename: "User", rest_id: "1", core: { screen_name: "dev", name: "Dev" }, relationship_counts: { followers: 10, following: 2 }, tweet_counts: { tweets: 3 } };
  const tweet = {
    __typename: "Tweet",
    rest_id: "100",
    core: { user_results: { result: user } },
    counts: { favorite_count: 7, retweet_count: 1, reply_count: 2, quote_count: 0, bookmark_count: 3 },
    details: { created_at_ms: 1794351342000, full_text: "hello #x", hashtag_entities: [{ text: "x" }] },
    url_entities: [{ expanded_url: "https://example.com" }],
    mention_entities: [{ screen_name: "a" }],
    media_entities2: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/p.jpg" }],
    reply_to_results: { rest_id: "99" },
    reply_to_user_results: { result: { core: { screen_name: "b" } } },
    views: { count: "1234" },
    legacy: { conversation_id_str: "99", lang: "en", entities: { media: [{}] } },
  };
  const data = {
    data: {
      user_result_by_screen_name: {
        result: {
          profile_with_replies_timeline_v2: {
            timeline: {
              instructions: [
                {
                  __typename: "TimelineAddEntries",
                  entries: [
                    { entry_id: "tweet-100", content: { __typename: "TimelineTimelineItem", content: { __typename: "TimelineTweet", tweet_results: { result: tweet } } } },
                    { entry_id: "cursor-bottom-1", content: { __typename: "TimelineTimelineCursor", cursor_type: "Bottom", value: "NEXT" } },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };

  test("parses posts, metrics and cursors", () => {
    const page = parseTimeline(data, "tweet");
    expect(page.bottomCursor).toBe("NEXT");
    expect(page.items).toHaveLength(1);
    const t = page.items[0]!;
    expect(t).toMatchObject({
      id: "100",
      text: "hello #x",
      createdAt: "2026-11-10T22:55:42.000Z",
      likeCount: 7,
      replyCount: 2,
      bookmarkCount: 3,
      viewCount: 1234,
      hashtags: ["x"],
      urls: ["https://example.com"],
      mentions: ["a"],
      isReply: true,
      inReplyToId: "99",
      inReplyToScreenName: "b",
      author: { screenName: "dev", name: "Dev", followers: 10 },
    });
    expect(t.media).toEqual([{ type: "photo", url: "https://pbs.twimg.com/media/p.jpg", altText: undefined }]);
  });
});
