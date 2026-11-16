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
import { startTestDb } from "../helpers/testDb.js";

let db;
let dataDir;
let blobStore;
let api;

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "index-api-test-"));
  blobStore = new LocalBlobStore(dataDir);
  const server = app.listen(0);
  api = { server, base: `http://localhost:${server.address().port}/api` };
});
after(async () => {
  api.server.close();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(() => db.clear());

async function get(route) {
  const res = await fetch(`${api.base}${route}`);
  return { status: res.status, body: await res.json() };
}

async function seedAndBuild(pages) {
  const jobId = new mongoose.Types.ObjectId();
  for (const { url, title, text } of pages) {
    const { hash, ref: textRef } = await blobStore.putText(text);
    const u = await CrawlUrl.create({ jobId, normalizedUrl: url, originalUrl: url, host: "a.test", depth: 0, seedUrl: url, state: "parsed", contentHash: hash });
    await Content.create({ _id: hash, rawRef: `raw/${hash}.html`, textRef, title, firstUrlId: u._id, parsedAt: new Date() });
  }
  await buildIndex({ blobStore });
}

test("before any build, both endpoints say how to build the index", async () => {
  for (const route of ["/index/stats", "/index/terms/cat"]) {
    const { status, body } = await get(route);
    assert.equal(status, 404);
    assert.match(body.error, /npm run index:build/);
  }
});

test("GET /api/index/stats returns the corpus numbers", async () => {
  await seedAndBuild([{ url: "https://a.test/1", title: "One", text: "alpha beta" }]);
  const { status, body } = await get("/index/stats");
  assert.equal(status, 200);
  assert.equal(body.stats.N, 1);
  assert.equal(body.stats._id, undefined); // internal id not exposed
});

test("the word is tokenized like the indexer did: 'Running' finds a page that says 'runs'", async () => {
  await seedAndBuild([
    { url: "https://a.test/run", title: "Training", text: "She runs daily and runs fast" },
    { url: "https://a.test/swim", title: "Swimming", text: "Swimming is fun" },
  ]);
  const { status, body } = await get("/index/terms/Running");
  assert.equal(status, 200);
  assert.deepEqual(body.terms, ["run"]);
  const [run] = body.results;
  assert.equal(run.df, 1);
  assert.deepEqual(run.pages.map((p) => [p.url, p.tf]), [["https://a.test/run", 2]]);
});

test("pages are listed by how often they contain the term, most first", async () => {
  await seedAndBuild([
    { url: "https://a.test/once", title: "", text: "cat" },
    { url: "https://a.test/thrice", title: "", text: "cat cat cat" },
  ]);
  const { body } = await get("/index/terms/cat");
  assert.deepEqual(body.results[0].pages.map((p) => p.tf), [3, 1]);
});

test("several words: one result per distinct term", async () => {
  await seedAndBuild([{ url: "https://a.test/1", title: "", text: "cats and dogs" }]);
  const { body } = await get(`/index/terms/${encodeURIComponent("Cats DOGS cat")}`);
  assert.deepEqual(body.terms, ["cat", "dog"]);
  assert.equal(body.results.length, 2);
});

test("a word that is not in the index returns df 0, not an error", async () => {
  await seedAndBuild([{ url: "https://a.test/1", title: "", text: "cats" }]);
  const { status, body } = await get("/index/terms/zebra");
  assert.equal(status, 200);
  assert.deepEqual(body.results, [{ term: "zebra", df: 0, pages: [] }]);
});

test("a stopword-only input is a 400 that explains why", async () => {
  const { status, body } = await get("/index/terms/the");
  assert.equal(status, 400);
  assert.match(body.error, /stopwords/);
});

test("limit is validated and applied", async () => {
  // Distinct texts: identical text = identical hash = one Content (dedup).
  await seedAndBuild(Array.from({ length: 5 }, (_, i) => ({ url: `https://a.test/${i}`, title: "", text: `word page${i}` })));
  assert.equal((await get("/index/terms/word?limit=0")).status, 400);
  assert.equal((await get("/index/terms/word?limit=abc")).status, 400);
  const { body } = await get("/index/terms/word?limit=2");
  assert.equal(body.results[0].df, 5); // df is the true count...
  assert.equal(body.results[0].pages.length, 2); // ...even when fewer pages are listed
});
