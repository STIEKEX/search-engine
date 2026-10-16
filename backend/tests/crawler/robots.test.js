import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Domain from "../../server/models/Domain.js";
import { createFetcher } from "../../crawler/fetcher.js";
import { createPoliteness } from "../../crawler/politeness.js";
import { createRobots, ROBOTS_TTL_MS } from "../../crawler/robots.js";
import { startMockServer } from "../helpers/mockServer.js";
import { startTestDb } from "../helpers/testDb.js";

const USER_AGENT = "MiniSearchBot/0.1 (+mailto:test@example.com)";
let db;
let fetcher;

before(async () => {
  db = await startTestDb();
  fetcher = createFetcher({ userAgent: USER_AGENT, totalTimeoutMs: 2000 });
});
after(async () => {
  await fetcher.close();
  await db.stop();
});
beforeEach(() => db.clear());

// The mock server is ours and local, so no politeness delay is needed in unit tests.
function makeRobots(extra = {}) {
  return createRobots({ fetcher, politeness: createPoliteness({ minDelayMs: 0 }), userAgent: USER_AGENT, ...extra });
}

function robotsRoute(status, body = "") {
  return { "/robots.txt": (req, res) => res.writeHead(status, { "content-type": "text/plain" }).end(body) };
}

test("allows a URL that robots.txt does not mention", async () => {
  const server = await startMockServer(); // serves fixtures/site/robots.txt: Disallow: /private/
  const verdict = await makeRobots().check(server.url("/about.html"));
  assert.deepEqual(verdict, { allowed: true, reason: null, crawlDelayMs: 0 });
  await server.close();
});

test("disallows a URL under a Disallow rule", async () => {
  const server = await startMockServer();
  const verdict = await makeRobots().check(server.url("/private/secret.html"));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, "robots_disallowed");
  await server.close();
});

test("rules for our bot's own name apply to us", async () => {
  const server = await startMockServer(robotsRoute(200, "User-agent: MiniSearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"));
  assert.equal((await makeRobots().check(server.url("/anything"))).allowed, false);
  await server.close();
});

test("reads Crawl-delay (in seconds) and returns it in ms", async () => {
  const server = await startMockServer(robotsRoute(200, "User-agent: *\nCrawl-delay: 2\n"));
  const verdict = await makeRobots().check(server.url("/"));
  assert.equal(verdict.crawlDelayMs, 2000);
  await server.close();
});

test("404 robots.txt means allow everything", async () => {
  const server = await startMockServer(robotsRoute(404));
  const verdict = await makeRobots().check(server.url("/private/secret.html"));
  assert.equal(verdict.allowed, true);
  const doc = await Domain.findOne({ origin: server.origin }).lean();
  assert.equal(doc.robotsStatus, "allow-all");
  await server.close();
});

test("5xx robots.txt means do not crawl the host", async () => {
  const server = await startMockServer(robotsRoute(503));
  const verdict = await makeRobots().check(server.url("/about.html"));
  assert.deepEqual(verdict, { allowed: false, reason: "robots_unreachable", crawlDelayMs: 0 });
  await server.close();
});

test("network error on robots.txt means do not crawl the host", async () => {
  const server = await startMockServer();
  const url = server.url("/about.html");
  await server.close(); // nothing listens on this port any more
  const verdict = await makeRobots().check(url);
  assert.equal(verdict.reason, "robots_unreachable");
  const doc = await Domain.findOne({ origin: new URL(url).origin }).lean();
  assert.equal(doc.robotsStatus, "unreachable");
  assert.ok(doc.error);
});

test("robots.txt is downloaded once per origin and cached in memory and MongoDB", async () => {
  const server = await startMockServer();
  const robots = makeRobots();
  await robots.check(server.url("/a.html"));
  await robots.check(server.url("/b.html"));
  await makeRobots().check(server.url("/c.html")); // new instance: empty memory, uses MongoDB
  const robotsFetches = server.pathsRequested().filter((p) => p === "/robots.txt");
  assert.equal(robotsFetches.length, 1);

  const doc = await Domain.findOne({ origin: server.origin }).lean();
  assert.equal(doc.expiresAt - doc.fetchedAt, ROBOTS_TTL_MS);
  await server.close();
});

test("an expired cache entry is downloaded again", async () => {
  const server = await startMockServer();
  await makeRobots().check(server.url("/"));
  const tomorrow = () => new Date(Date.now() + ROBOTS_TTL_MS + 1000);
  await makeRobots({ now: tomorrow }).check(server.url("/"));
  assert.equal(server.pathsRequested().filter((p) => p === "/robots.txt").length, 2);
  await server.close();
});
