import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { admitLinks, admitUrls, changeJobStatus, createJob, onPageBudgetExhausted, refreshJob, retryFailures } from "../../crawler/jobs/jobService.js";
import { buildIndex } from "../../indexer/buildIndex.js";
import Term from "../../server/models/Term.js";
import { jobStats } from "../../crawler/jobs/jobStats.js";
import { parsePage } from "../../crawler/parse.js";
import Content from "../../server/models/Content.js";
import CrawlJob from "../../server/models/CrawlJob.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import QueueMessage from "../../server/models/QueueMessage.js";
import { startMockServer } from "../helpers/mockServer.js";
import { buildPipeline, waitForJob } from "../helpers/pipeline.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
let dataDir;
let server;
let pipeline;
let flakyFailuresLeft; // /flaky answers 503 this many times, then 200
let pageVersion; // /versioned serves this version; it answers 304 while unchanged

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "pipeline-test-"));
});
after(async () => {
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.clear();
  flakyFailuresLeft = 0;
  pageVersion = 1;
  server = await startMockServer({
    "/versioned": (req, res) => {
      const lastModified = `Thu, 0${pageVersion} Jan 2026 00:00:00 GMT`;
      if (req.headers["if-modified-since"] === lastModified) return res.writeHead(304).end();
      res.writeHead(200, { "content-type": "text/html", "last-modified": lastModified }).end(`<title>Version ${pageVersion}</title><p>edition${pageVersion}</p>`);
    },
    "/flaky": (req, res) => {
      const failing = flakyFailuresLeft-- > 0;
      res.writeHead(failing ? 503 : 200, { "content-type": "text/html" }).end(failing ? "busy" : "<title>Flaky</title><p>ok now</p>");
    },
  });
});
afterEach(async () => {
  await pipeline?.close();
  pipeline = null;
  await server.close();
});

/** Create a job for the mock site, run workers until it completes. */
async function crawlMockSite(limits = {}, { seed = "/", pipelineOpts = {}, startOpts = {} } = {}) {
  pipeline = buildPipeline({ dataDir, ...pipelineOpts });
  const job = await createJob({ seeds: [server.url(seed)], limits: { maxDepth: 5, ...limits } }, pipeline.queues);
  pipeline.start(startOpts);
  return waitForJob(job._id);
}

const urlDoc = (p) => CrawlUrl.findOne({ normalizedUrl: server.url(p) }).lean();
const stateOf = async (p) => (await urlDoc(p))?.state;
const requestsFor = (p) => server.pathsRequested().filter((x) => x === p).length;

test("end-to-end: fetch and parse workers crawl the whole mock site", async () => {
  const job = await crawlMockSite();
  assert.equal(job.completionReason, "frontier_empty");

  for (const p of ["/", "/about.html", "/products/a.html", "/products/b.html", "/deep/level1.html", "/deep/level2.html", "/deep/level3.html"]) {
    assert.equal(await stateOf(p), "parsed", p);
  }
  assert.equal(await stateOf("/index.html"), "duplicate"); // same bytes as "/"
  assert.equal((await urlDoc("/private/secret.html")).skipReason, "robots_disallowed");
  assert.equal((await urlDoc("/image.png")).skipReason, "not_html");
  assert.equal((await urlDoc("/moved")).skipReason, "redirect_to_known_url");
  assert.equal(await stateOf("/missing.html"), "failed"); // 404 is permanent: no retry
  assert.equal((await urlDoc("/missing.html")).fetch.attempts, 1);

  assert.equal(await QueueMessage.countDocuments(), 0, "both queues drained");
  assert.ok(!server.pathsRequested().includes("/private/secret.html"));
});

test("no URL is downloaded twice (URL-level dedup through the unique index)", async () => {
  const job = await crawlMockSite();
  const paths = server.pathsRequested();
  assert.deepEqual(paths.filter((p, i) => paths.indexOf(p) !== i), []);
  const reloaded = await CrawlJob.findById(job._id).lean();
  assert.ok(reloaded.counters.duplicateUrls > 0, "duplicate links were counted");
});

