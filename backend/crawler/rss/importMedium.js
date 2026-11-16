// Import Medium articles through Medium's public RSS feeds.
//
// Medium answers bots with "403 Forbidden" on article pages; the crawler
// identifies itself honestly and does not pretend to be a browser. RSS feeds
// are the door Medium opens for automated readers, so we use those:
//
//   1. tag feeds (medium.com/feed/tag/<tag>): ~10 recent article links each
//      -> discover authors and publications
//   2. their feeds (medium.com/feed/@author, /feed/<publication>): ~10 recent
//      articles each WITH full text
//   3. each article is stored like a crawled page (text file + Content +
//      URL record), so index:build, search and snippets work unchanged.
//
// Polite like the crawler: robots.txt checked, at most 1 request/s per host
// (shared HostSlot), our honest User-Agent. ~1,000 articles ≈ 150 requests.
//
// Run: npm run import:medium -- [--source @author --source publication ...]
//                               [--tag programming --tag movies ...] [--max 1000]

import dns from "node:dns";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import connectDb from "../../server/config/db.js";
import Content from "../../server/models/Content.js";
import CrawlJob from "../../server/models/CrawlJob.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { readConfig } from "../config.js";
import { createFetcher } from "../fetcher.js";
import { createMongoPoliteness } from "../hostLimiter.js";
import { DEFAULT_JOB_LIMITS } from "../jobs/jobService.js";
import { hostOf, normalizeUrl } from "../normalizeUrl.js";
import { parsePage } from "../parse.js";
import { createRobots } from "../robots.js";
import { LocalBlobStore } from "../storage/LocalBlobStore.js";
import { cleanArticleUrl, parseFeed, sourceFeedOf } from "./parseFeed.js";

export const DEFAULT_MEDIUM_TAGS = [
  "programming", "javascript", "nodejs", "react", "web-development",
  "artificial-intelligence", "machine-learning", "deep-learning", "data-science", "python",
  "software-engineering", "system-design-interview", "coding", "technology",
  "startup", "careers", "productivity", "interview",
  "blogging", "life", "life-lessons", "self-improvement", "relationships",
  "health", "travel", "food", "movies", "film", "writing",
];

const FEED_TYPES = ["text/xml", "application/xml", "application/rss+xml", "application/atom+xml"];
const IMPORT_JOB_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Medium rate-limits harder than Wikipedia: ~25 requests at 1/s were followed
// by "429 Too Many Requests". So: at least 5 s between requests, and when the
// server still says 429/503, wait as long as it asks (Retry-After) or back
// off 30 s, 60 s, 120 s; if it keeps refusing, STOP the import.
export const DEFAULT_MIN_INTERVAL_MS = 5000;
const MAX_BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 30_000;
const MAX_BUSY_WAIT_MS = 5 * 60 * 1000; // asked to wait longer than this: stop instead

export class RateLimitedError extends Error {}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ tags?: string[], sources?: string[], maxArticles?: number, baseUrl?: string, minIntervalMs?: number }} opts
 *   tags: discover authors through tag feeds; sources: feed URLs to read directly
 *   (a curated list of authors/publications)
 * @param {{ fetcher, robots, politeness, blobStore, log?, sleep? }} deps
 */
