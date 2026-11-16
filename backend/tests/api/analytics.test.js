import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { LocalBlobStore } from "../../crawler/storage/LocalBlobStore.js";
import { buildIndex } from "../../indexer/buildIndex.js";
import app from "../../server/app.js";
import Content from "../../server/models/Content.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import SearchLog from "../../server/models/SearchLog.js";
import { createIndexCache } from "../../server/lib/indexCache.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
let dataDir;
let blobStore;
let api;

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "analytics-api-test-"));
  blobStore = new LocalBlobStore(dataDir);
  app.locals.indexCache = createIndexCache({ checkEveryMs: 0 });
  app.locals.blobStore = blobStore;
  const server = app.listen(0);
  api = { server, base: `http://localhost:${server.address().port}/api` };
});
after(async () => {
  api.server.close();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.clear();
  // Two Wikipedia pages and one Medium article, all about castles.
  const jobId = new mongoose.Types.ObjectId();
  for (const [url, title, text] of [
    ["https://simple.wikipedia.org/wiki/Castle", "Castle", "A castle is a fortified building. Castle walls."],
    ["https://simple.wikipedia.org/wiki/Moat", "Moat", "A moat is water around a castle."],
    ["https://medium.com/@ann/castles-i-visited-1a2b", "Castles I visited", "My castle trip: three castle visits."],
  ]) {
    const { hash, ref: textRef } = await blobStore.putText(text);
    const u = await CrawlUrl.create({ jobId, normalizedUrl: url, originalUrl: url, host: new URL(url).host, depth: 0, seedUrl: url, state: "parsed", contentHash: hash });
    await Content.create({ _id: hash, rawRef: `raw/${hash}.html`, textRef, title, outlinks: [], firstUrlId: u._id, parsedAt: new Date() });
  }
  await buildIndex({ blobStore });
});

const get = async (route, params) => {
  const res = await fetch(`${api.base}/${route}?${new URLSearchParams(params)}`);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};
const postClick = async (body) => {
  const res = await fetch(`${api.base}/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.status;
};
/** The log is written AFTER the response (on purpose), so wait for it. */
async function waitForLog(id) {
  for (let i = 0; i < 50; i++) {
    const doc = await SearchLog.findById(id).lean();
    if (doc) return doc;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no log ${id}`);
}

// ------------------------------------------------------------- source filter

test("source tabs: counts for every source, results from the chosen one only", async () => {
  const all = await get("search", { q: "castle" });
  assert.deepEqual(all.body.sourceCounts, { all: 3, wikipedia: 2, medium: 1, other: 0 });
  assert.equal(all.body.corpusSize, 3);

  const medium = await get("search", { q: "castle", source: "medium" });
  assert.equal(medium.body.total, 1);
  assert.deepEqual(medium.body.results.map((r) => r.source), ["medium"]);
  assert.deepEqual(medium.body.sourceCounts, all.body.sourceCounts, "counts stay the same on every tab");

  assert.equal((await get("search", { q: "castle", source: "books" })).status, 400);
});

test("each result says where it comes from and how many pages link to it", async () => {
  const { body } = await get("search", { q: "moat" });
  assert.equal(body.results[0].source, "wikipedia");
  assert.equal(typeof body.results[0].inlinks, "number");
});

// ------------------------------------------------------------- logging

test("a search is logged under the browser's id, once, even if sent twice", async () => {
  const sid = "view-0001-abcd";
  const first = await get("search", { q: "Castle  Walls", sid });
  assert.equal(first.body.searchId, sid);
  await get("search", { q: "Castle  Walls", sid }); // React dev mode / retry
  const doc = await waitForLog(sid);
  assert.equal(await SearchLog.countDocuments(), 1, "idempotent: one log");
  assert.equal(doc.query, "Castle  Walls");
  assert.equal(doc.key, "castle walls", "folded, so equal queries group together");
  assert.deepEqual([doc.total, doc.shown, doc.page, doc.source], [1, 1, 1, "all"]);
});

test("without an id the server makes one up", async () => {
  const { body } = await get("search", { q: "moat" });
  assert.match(body.searchId, /^[0-9a-f-]{36}$/);
  await waitForLog(body.searchId);
});

test("a bad id is rejected, not stored", async () => {
  assert.equal((await get("search", { q: "moat", sid: "x" })).status, 400);
});

// ------------------------------------------------------------- clicks

test("a click is stored on its search; an unknown search is 404; bad input is 400", async () => {
  const sid = "view-0002-abcd";
  await get("search", { q: "castle", sid });
  await waitForLog(sid);
  assert.equal(await postClick({ searchId: sid, position: 2, url: "https://simple.wikipedia.org/wiki/Moat" }), 204);
  assert.deepEqual((await SearchLog.findById(sid).lean()).clicks.map((c) => c.position), [2]);

  assert.equal(await postClick({ searchId: "view-9999-none", position: 1, url: "https://a.test/" }), 404);
  assert.equal(await postClick({ searchId: sid, position: 0, url: "https://a.test/" }), 400);
  assert.equal(await postClick({ searchId: sid, position: 1, url: "not a url" }), 400);
});

// ------------------------------------------------------------- the dashboard

test("GET /api/trends: popular and trending queries, and popular reads from the index only", async () => {
  for (const [sid, q] of [["view-0003-abcd", "castle"], ["view-0004-abcd", "castle"], ["view-0005-abcd", "moat"], ["view-0006-abcd", "dragon"], ["view-0007-abcd", "dragon"]]) {
    await get("search", { q, sid });
    await waitForLog(sid);
  }
  await postClick({ searchId: "view-0003-abcd", position: 1, url: "https://simple.wikipedia.org/wiki/Castle" });
  await postClick({ searchId: "view-0004-abcd", position: 1, url: "https://simple.wikipedia.org/wiki/Castle" });
  // Anyone can POST a click with any URL: it must not reach the public page.
  await postClick({ searchId: "view-0005-abcd", position: 1, url: "https://spam.example/buy-now" });

  const { status, body } = await get("trends", {});
  assert.equal(status, 200);
  // "moat": 1 search (below the public minimum); "dragon": 2 searches but no results.
  assert.deepEqual(body.popular, [{ query: "castle", count: 2 }]);
  assert.deepEqual(body.trending.map((t) => [t.query, t.today, t.isNew]), [["castle", 2, true]]);
  assert.deepEqual(body.reads, [{ url: "https://simple.wikipedia.org/wiki/Castle", readers: 2, title: "Castle", source: "wikipedia" }]);
  assert.deepEqual(Object.keys(body).sort(), ["popular", "reads", "trending"], "no site-health numbers on the public endpoint");
});

test("the old site-health endpoint is gone from the public API", async () => {
  assert.equal((await get("analytics", { days: 7 })).status, 404);
});
