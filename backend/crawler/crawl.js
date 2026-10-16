// Stage 1 crawler: one Node process, breadth-first search (BFS) from seed URLs.
//
// BFS = visit pages in order of distance from the seed: first the seed
// (depth 0), then every page it links to (depth 1), then their links
// (depth 2)... A FIFO queue gives exactly that order. A visited ("seen") set
// makes sure each URL enters the queue at most once.
//
// For each URL taken from the queue:
//   robots.txt allowed? -> wait for the host (politeness) -> fetch
//   -> store raw HTML -> parse -> store text -> enqueue new links (depth + 1)
//
// Run:  npm run crawl -- --seed https://books.toscrape.com/ --max-pages 30 --max-depth 2

import dns from "node:dns";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import connectDb from "../server/config/db.js";
import Page from "../server/models/Page.js";
import { createFetcher } from "./fetcher.js";
import { hostOf, normalizeUrl } from "./normalizeUrl.js";
import { parsePage } from "./parse.js";
import { createPoliteness } from "./politeness.js";
import { createRobots } from "./robots.js";
import { createBlobStore, DEFAULT_DATA_DIR } from "./storage.js";

export const DEFAULT_LIMITS = { maxPages: 50, maxDepth: 2, maxLinksPerPage: 100, sameHostOnly: true };

// Fetch outcomes that are a deliberate "no" rather than an error.
const SKIP_CODES = new Set(["blocked", "not_html"]);

/**
 * Crawl from `seeds` within `limits`. Returns a summary object.
 * All collaborators come in through `deps`, so tests can swap the delay,
 * storage folder or database without touching this code.
 */
export async function crawl({ seeds, ...limits }, deps) {
  const ctx = {
    limits: { ...DEFAULT_LIMITS, ...limits },
    deps: { log: () => {}, PageModel: Page, ...deps },
    queue: [],
    head: 0, // index of the next item; queue.shift() would be O(n) per call
    seen: new Set(), // every URL ever enqueued (not only the ones fetched)
    stats: { attempted: 0, fetched: 0, parsed: 0, failed: 0, skipped: {}, duplicatesAvoided: 0, invalidSeeds: 0 },
  };
  const startedAt = Date.now();

  for (const seed of seeds) enqueueSeed(ctx, seed);

  // maxPages limits fetch ATTEMPTS (requests for pages), because that is
  // what costs the remote server something. Robots skips do not count.
  while (ctx.head < ctx.queue.length && ctx.stats.attempted < ctx.limits.maxPages) {
    const item = ctx.queue[ctx.head++];
    await processItem(ctx, item);
  }
  return summarize(ctx, startedAt);
}

function enqueueSeed(ctx, seed) {
  const url = normalizeUrl(seed);
  if (!url) {
    ctx.stats.invalidSeeds++;
    ctx.deps.log(`Invalid seed ignored: ${seed}`);
    return;
  }
  enqueue(ctx, { url, originalUrl: seed, depth: 0, seedUrl: url, parentUrl: null });
}

/**
 * Add a URL to the frontier unless we have seen it before.
 * Marking "seen" at ENQUEUE time (not at fetch time) is the key BFS detail:
 * if page A and page B both link to C before C is fetched, C must still be
 * queued only once.
 */
function enqueue(ctx, item) {
  if (ctx.seen.has(item.url)) {
    ctx.stats.duplicatesAvoided++;
    return;
  }
  ctx.seen.add(item.url);
  ctx.queue.push({ ...item, discoveredAt: new Date() });
}

async function processItem(ctx, item) {
  // Record the URL before doing any work, so a crash leaves a visible
  // "queued" trace. replaceOne resets fields left over from an earlier run.
  await ctx.deps.PageModel.replaceOne({ normalizedUrl: item.url }, newPageDoc(item), { upsert: true });

  // Check robots.txt first so a disallowed URL is never requested at all.
  const verdict = await ctx.deps.robots.check(item.url);
  if (!verdict.allowed) return markSkipped(ctx, item, verdict.reason);

  const res = await fetchItem(ctx, item);
  if (res) await parseItem(ctx, item, res);
}