test("content dedup: identical HTML is parsed once and shared", async () => {
  await crawlMockSite();
  const [home, index] = await Promise.all([urlDoc("/"), urlDoc("/index.html")]);
  assert.equal(home.contentHash, index.contentHash);
  assert.equal(index.textRef, home.textRef);
  assert.equal(index.parse.attempts, 0, "the duplicate was never parsed");
  assert.equal(await Content.countDocuments({ _id: home.contentHash }), 1);
});

test("a temporary failure (503) is retried and then succeeds", async () => {
  flakyFailuresLeft = 2;
  await crawlMockSite({}, { seed: "/flaky" });
  const doc = await urlDoc("/flaky");
  assert.equal(doc.state, "parsed");
  assert.equal(doc.fetch.attempts, 3);
});

test("a failure that never recovers is dead-lettered, then retried by request", async () => {
  flakyFailuresLeft = 100;
  const job = await crawlMockSite({}, { seed: "/flaky", pipelineOpts: { maxAttempts: 2 } });
  assert.equal(await stateOf("/flaky"), "failed");
  assert.equal((await jobStats(job, pipeline.queues)).deadLetters.fetch, 1);

  flakyFailuresLeft = 0; // the site is fixed
  assert.equal(await retryFailures(job._id, pipeline.queues), 1);
  await waitForJob(job._id);
  assert.equal(await stateOf("/flaky"), "parsed");
});

test("a parse failure is retried from the STORED HTML, without fetching again", async () => {
  let calls = 0;
  const flakyParse = (html, url) => {
    if (url.endsWith("/about.html") && calls++ === 0) throw new Error("parser exploded");
    return parsePage(html, url);
  };
  await crawlMockSite({ maxDepth: 1 }, { pipelineOpts: { parse: flakyParse } });
  const about = await urlDoc("/about.html");
  assert.equal(about.state, "parsed");
  assert.equal(about.parse.attempts, 2);
  assert.equal(about.fetch.attempts, 1);
  assert.equal(requestsFor("/about.html"), 1);
});

test("idempotency: the same fetch and parse message handled twice changes nothing", async () => {
  pipeline = buildPipeline({ dataDir });
  await createJob({ seeds: [server.url("/")], limits: { maxDepth: 1 } }, pipeline.queues);

  const fetchMsg = await pipeline.queues.fetchQueue.lease("test");
  await pipeline.handleFetch(fetchMsg);
  await pipeline.handleFetch(fetchMsg); // redelivered (e.g. after a lost ack)
  assert.equal(requestsFor("/"), 1, "downloaded once");

  const parseMsg = await pipeline.queues.parseQueue.lease("test");
  await pipeline.handleParse(parseMsg);
  const urlsAfterFirst = await CrawlUrl.countDocuments();
  await pipeline.handleParse(parseMsg);
  assert.equal(await CrawlUrl.countDocuments(), urlsAfterFirst, "no duplicate URLs");
  assert.equal(await QueueMessage.countDocuments({ queue: "parse" }), 0);
  assert.equal(await stateOf("/"), "parsed");
});

test("two fetch-worker 'processes' stay polite together (>= 1 s per host)", async () => {
  await crawlMockSite({ maxPages: 3, maxDepth: 1 }, { pipelineOpts: { minDelayMs: 1000 }, startOpts: { fetchProcesses: 2 } });
  const times = server.requests.map((r) => r.at).sort((a, b) => a - b); // robots.txt + 3 pages
  assert.equal(times.length, 4);
  // Measured on the server, so allow a few ms of network jitter.
  // 950 not 1000: server-side timing under parallel test load (see crawl.test.js).
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 950, `gap ${times[i] - times[i - 1]} ms`);
});

// ---------------------------------------------------------------- limits

test("limit maxDepth", async () => {
  await crawlMockSite({ maxDepth: 1 });
  assert.equal(await CrawlUrl.countDocuments({ depth: { $gt: 1 } }), 0);
  assert.ok(!server.pathsRequested().includes("/deep/level2.html"));
});

