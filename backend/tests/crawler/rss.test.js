import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFetcher, parseRetryAfter } from "../../crawler/fetcher.js";
import { createMongoPoliteness } from "../../crawler/hostLimiter.js";
import { createRobots } from "../../crawler/robots.js";
import { importMedium, roundRobin } from "../../crawler/rss/importMedium.js";
import { cleanArticleUrl, parseFeed, sourceFeedOf } from "../../crawler/rss/parseFeed.js";
import { LocalBlobStore } from "../../crawler/storage/LocalBlobStore.js";
import { buildIndex } from "../../indexer/buildIndex.js";
import Content from "../../server/models/Content.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import Term from "../../server/models/Term.js";
import { startMockServer } from "../helpers/mockServer.js";
import { startTestDb } from "../helpers/testDb.js";

const UA = "MiniSearchBot/0.1 (+mailto:test@example.com)";

// ---------------------------------------------------------------- feed parsing

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
<channel><title>feed</title>${items.join("")}</channel></rss>`;
const item = ({ title, link, author = "", content = null, categories = [] }) => `<item>
  <title><![CDATA[${title}]]></title><link>${link}</link>
  <dc:creator><![CDATA[${author}]]></dc:creator><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate>
  ${categories.map((c) => `<category><![CDATA[${c}]]></category>`).join("")}
  ${content === null ? "" : `<content:encoded><![CDATA[${content}]]></content:encoded>`}