export async function importMedium(opts, deps) {
  const { tags = [], sources = [], maxArticles = 1000, baseUrl = "https://medium.com", minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = opts;
  const log = deps.log ?? (() => {});
  const summary = { tagFeeds: tags.length, sourceFeeds: 0, stored: 0, duplicates: 0, withoutText: 0, failedFeeds: 0, stopped: null };
  const tagFeeds = tags.map((tag) => `${baseUrl}/feed/tag/${encodeURIComponent(tag)}`);
  const job = await CrawlJob.create({
    seeds: [...sources, ...tagFeeds],
    limits: { ...DEFAULT_JOB_LIMITS, maxPages: maxArticles, maxPagesPerHost: maxArticles, maxDepth: 1 },
    deadline: new Date(Date.now() + IMPORT_JOB_TIMEOUT_MS),
  });
  const ctx = { deps, summary, log, minIntervalMs, sleep: deps.sleep ?? defaultSleep };
  const feed = (url) => readFeed(url, ctx);

  try {
    // Pass 1: which authors/publications write about these tags?
    const sourcesByTag = [sources];
    for (const url of tagFeeds) {
      const found = (await feed(url)).map((item) => sourceFeedOf(item.link, baseUrl)).filter(Boolean);
      sourcesByTag.push([...new Set(found)]);
    }

    // Pass 2: their feeds carry full articles. Round-robin over the tags, so
    // the article budget is shared by all topics instead of the first few.
    for (const sourceUrl of roundRobin(sourcesByTag)) {
      if (summary.stored >= maxArticles) break;
      summary.sourceFeeds++;
      for (const item of await feed(sourceUrl)) {
        if (summary.stored >= maxArticles) break;
        const outcome = await storeArticle(job, item, sourceUrl, deps.blobStore);
        if (outcome === "stored") summary.stored++;
        else if (outcome === "duplicate") summary.duplicates++;
        else summary.withoutText++;
      }
      log(`[rss] ${sourceUrl}: ${summary.stored} articles so far`);
    }
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    summary.stopped = "rate_limited"; // what was stored so far is kept
    log(`[rss] stopping: ${err.message}`);
  }

  await CrawlJob.updateOne(
    { _id: job._id },
    { $set: { status: "completed", completionReason: summary.stopped ?? "imported", finishedAt: new Date() } },
  );
  return { jobId: job._id, ...summary };
}

/**
 * Fetch and parse one feed, politely. An ordinary failure skips the feed;
 * a site that keeps answering "too busy" stops the whole import
 * (RateLimitedError), because carrying on would ignore its request.
 */
async function readFeed(url, { deps, summary, log, minIntervalMs, sleep }) {
  const verdict = await deps.robots.check(url);
  if (!verdict.allowed) {
    log(`[rss] skip ${url} (${verdict.reason})`);
    return [];
  }
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetcher.fetchUrl(url, {
      allowedTypes: FEED_TYPES,
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.1",
      beforeRequest: async (hopUrl) => {
        await deps.politeness.waitTurn(hostOf(hopUrl), Math.max(verdict.crawlDelayMs, minIntervalMs));
        return null;
      },
    });
    if (res.ok) return parseFeed(res.text);

    const busy = res.httpStatus === 429 || res.httpStatus === 503;
    if (!busy) {
      summary.failedFeeds++;
      log(`[rss] failed ${url} (${res.error})`);
      return [];
    }
    const waitMs = res.retryAfterMs ?? BUSY_BACKOFF_MS * 2 ** attempt;
    if (attempt >= MAX_BUSY_RETRIES || waitMs > MAX_BUSY_WAIT_MS) {
      summary.failedFeeds++;
      throw new RateLimitedError(`${url} still answers HTTP ${res.httpStatus} after ${attempt + 1} tries`);
    }
    log(`[rss] ${url}: HTTP ${res.httpStatus}, the site asks us to slow down: waiting ${Math.round(waitMs / 1000)} s`);
    await sleep(waitMs);
  }
}

/** [[a1, a2], [b1], [c1, c2]] -> a1, b1, c1, a2, c2 (each URL once). */
export function roundRobin(lists) {
  const seen = new Set();
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      if (i < list.length && !seen.has(list[i])) {
        seen.add(list[i]);
        out.push(list[i]);
      }
    }
  }
  return out;
}

/**
 * Store one feed item like a crawled page. Safe to run twice: an article that
 * is already stored for this job is reported as "duplicate", and a URL record
 * left without its Content by an earlier crash is repaired.
 * @returns {Promise<"stored" | "duplicate" | "noText">}
 */