test("limit maxPages: budget used up, the rest is skipped, reason recorded", async () => {
  const job = await crawlMockSite({ maxPages: 3 });
  assert.equal(job.completionReason, "max_pages");
  assert.equal(await CrawlUrl.countDocuments({ "fetch.attempts": { $gt: 0 } }), 3);
  assert.ok((await CrawlUrl.countDocuments({ skipReason: "max_pages" })) > 0);
});

test("maxPages used up: waiting URLs are dropped in bulk, budgeted ones are kept", async () => {
  pipeline = buildPipeline({ dataDir });
  const { fetchQueue } = pipeline.queues;
  const job = await createJob({ seeds: [server.url("/")] }, pipeline.queues); // seed: queued, not budgeted
  const retrying = await CrawlUrl.create({
    jobId: job._id, normalizedUrl: server.url("/about.html"), originalUrl: "about.html", host: "x",
    depth: 1, seedUrl: server.url("/"), fetch: { budgeted: true, attempts: 1 }, // took budget, waiting for a retry
  });
  await fetchQueue.enqueue({ jobId: job._id, urlId: retrying._id });

  assert.equal(await onPageBudgetExhausted(job._id, pipeline.queues), 1);
  assert.equal((await urlDoc("/")).skipReason, "max_pages");
  assert.equal(await QueueMessage.countDocuments({ urlId: (await urlDoc("/"))._id }), 0, "its message is gone");
  assert.equal((await urlDoc("/about.html")).state, "queued", "a budgeted URL must still be fetched");
  assert.equal(await QueueMessage.countDocuments({ urlId: retrying._id }), 1);

  assert.equal(await onPageBudgetExhausted(job._id, pipeline.queues), 0, "runs once per job");
  const reloaded = await CrawlJob.findById(job._id).lean();
  const admitted = await admitUrls(reloaded, [{ url: server.url("/new"), depth: 1, seedUrl: server.url("/") }], pipeline.queues);
  assert.equal(admitted.inserted, 0, "no new links after the budget is used up");
});

test("limit maxPagesPerHost", async () => {
  await crawlMockSite({ maxPagesPerHost: 2 });
  assert.equal(await CrawlUrl.countDocuments({ "fetch.attempts": { $gt: 0 } }), 2);
  assert.ok((await CrawlUrl.countDocuments({ skipReason: "max_pages_per_host" })) > 0);
});

test("limit maxLinksPerPage", async () => {
  await crawlMockSite({ maxDepth: 1, maxLinksPerPage: 2 });
  assert.equal(await CrawlUrl.countDocuments(), 3); // seed + its first 2 links
});

test("limit excludePatterns", async () => {
  const job = await crawlMockSite({ excludePatterns: ["/deep/", "\\.png$"] });
  assert.equal(await CrawlUrl.countDocuments({ normalizedUrl: /deep|\.png$/ }), 0);
  assert.ok((await CrawlJob.findById(job._id).lean()).counters.excludedUrls > 0);
});

test("limit maxRedirects", async () => {
  await crawlMockSite({ maxRedirects: 2 }, { seed: "/chain/3" });
  assert.equal((await urlDoc("/chain/3")).fetch.lastError, "More than 2 redirects");
});

test("limit maxResponseBytes", async () => {
  await crawlMockSite({ maxResponseBytes: 1024 * 1024 }, { seed: "/big" });
  assert.equal(await stateOf("/big"), "failed");
  assert.match((await urlDoc("/big")).fetch.lastError, /over 1048576 bytes/);
});

test("limit requestTimeoutMs (a timeout is retried, then dead-lettered)", async () => {
  await crawlMockSite({ requestTimeoutMs: 200 }, { seed: "/slow", pipelineOpts: { maxAttempts: 2 } });
  const doc = await urlDoc("/slow");
  assert.equal(doc.state, "failed");
  assert.equal(doc.fetch.attempts, 2);
  assert.match(doc.fetch.lastError, /Timed out/);
});