function newPageDoc(item) {
  return {
    normalizedUrl: item.url,
    originalUrl: item.originalUrl,
    host: hostOf(item.url),
    depth: item.depth,
    seedUrl: item.seedUrl,
    parentUrl: item.parentUrl,
    status: "queued",
    discoveredAt: item.discoveredAt,
  };
}

/** Fetch one page and store its raw HTML. Returns the fetch result, or null on failure/skip. */
async function fetchItem(ctx, item) {
  ctx.stats.attempted++;
  const res = await ctx.deps.fetcher.fetchUrl(item.url, {
    beforeRequest: (url, hop) => beforeEachRequest(ctx, item, url, hop),
  });
  // A redirect target is the same document as its source: remember it so a
  // later link to it is not fetched a second time.
  for (const url of res.redirects) ctx.seen.add(url);

  const fetchFields = {
    httpStatus: res.httpStatus,
    finalUrl: res.finalUrl,
    contentType: res.contentType,
    fetchedAt: res.finishedAt,
  };
  if (!res.ok) {
    if (SKIP_CODES.has(res.errorCode)) await markSkipped(ctx, item, res.errorCode === "blocked" ? res.error : "not_html", fetchFields);
    else await markFailed(ctx, item, res.error, fetchFields);
    return null;
  }

  const raw = await ctx.deps.store.putRawHtml(res.body);
  await setPage(ctx, item, { ...fetchFields, status: "fetched", sizeBytes: res.sizeBytes, contentHash: raw.hash, rawRef: raw.ref });
  ctx.stats.fetched++;
  return res;
}

/**
 * Runs before EVERY HTTP request, including each redirect hop.
 * Returns null to go ahead, or a reason string to stop the fetch.
 */
async function beforeEachRequest(ctx, item, url, hop) {
  if (hop > 0) {
    if (ctx.limits.sameHostOnly && hostOf(url) !== hostOf(item.seedUrl)) return "redirect_off_host";
    if (ctx.seen.has(url)) return "redirect_to_seen_url"; // already queued or fetched
  }
  // Cached after the first call per origin, so repeating it here is cheap.
  // For hop 0 it was already checked in processItem; for redirects it is new.
  const verdict = await ctx.deps.robots.check(url);
  if (!verdict.allowed) return verdict.reason;

  await ctx.deps.politeness.waitTurn(hostOf(url), verdict.crawlDelayMs);
  return null;
}

async function parseItem(ctx, item, res) {
  let parsed;
  try {
    // Resolve relative links against the FINAL url: after a redirect from
    // /old/ to /new/, "page2.html" means /new/page2.html.
    parsed = parsePage(res.text, res.finalUrl);
  } catch (err) {
    return markFailed(ctx, item, `parse: ${err.message}`);
  }
  const text = await ctx.deps.store.putText(parsed.text);
  await setPage(ctx, item, {
    status: "parsed",
    title: parsed.title,
    canonicalUrl: parsed.canonicalUrl,
    textRef: text.ref,
    outlinks: parsed.links.map((link) => link.url),
    parsedAt: new Date(),
  });
  ctx.stats.parsed++;
  ctx.deps.log(`[${res.httpStatus}] depth=${item.depth} ${item.url} "${parsed.title}" (${parsed.links.length} links)`);
  enqueueLinks(ctx, item, parsed.links);
}

function enqueueLinks(ctx, parent, links) {
  const depth = parent.depth + 1;
  if (depth > ctx.limits.maxDepth) return;

  const seedHost = hostOf(parent.seedUrl);
  // Filter BEFORE capping, so the per-page budget is not wasted on links
  // to other hosts that would be thrown away anyway.
  const candidates = links
    .filter((link) => !ctx.limits.sameHostOnly || hostOf(link.url) === seedHost)
    .slice(0, ctx.limits.maxLinksPerPage);

  for (const link of candidates) {
    enqueue(ctx, { url: link.url, originalUrl: link.href, depth, seedUrl: parent.seedUrl, parentUrl: parent.url });
  }
}

async function markSkipped(ctx, item, reason, extra = {}) {
  ctx.stats.skipped[reason] = (ctx.stats.skipped[reason] ?? 0) + 1;
  ctx.deps.log(`[skip] ${item.url} (${reason})`);
  await setPage(ctx, item, { ...extra, status: "skipped", error: reason });
}

