import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Page from "../../server/models/Page.js";
import { crawl, parseCliArgs } from "../../crawler/crawl.js";
import { createFetcher } from "../../crawler/fetcher.js";
import { createPoliteness } from "../../crawler/politeness.js";
import { createRobots } from "../../crawler/robots.js";
import { createBlobStore, sha256 } from "../../crawler/storage.js";
import { startMockServer } from "../helpers/mockServer.js";
import { startTestDb } from "../helpers/testDb.js";

const USER_AGENT = "MiniSearchBot/0.1 (+mailto:test@example.com)";
let db;
let server;
let dataDir;
let fetcher;

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "crawl-test-"));
  fetcher = createFetcher({ userAgent: USER_AGENT, totalTimeoutMs: 2000 });
});
after(async () => {
  await server?.close();
  await fetcher.close();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.clear();
  if (server) await server.close();
  server = await startMockServer();
});

/** Run a crawl of the mock site. minDelayMs 0 keeps tests fast (it is our own local server). */
function runCrawl(limits, { minDelayMs = 0 } = {}) {
  const politeness = createPoliteness({ minDelayMs });
  const robots = createRobots({ fetcher, politeness, userAgent: USER_AGENT });
  const store = createBlobStore(dataDir);
  return crawl({ seeds: [server.url("/")], ...limits }, { fetcher, robots, politeness, store });
}

const statusOf = async (p) => (await Page.findOne({ normalizedUrl: server.url(p) }).lean())?.status;

test("end-to-end: crawls the mock site and records every outcome", async () => {
  const summary = await runCrawl({ maxPages: 50, maxDepth: 5 });

  for (const p of ["/", "/about.html", "/products/a.html", "/products/b.html", "/deep/level1.html", "/deep/level2.html", "/deep/level3.html"]) {
    assert.equal(await statusOf(p), "parsed", p);
  }
  assert.equal(await statusOf("/private/secret.html"), "skipped"); // robots.txt
  assert.equal(await statusOf("/image.png"), "skipped"); // not HTML
  assert.equal(await statusOf("/moved"), "skipped"); // redirects to an already-queued page
  assert.equal(await statusOf("/missing.html"), "failed"); // 404

  // "/" and "/index.html" are different URLs serving identical bytes. URL
  // normalization cannot merge them safely (a server MAY serve different
  // pages), so both are crawled; the equal contentHash exposes the duplicate.
  // Skipping such content duplicates is a Stage 2 feature.
  assert.equal(await statusOf("/index.html"), "parsed");
  const [home, indexPage] = await Promise.all(["/", "/index.html"].map((p) => Page.findOne({ normalizedUrl: server.url(p) }).lean()));
  assert.equal(home.contentHash, indexPage.contentHash);

  assert.equal(summary.parsed, 8);
  assert.equal(summary.skippedRobots, 1);
  assert.equal(summary.failed, 1);
  assert.ok(summary.duplicatesAvoided > 0);
  // The secret page was never requested, and nothing outside the mock site was stored.
  assert.ok(!server.pathsRequested().includes("/private/secret.html"));
  assert.equal(await Page.countDocuments({ host: { $ne: new URL(server.origin).host } }), 0);
});

test("never fetches the same URL twice", async () => {
  await runCrawl({ maxPages: 50, maxDepth: 5 });
  const paths = server.pathsRequested();
  const repeated = paths.filter((p, i) => paths.indexOf(p) !== i);
  assert.deepEqual(repeated, []);
});

test("respects maxDepth: nothing deeper than the limit is fetched", async () => {
  await runCrawl({ maxPages: 50, maxDepth: 1 });
  assert.equal(await Page.countDocuments({ depth: { $gt: 1 } }), 0);
  assert.ok(!server.pathsRequested().includes("/deep/level2.html"));
  assert.equal(await statusOf("/deep/level1.html"), "parsed");
});

test("respects maxPages: at most N page requests", async () => {
  const summary = await runCrawl({ maxPages: 3, maxDepth: 5 });
  assert.equal(summary.attempted, 3);
  const pageRequests = server.pathsRequested().filter((p) => p !== "/robots.txt");
  assert.ok(pageRequests.length <= 3, `made ${pageRequests.length} page requests`);
});

test("respects maxLinksPerPage", async () => {
  await runCrawl({ maxPages: 50, maxDepth: 1, maxLinksPerPage: 2 });
  // Seed + its first 2 same-host links.
  assert.equal(await Page.countDocuments(), 3);
});

test("stores raw HTML and text as hash-named files; the Page keeps only references", async () => {
  await runCrawl({ maxPages: 1, maxDepth: 0 });
  const page = await Page.findOne({ normalizedUrl: server.url("/") }).lean();
  const raw = await readFile(path.join(dataDir, page.rawRef));
  assert.equal(sha256(raw), page.contentHash);
  assert.match(await readFile(path.join(dataDir, page.textRef), "utf8"), /Welcome to the mock shop/);
  assert.equal(page.title, "Mock Home");
  assert.equal(page.depth, 0);
  assert.equal(page.html, undefined);
  assert.ok(page.outlinks.includes(server.url("/about.html")));
});

test("records parent, seed and original href for discovered pages", async () => {
  await runCrawl({ maxPages: 50, maxDepth: 1 });
  const about = await Page.findOne({ normalizedUrl: server.url("/about.html") }).lean();
  assert.equal(about.parentUrl, server.url("/"));
  assert.equal(about.seedUrl, server.url("/"));
  assert.equal(about.originalUrl, "about.html"); // the nav link comes first in the HTML
  assert.equal(about.depth, 1);
});

test("politeness: requests to the same host start >= 1 s apart", async () => {
  await runCrawl({ maxPages: 2, maxDepth: 1 }, { minDelayMs: 1000 });
  const times = server.requests.map((r) => r.at); // robots.txt + 2 pages
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) {
    // Measured on the SERVER, so allow a few ms for the first request's TCP
    // connection setup making it arrive later than its start. The exact
    // ">= 1000 ms" rule is tested on the client side in politeness.test.js.
    assert.ok(times[i] - times[i - 1] >= 980, `gap ${i} was ${times[i] - times[i - 1]} ms`);
  }
});

test("an invalid seed is reported, not fatal", async () => {
  const politeness = createPoliteness({ minDelayMs: 0 });
  const robots = createRobots({ fetcher, politeness, userAgent: USER_AGENT });
  const summary = await crawl({ seeds: ["not a url"] }, { fetcher, robots, politeness, store: createBlobStore(dataDir) });
  assert.equal(summary.invalidSeeds, 1);
  assert.equal(summary.attempted, 0);
});

test("parseCliArgs reads repeated seeds and numeric limits", () => {
  const opts = parseCliArgs(["--seed", "https://a.com/", "--seed", "https://b.com/", "--max-pages", "30", "--max-depth", "0"]);
  assert.deepEqual(opts, { seeds: ["https://a.com/", "https://b.com/"], maxPages: 30, maxDepth: 0, maxLinksPerPage: 100, sameHostOnly: true });
});

test("parseCliArgs falls back to env, and rejects bad numbers", () => {
  const opts = parseCliArgs(["--seed", "https://a.com/"], { CRAWLER_MAX_PAGES: "7", CRAWLER_SAME_HOST_ONLY: "false" });
  assert.equal(opts.maxPages, 7);
  assert.equal(opts.sameHostOnly, false);
  assert.throws(() => parseCliArgs(["--seed", "https://a.com/", "--max-pages", "abc"]), /max-pages/);
  assert.throws(() => parseCliArgs([]), /--seed/);
});