test("limit jobTimeoutMs", async () => {
  const job = await crawlMockSite({ jobTimeoutMs: 1 });
  assert.equal(job.completionReason, "job_timeout");
  assert.equal((await urlDoc("/")).skipReason, "job_timeout");
});

// ---------------------------------------------------------------- pause / resume / cancel

test("a paused job does no work until it is resumed", async () => {
  pipeline = buildPipeline({ dataDir });
  const job = await createJob({ seeds: [server.url("/")], limits: { maxDepth: 1 } }, pipeline.queues);
  await changeJobStatus(job._id, "pause", pipeline.queues);
  pipeline.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(server.requests.length, 0, "nothing fetched while paused");

  await changeJobStatus(job._id, "resume", pipeline.queues);
  await waitForJob(job._id);
  assert.equal(await stateOf("/about.html"), "parsed");
});

test("cancel drops pending work and marks queued URLs as skipped", async () => {
  pipeline = buildPipeline({ dataDir });
  const job = await createJob({ seeds: [server.url("/"), server.url("/about.html")] }, pipeline.queues);
  const cancelled = await changeJobStatus(job._id, "cancel", pipeline.queues);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await QueueMessage.countDocuments({ jobId: job._id }), 0);
  assert.equal(await CrawlUrl.countDocuments({ jobId: job._id, skipReason: "job_cancelled" }), 2);
  await assert.rejects(() => changeJobStatus(job._id, "resume", pipeline.queues), /Cannot resume a cancelled job/);
});

test('order "inlinks": a URL linked from two pages outranks one linked from one page', async () => {
  pipeline = buildPipeline({ dataDir });
  const job = await createJob({ seeds: [server.url("/")], limits: { order: "inlinks" } }, pipeline.queues);
  const parent = (p) => ({ depth: 0, seedUrl: server.url("/"), normalizedUrl: server.url(p) });
  const link = (p) => ({ url: server.url(p), href: p });
  const reloaded = await CrawlJob.findById(job._id).lean();
  await admitLinks(reloaded, parent("/"), [link("/once.html"), link("/popular.html")], pipeline.queues);
  await admitLinks(reloaded, parent("/about.html"), [link("/popular.html")], pipeline.queues);

  const priorityOf = async (p) => (await QueueMessage.findOne({ urlId: (await urlDoc(p))._id }).lean()).priority;
  assert.equal(await priorityOf("/popular.html"), 2);
  assert.equal(await priorityOf("/once.html"), 1);
  // popular (2 votes) is leased before the older seed and once.html (1 vote each).
  assert.equal(String((await pipeline.queues.fetchQueue.lease("x")).urlId), String((await urlDoc("/popular.html"))._id));
});

test('order "bfs" (default) leaves every priority at 0', async () => {
  pipeline = buildPipeline({ dataDir });
  const job = await createJob({ seeds: [server.url("/")] }, pipeline.queues);
  const reloaded = await CrawlJob.findById(job._id).lean();
  await admitLinks(reloaded, { depth: 0, seedUrl: server.url("/"), normalizedUrl: server.url("/") }, [{ url: server.url("/a.html"), href: "a.html" }], pipeline.queues);
  assert.deepEqual([...new Set((await QueueMessage.find().lean()).map((m) => m.priority))], [0]);
});

test("a busy site: the message is put back for later instead of the worker sleeping", async () => {
  pipeline = buildPipeline({ dataDir, minDelayMs: 1000 });
  const { handleFetch, queues, deps } = pipeline;
  await createJob({ seeds: [server.url("/about.html")] }, queues);
  await deps.robots.check(server.url("/about.html")); // robots.txt cached first
  await deps.politeness.reserve(new URL(server.origin).host, 10_000); // next slot ~10 s away
  const requestsBefore = server.requests.length;

  const msg = await queues.fetchQueue.lease("w");
  const started = Date.now();
  assert.equal(await handleFetch(msg), "deferred");
  assert.ok(Date.now() - started < 2000, "returned at once instead of sleeping ~10 s");
  assert.equal(server.requests.length, requestsBefore, "no request was sent");

  const parked = await QueueMessage.findById(msg._id).lean();
  assert.equal(parked.status, "ready");
  assert.equal(parked.attempts, 0, "a postponement is not a failed attempt");
  assert.ok(parked.availableAt.getTime() - Date.now() > 8000, "due when the slot opens");
  assert.equal((await urlDoc("/about.html")).fetch.budgeted, false, "no page budget held while waiting");
});