</item>`;

test("parseFeed reads title, link, author, date, categories and full content", () => {
  const [first] = parseFeed(rss([item({ title: "Cats & <Dogs>", link: "https://medium.com/@alice/cats-1a2b?source=rss", author: "Alice", content: "<p>Hello <b>world</b></p>", categories: ["pets"] })]));
  assert.equal(first.title, "Cats & <Dogs>");
  assert.equal(first.link, "https://medium.com/@alice/cats-1a2b?source=rss");
  assert.equal(first.author, "Alice");
  assert.equal(first.published.toISOString(), "2026-11-02T10:00:00.000Z");
  assert.deepEqual(first.categories, ["pets"]);
  assert.equal(first.contentHtml, "<p>Hello <b>world</b></p>");
});

test("a tag-feed item has no content", () => {
  const [only] = parseFeed(rss([item({ title: "T", link: "https://medium.com/@a/t-1" })]));
  assert.equal(only.contentHtml, "");
});

test("sourceFeedOf finds the author or publication feed of an article", () => {
  assert.equal(sourceFeedOf("https://medium.com/@alice/post-abc123?source=rss"), "https://medium.com/feed/@alice");
  assert.equal(sourceFeedOf("https://medium.com/better-programming/post-abc"), "https://medium.com/feed/better-programming");
  assert.equal(sourceFeedOf("https://medium.com/"), null, "not an article");
  assert.equal(sourceFeedOf("https://alice.example/post"), null, "custom domains are not handled");
});

test("cleanArticleUrl drops Medium's tracking query", () => {
  assert.equal(cleanArticleUrl("https://medium.com/@a/p-1?source=rss-----x-5#top"), "https://medium.com/@a/p-1");
});

test("roundRobin interleaves topics and keeps each feed once", () => {
  assert.deepEqual(roundRobin([["a1", "a2", "x"], ["b1"], ["x", "c2"]]), ["a1", "b1", "x", "a2", "c2"]);
});

// ---------------------------------------------------------------- import against a mock "Medium"

let db;
let dataDir;
let server;
let fetcher;
let sleeps; // waits the importer asked for (recorded, not slept)
let busyLeft; // how many times /feed/@busy answers 429 before 200

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "rss-test-"));
});
after(async () => {
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.clear();
  sleeps = [];
  busyLeft = 0;
  let origin = "";
  const article = (owner, slug, words) => item({ title: `${slug} title`, link: `${origin}/${owner}/${slug}?source=rss`, author: owner.replace("@", ""), content: `<p>${words}</p><a href="${origin}/${owner}">profile</a>` });
  const xml = (res, body) => res.writeHead(200, { "content-type": "text/xml; charset=UTF-8" }).end(body);
  server = await startMockServer({
    "/robots.txt": (req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /feed/@blocked\n"),
    "/feed/tag/alpha": (req, res) => xml(res, rss([
      item({ title: "p1", link: `${origin}/@alice/p1-111?source=rss` }),
      item({ title: "p2", link: `${origin}/@bob/p2-222?source=rss` }),
      item({ title: "p3", link: `${origin}/@blocked/p3-333?source=rss` }),
    ])),
    "/feed/tag/beta": (req, res) => xml(res, rss([
      item({ title: "p4", link: `${origin}/@alice/p4-444?source=rss` }),
      item({ title: "p5", link: `${origin}/pubx/p5-555?source=rss` }),
    ])),
    "/feed/@alice": (req, res) => xml(res, rss([article("@alice", "p1-111", "quantum kittens"), article("@alice", "p4-444", "orbital mechanics")])),
    "/feed/@bob": (req, res) => xml(res, rss([article("@bob", "p2-222", "sourdough bread"), item({ title: "no text", link: `${origin}/@bob/x-9` })])),
    "/feed/pubx": (req, res) => xml(res, rss([article("pubx", "p5-555", "film noir cinema")])),
    "/feed/@blocked": (req, res) => xml(res, rss([article("@blocked", "p3-333", "forbidden fruit")])),
    "/feed/@busy": (req, res) => {
      if (busyLeft-- > 0) return res.writeHead(429, { "retry-after": "7" }).end("slow down");
      xml(res, rss([article("@busy", "b1-777", "patient gardening")]));
    },
  });
  origin = server.origin;
  fetcher = createFetcher({ userAgent: UA, allowPrivateNetworks: true });
});
afterEach(async () => {
  await fetcher.close();
  await server.close();
});

function run(opts) {
  const politeness = createMongoPoliteness({ minDelayMs: 0 });
  const robots = createRobots({ fetcher, politeness, userAgent: UA });
  return importMedium({ tags: ["alpha", "beta"], baseUrl: server.origin, minIntervalMs: 0, ...opts }, { fetcher, robots, politeness, blobStore: new LocalBlobStore(dataDir), sleep: async (ms) => sleeps.push(ms) });
}

test("imports full articles from author/publication feeds discovered through tag feeds", async () => {
  const summary = await run({ maxArticles: 100 });
  assert.equal(summary.stored, 4, "p1, p4 (alice), p2 (bob), p5 (pubx)");
  assert.equal(summary.withoutText, 1, "bob's item without full text");
  assert.equal(await CrawlUrl.countDocuments({ state: "parsed" }), 4);
  assert.equal(await Content.countDocuments(), 4);
  const p1 = await CrawlUrl.findOne({ normalizedUrl: `${server.origin}/@alice/p1-111` }).lean();
  assert.ok(p1, "stored under the clean URL (no ?source=...)");
  assert.equal(p1.title, "p1-111 title");
});

test("robots.txt is obeyed for feeds", async () => {
  await run({ maxArticles: 100 });
  assert.ok(!server.pathsRequested().includes("/feed/@blocked"));
  assert.equal(await CrawlUrl.countDocuments({ normalizedUrl: /blocked/ }), 0);
});

test("the article budget is respected", async () => {
  const summary = await run({ maxArticles: 2 });
  assert.equal(summary.stored, 2);
  assert.equal(await Content.countDocuments(), 2);
});

test("running it again stores nothing twice", async () => {
  await run({ maxArticles: 100 });
  const again = await run({ maxArticles: 100 });
  assert.equal(again.stored, 0);
  assert.equal(again.duplicates, 4);
  assert.equal(await Content.countDocuments(), 4, "one Content per article, across runs");
});

test("imported articles are searchable after index:build, author names included", async () => {
  await run({ maxArticles: 100 });
  const summary = await buildIndex({ blobStore: new LocalBlobStore(dataDir) });
  assert.equal(summary.N, 4);
  assert.ok(await Term.exists({ term: "sourdough" }));
  assert.ok(await Term.exists({ term: "alic" }), "'By alice' is in the text (stemmed: alic)");
});

// ---------------------------------------------------------------- rate limits

test("parseRetryAfter reads seconds or an HTTP date", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString(), Date.now()) > 25_000, true);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter("soon"), null);
});

test("429 with Retry-After: wait as asked, then the feed is read", async () => {
  busyLeft = 1;
  const summary = await run({ tags: [], sources: [`${server.origin}/feed/@busy`] });
  assert.deepEqual(sleeps, [7000], "waited the 7 s the server asked for");
  assert.equal(summary.stored, 1);
  assert.equal(summary.stopped, null);
});

test("a site that keeps answering 429 stops the whole import", async () => {
  busyLeft = 99;
  // Pass 1 reads the tag feed (finds alice and bob); pass 2 starts with the
  // curated source @busy, which keeps refusing.
  const summary = await run({ tags: ["alpha"], sources: [`${server.origin}/feed/@busy`] });
  assert.equal(summary.stopped, "rate_limited");
  assert.equal(sleeps.length, 3, "3 waits, then it gives up");
  const busyCalls = server.pathsRequested().filter((p) => p === "/feed/@busy").length;
  assert.equal(busyCalls, 4, "first try + 3 retries, nothing more");
  assert.ok(!server.pathsRequested().includes("/feed/@alice"), "no other feed is requested after stopping");
  assert.ok(!server.pathsRequested().includes("/feed/@bob"));
});

test("curated sources are read directly, without tag feeds", async () => {
  const summary = await run({ tags: [], sources: [`${server.origin}/feed/pubx`] });
  assert.equal(summary.stored, 1);
  assert.ok(!server.pathsRequested().some((p) => p.startsWith("/feed/tag/")));
});