async function storeArticle(job, item, feedUrl, blobStore) {
  if (!item.contentHtml) return "noText"; // tag feeds, or a feed without full text
  const url = normalizeUrl(cleanArticleUrl(item.link));
  if (!url) return "noText";

  const existing = await CrawlUrl.findOne({ jobId: job._id, normalizedUrl: url }, { contentHash: 1 }).lean();
  if (existing && (await Content.exists({ _id: existing.contentHash }))) return "duplicate";

  const html = articleDocument(item);
  const raw = await blobStore.putRawHtml(html);
  const parsed = parsePage(html, url);
  if (!parsed.text) return "noText";
  const text = await blobStore.putText(parsed.text);
  // Same bytes already imported (e.g. by an earlier run): keep one Content.
  const knownContent = await Content.exists({ _id: raw.hash });

  const urlId = existing?._id ?? new mongoose.Types.ObjectId();
  if (!existing) {
    await CrawlUrl.create({
      _id: urlId,
      jobId: job._id,
      normalizedUrl: url,
      originalUrl: item.link,
      host: hostOf(url),
      depth: 1,
      seedUrl: feedUrl,
      parentUrl: feedUrl,
      // Imported, not crawled: it never passed through the fetch/parse queues.
      state: knownContent ? "duplicate" : "parsed",
      fetch: { attempts: 1, budgeted: true, httpStatus: 200, finalUrl: url, contentType: "text/html", sizeBytes: Buffer.byteLength(html), fetchedAt: new Date() },
      parse: { attempts: 1, parsedAt: new Date() },
      contentHash: raw.hash,
      rawRef: raw.ref,
      textRef: text.ref,
      title: item.title,
    });
  }
  await Content.updateOne(
    { _id: raw.hash },
    { $setOnInsert: { rawRef: raw.ref, textRef: text.ref, title: item.title, canonicalUrl: null, outlinks: parsed.links.map((l) => l.url), firstUrlId: urlId, parsedAt: new Date() } },
    { upsert: true },
  );
  return knownContent ? "duplicate" : "stored";
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * A small HTML page around the article, so the normal parser (title, text,
 * links) and snippets treat it exactly like a crawled page. The author's
 * name goes into the text, so it is searchable too.
 */
function articleDocument(item) {
  const byline = item.author ? `<p>By ${escapeHtml(item.author)}</p>` : "";
  return `<!doctype html><html><head><title>${escapeHtml(item.title)}</title></head><body><main>${byline}${item.contentHtml}</main></body></html>`;
}

// ---------------------------------------------------------------- CLI

async function main() {
  // --source @author or --source publication-name: read these feeds directly
  // (a curated list gives better articles than "latest posts in a tag").
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { tag: { type: "string", multiple: true }, source: { type: "string", multiple: true }, max: { type: "string" } },
  });
  const sources = (values.source ?? []).map((s) => `https://medium.com/feed/${s.replace(/^\/+/, "")}`);
  const tags = values.tag ?? (sources.length > 0 ? [] : DEFAULT_MEDIUM_TAGS);
  const maxArticles = Number(values.max ?? 1000);
  const config = readConfig();
  if (!config.mongoUri) throw new Error("MONGODB_URI is not set in .env");
  if (!config.userAgent?.includes("@")) throw new Error("Set CRAWLER_USER_AGENT (with a contact email) in .env");

  dns.setServers(["8.8.8.8", "1.1.1.1"]); // same reason as server/server.js
  await connectDb(config.mongoUri);
  const fetcher = createFetcher({ userAgent: config.userAgent });
  const politeness = createMongoPoliteness({ minDelayMs: config.minDelayMs });
  const robots = createRobots({ fetcher, politeness, userAgent: config.userAgent });
  try {
    console.log(`Importing up to ${maxArticles} Medium articles from ${sources.length} sources and ${tags.length} tags (one request every ${DEFAULT_MIN_INTERVAL_MS / 1000} s)...`);
    const summary = await importMedium({ tags, sources, maxArticles }, { fetcher, robots, politeness, blobStore: new LocalBlobStore(config.dataDir), log: console.log });
    console.log("\n===== Medium import =====");
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nNext: npm run index:wiki   (adds the articles to the search index)");
  } finally {
    await fetcher.close();
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Medium import failed: ${err.message}`);
    process.exit(1);
  });
}