test("a short politeness wait is still done in place", async () => {
  pipeline = buildPipeline({ dataDir, minDelayMs: 1000 });
  const { handleFetch, queues, deps } = pipeline;
  await createJob({ seeds: [server.url("/about.html")] }, queues);
  await deps.robots.check(server.url("/about.html"));
  await deps.politeness.reserve(new URL(server.origin).host); // next slot ~1 s away: under 3 s
  const msg = await queues.fetchQueue.lease("w");
  assert.notEqual(await handleFetch(msg), "deferred");
  assert.equal((await urlDoc("/about.html")).state, "fetched");
});

// ---------------------------------------------------------------- re-crawl

test("re-crawl of an unchanged page: conditional request, 304, not parsed again", async () => {
  const job = await crawlMockSite({ maxDepth: 0 }, { seed: "/versioned" });
  assert.equal((await urlDoc("/versioned")).fetch.lastModified, "Thu, 01 Jan 2026 00:00:00 GMT");

  assert.equal(await refreshJob(job._id, { olderThanMs: 0 }, pipeline.queues), 1);
  await waitForJob(job._id);

  const doc = await urlDoc("/versioned");
  assert.equal(doc.state, "parsed", "back where it was");
  assert.equal(doc.fetch.httpStatus, 304);
  assert.equal(doc.parse.attempts, 1, "not parsed again");
  assert.equal(doc.fetch.previousState, null);
  const last = server.requests.filter((r) => r.path === "/versioned").at(-1);
  assert.equal(last.headers["if-modified-since"], "Thu, 01 Jan 2026 00:00:00 GMT", "the validator was sent back");
});

test("re-crawl of a changed page: parsed again, and only the new version is indexed", async () => {
  const job = await crawlMockSite({ maxDepth: 0 }, { seed: "/versioned" });
  pageVersion = 2; // the site changed the page
  await refreshJob(job._id, { olderThanMs: 0 }, pipeline.queues);
  await waitForJob(job._id);

  const doc = await urlDoc("/versioned");
  assert.equal(doc.state, "parsed");
  assert.equal(doc.title, "Version 2");
  assert.equal(doc.parse.attempts, 2);

  const summary = await buildIndex({ blobStore: pipeline.deps.blobStore });
  assert.equal(summary.skipped.stale, 1, "the old version is no longer held by any URL");
  assert.ok(await Term.exists({ term: "edition2" }));
  assert.equal(await Term.exists({ term: "edition1" }), null);
});

test("refresh only picks pages fetched before the cutoff, and needs no page budget", async () => {
  const job = await crawlMockSite({ maxDepth: 0, maxPages: 1 }, { seed: "/versioned" });
  assert.equal(await refreshJob(job._id, { olderThanMs: 60 * 60 * 1000 }, pipeline.queues), 0, "fetched seconds ago: not stale");
  assert.equal(await refreshJob(job._id, { olderThanMs: 0 }, pipeline.queues), 1);
  await waitForJob(job._id);
  assert.equal((await urlDoc("/versioned")).fetch.httpStatus, 304, "re-checked although maxPages (1) was used up");
});

test("outlinks are stored once, on Content, not again on every URL record", async () => {
  await crawlMockSite();
  // The raw collection, so a schema default could not hide a stored field.
  const withField = await CrawlUrl.collection.countDocuments({ outlinks: { $exists: true } });
  assert.equal(withField, 0, "no URL record keeps a copy of the links");
  const home = await urlDoc("/");
  const content = await Content.findById(home.contentHash).lean();
  assert.ok(content.outlinks.includes(server.url("/about.html")), "the one copy, read by PageRank");
});