async function markFailed(ctx, item, error, extra = {}) {
  ctx.stats.failed++;
  ctx.deps.log(`[fail] ${item.url} (${error})`);
  await setPage(ctx, item, { ...extra, status: "failed", error });
}

function setPage(ctx, item, fields) {
  return ctx.deps.PageModel.updateOne({ normalizedUrl: item.url }, { $set: fields });
}

function summarize(ctx, startedAt) {
  const { stats } = ctx;
  return {
    ...stats,
    skippedRobots: (stats.skipped.robots_disallowed ?? 0) + (stats.skipped.robots_unreachable ?? 0),
    queuedRemaining: ctx.queue.length - ctx.head,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------- CLI

/** Read limits from CLI flags, falling back to env vars, then defaults. */
export function parseCliArgs(argv, env = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: "string", multiple: true },
      "max-pages": { type: "string" },
      "max-depth": { type: "string" },
      "max-links-per-page": { type: "string" },
      "all-hosts": { type: "boolean", default: false },
    },
  });
  const seeds = values.seed ?? (env.CRAWLER_SEEDS ? env.CRAWLER_SEEDS.split(",") : []);
  if (seeds.length === 0) throw new Error("At least one --seed <url> is required");

  return {
    seeds,
    maxPages: toInt("max-pages", values["max-pages"] ?? env.CRAWLER_MAX_PAGES, DEFAULT_LIMITS.maxPages, 1),
    maxDepth: toInt("max-depth", values["max-depth"] ?? env.CRAWLER_MAX_DEPTH, DEFAULT_LIMITS.maxDepth, 0),
    maxLinksPerPage: toInt("max-links-per-page", values["max-links-per-page"] ?? env.CRAWLER_MAX_LINKS_PER_PAGE, DEFAULT_LIMITS.maxLinksPerPage, 0),
    sameHostOnly: !(values["all-hosts"] || env.CRAWLER_SAME_HOST_ONLY === "false"),
  };
}

function toInt(name, raw, fallback, min) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

function printSummary(s) {
  console.log("\n===== Crawl summary =====");
  console.log(`fetched:             ${s.fetched}`);
  console.log(`parsed:              ${s.parsed}`);
  console.log(`skipped (robots):    ${s.skippedRobots}`);
  console.log(`skipped (all):       ${JSON.stringify(s.skipped)}`);
  console.log(`failed:              ${s.failed}`);
  console.log(`duplicates avoided:  ${s.duplicatesAvoided}`);
  console.log(`left in queue:       ${s.queuedRemaining}`);
  console.log(`time taken:          ${(s.durationMs / 1000).toFixed(1)} s`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), process.env);
  const { MONGODB_URI, CRAWLER_USER_AGENT: userAgent } = process.env;
  // CLAUDE.md rule: the User-Agent must tell site owners how to reach us.
  if (!userAgent || !userAgent.includes("@")) {
    throw new Error('Set CRAWLER_USER_AGENT in .env, e.g. "MiniSearchBot/0.1 (+mailto:you@example.com)"');
  }
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in .env");

  // Same reason as in server/server.js: some networks refuse the SRV DNS
  // lookup that mongodb+srv:// needs. (Page fetches use the OS resolver, not this.)
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  await connectDb(MONGODB_URI);

  // CLAUDE.md rule: at least 1 s between requests. Env can only make it slower.
  const politeness = createPoliteness({ minDelayMs: Math.max(1000, Number(process.env.CRAWLER_MIN_DELAY_MS) || 0) });
  const fetcher = createFetcher({ userAgent });
  const robots = createRobots({ fetcher, politeness, userAgent });
  const store = createBlobStore(process.env.CRAWLER_DATA_DIR || DEFAULT_DATA_DIR);

  try {
    const summary = await crawl(options, { fetcher, robots, politeness, store, log: console.log });
    printSummary(summary);
  } finally {
    await fetcher.close();
    await mongoose.disconnect();
  }
}

// Run main() only when executed directly (node crawler/crawl.js), not when
// a test imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Crawl failed: ${err.message}`);
    process.exit(1);
  });
}
