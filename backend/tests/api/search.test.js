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
import { createIndexCache } from "../../server/lib/indexCache.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
let dataDir;
let blobStore;
let api;

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "search-api-test-"));
  blobStore = new LocalBlobStore(dataDir);
  // Tests rebuild the index between cases: re-check it on every request,
  // and read snippets from this test's temp folder.
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
beforeEach(() => db.clear());

async function search(params) {
  const res = await fetch(`${api.base}/search?${new URLSearchParams(params)}`);
  return { status: res.status, body: await res.json() };
}

/** Store pages the way the crawler would, then build the real index. */
async function seedAndBuild(pages, { maxChunkBytes } = {}) {
  const jobId = new mongoose.Types.ObjectId();
  for (const { url, title = "", text, outlinks = [] } of pages) {
    const { hash, ref: textRef } = await blobStore.putText(text);
    const u = await CrawlUrl.create({ jobId, normalizedUrl: url, originalUrl: url, host: "a.test", depth: 0, seedUrl: url, state: "parsed", contentHash: hash });
    await Content.create({ _id: hash, rawRef: `raw/${hash}.html`, textRef, title, outlinks, firstUrlId: u._id, parsedAt: new Date() });
  }
  await buildIndex({ blobStore, ...(maxChunkBytes && { maxChunkBytes }) });
}

const PAGES = [
  { url: "https://a.test/graph-theory", title: "Graph theory", text: "Graph theory studies graphs made of vertices and edges." },
  { url: "https://a.test/graphs", title: "Graphs", text: "A bar graph shows data. Graphs are pictures." },
  { url: "https://a.test/music-theory", title: "Music theory", text: "Music theory explains harmony." },
  { url: "https://a.test/cats", title: "Cats", text: "Cats are running and playing." },
];
const urls = (body) => body.results.map((r) => r.url).sort();

test("AND: 'graph theory' returns only pages with BOTH words (the M4 done-when)", async () => {
  await seedAndBuild(PAGES);
  const { status, body } = await search({ q: "graph theory" });
  assert.equal(status, 200);
  assert.deepEqual(urls(body), ["https://a.test/graph-theory"]);
  assert.equal(body.total, 1);
});

test("one word returns every page that contains it", async () => {
  await seedAndBuild(PAGES);
  const { body } = await search({ q: "theory" });
  assert.deepEqual(urls(body), ["https://a.test/graph-theory", "https://a.test/music-theory"]);
});

test("the query goes through the indexer's tokenizer: case, plurals, -ing", async () => {
  await seedAndBuild(PAGES);
  assert.deepEqual(urls((await search({ q: "GRAPHS" })).body), ["https://a.test/graph-theory", "https://a.test/graphs"]);
  assert.deepEqual(urls((await search({ q: "run" })).body), ["https://a.test/cats"], "'run' finds 'running'");
});

test("stopwords in the query are ignored, duplicates collapse", async () => {
  await seedAndBuild(PAGES);
  const { body } = await search({ q: "the theory of graphs graph" });
  assert.deepEqual(body.terms.map((t) => t.term), ["theori", "graph"]);
  assert.deepEqual(urls(body), ["https://a.test/graph-theory"]);
});

test("a word in no document: empty result, and it is named in missingTerms", async () => {
  await seedAndBuild(PAGES);
  const { status, body } = await search({ q: "graph zebra" });
  assert.equal(status, 200);
  assert.equal(body.total, 0);
  assert.deepEqual(body.missingTerms, ["zebra"]);
  assert.deepEqual(body.terms.find((t) => t.term === "zebra"), { term: "zebra", df: 0 });
});

test("each term reports its df (document frequency)", async () => {
  await seedAndBuild(PAGES);
  const { body } = await search({ q: "graph theory" });
  assert.deepEqual(body.terms, [{ term: "graph", df: 2 }, { term: "theori", df: 2 }]);
});

test("pagination: total counts all matches, results hold one page", async () => {
  await seedAndBuild(Array.from({ length: 5 }, (_, i) => ({ url: `https://a.test/${i}`, text: `common word page${i}` })));
  const first = (await search({ q: "common", limit: 2, page: 1 })).body;
  const third = (await search({ q: "common", limit: 2, page: 3 })).body;
  assert.equal(first.total, 5);
  assert.equal(first.results.length, 2);
  assert.equal(third.results.length, 1);
  const seen = new Set([...first.results, ...(await search({ q: "common", limit: 2, page: 2 })).body.results, ...third.results].map((r) => r.docId));
  assert.equal(seen.size, 5, "the three pages together list every match once");
});

test("chunked postings lists are joined correctly before intersecting", async () => {
  // A tiny chunk size forces 'word' (on every page) into many chunks.
  await seedAndBuild(Array.from({ length: 30 }, (_, i) => ({ url: `https://a.test/${i}`, text: `word page${i}${i % 3 === 0 ? " special" : ""}` })), { maxChunkBytes: 120 });
  const { body } = await search({ q: "word special", limit: 50 });
  assert.equal(body.total, 10);
});

test("input errors are 400 with a reason", async () => {
  await seedAndBuild(PAGES);
  assert.equal((await search({})).status, 400, "q is required");
  assert.equal((await search({ q: "   " })).status, 400, "blank q");
  assert.equal((await search({ q: "x".repeat(201) })).status, 400, "too long");
  assert.equal((await search({ q: "cat", limit: 0 })).status, 400);
  assert.equal((await search({ q: "cat", page: "abc" })).status, 400);
  assert.equal((await search({ q: "cat", sort: "title" })).status, 400, "unknown parameter");

  const stop = await search({ q: "the and of" });
  assert.equal(stop.status, 400);
  assert.match(stop.body.error, /stopwords/);

  const tooMany = await search({ q: "a1 b2 c3 d4 e5 f6 g7 h8 i9 j10 k11" });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /Too many words/);
});

test("before the index is built: 404 that says how to build it", async () => {
  const { status, body } = await search({ q: "graph" });
  assert.equal(status, 404);
  assert.match(body.error, /npm run index:build/);
});

test("the response reports how long the search took", async () => {
  await seedAndBuild(PAGES);
  const { body } = await search({ q: "graph" });
  assert.equal(typeof body.tookMs, "number");
  assert.ok(body.tookMs >= 0);
});

// ---------------------------------------------------------------- M5-M8: ranking and snippets

const RANKED = [
  // A focused page about the solar system, and a long page that mentions it once.
  { url: "https://a.test/focused", title: "Solar System", text: "The solar system has eight planets. The solar system formed from a cloud." },
  { url: "https://a.test/long", title: "Space history", text: `solar system ${"history of rockets and space travel ".repeat(40)}` },
  // A hub: no query words in its text, but every other page links to it.
  { url: "https://a.test/hub", title: "Main page", text: "Welcome to the solar encyclopedia system", outlinks: [] },
];
const withLinksToHub = RANKED.map((p) => (p.url.endsWith("hub") ? p : { ...p, outlinks: ["https://a.test/hub"] }));
const order = (body) => body.results.map((r) => r.url.split("/").pop());

test("rank=bm25: the focused page beats the long page that mentions the words once", async () => {
  await seedAndBuild(withLinksToHub);
  const { body } = await search({ q: "solar system", rank: "bm25" });
  assert.equal(order(body)[0], "focused");
  assert.ok(body.results[0].score > body.results[1].score);
});

test("rank=pagerank: the most linked-to page comes first", async () => {
  await seedAndBuild(withLinksToHub);
  const { body } = await search({ q: "solar system", rank: "pagerank" });
  assert.equal(order(body)[0], "hub");
});

test("rank=combined: alpha 1 equals BM25 order, alpha 0 equals PageRank order", async () => {
  await seedAndBuild(withLinksToHub);
  const bm25 = order((await search({ q: "solar system", rank: "bm25" })).body);
  const pr = order((await search({ q: "solar system", rank: "pagerank" })).body);
  assert.deepEqual(order((await search({ q: "solar system", rank: "combined", alpha: 1 })).body), bm25);
  assert.deepEqual(order((await search({ q: "solar system", rank: "combined", alpha: 0 })).body), pr);
  // The default is BM25: it won the M7 evaluation (eval/results.md).
  const def = (await search({ q: "solar system" })).body;
  assert.equal(def.rank, "bm25");
  assert.equal(def.alpha, null);
});

test("rank=none keeps docId order (the unranked M4 behaviour)", async () => {
  await seedAndBuild(withLinksToHub);
  const { body } = await search({ q: "solar system", rank: "none" });
  const ids = body.results.map((r) => r.docId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(body.results[0].score, null);
});

test("mode=any (OR) also returns pages with only some of the words, ranked lower", async () => {
  await seedAndBuild([
    { url: "https://a.test/both", text: "graph theory" },
    { url: "https://a.test/one", text: "theory of music" },
  ]);
  assert.deepEqual(order((await search({ q: "graph theory", mode: "all" })).body), ["both"]);
  assert.deepEqual(order((await search({ q: "graph theory", mode: "any", rank: "bm25" })).body), ["both", "one"]);
});

test("each result has a snippet with the query words highlighted", async () => {
  await seedAndBuild(withLinksToHub);
  const { body } = await search({ q: "planets", rank: "bm25" });
  const highlighted = body.results[0].snippet.fragments.filter((f) => f.highlight).map((f) => f.text);
  assert.deepEqual(highlighted, ["planets"]);
});

test("ranking parameters are validated", async () => {
  await seedAndBuild(PAGES);
  assert.equal((await search({ q: "graph", rank: "magic" })).status, 400);
  assert.equal((await search({ q: "graph", mode: "some" })).status, 400);
  assert.equal((await search({ q: "graph", alpha: 2 })).status, 400);
});

// ---------------------------------------------------------------- M9: autocomplete

async function suggest(params) {
  const res = await fetch(`${api.base}/suggest?${new URLSearchParams(params)}`);
  return { status: res.status, body: await res.json() };
}

test("GET /api/suggest completes page titles, most linked-to first", async () => {
  await seedAndBuild([
    { url: "https://a.test/fr", title: "French Revolution", text: "revolution in france" },
    { url: "https://a.test/f", title: "France", text: "a country", outlinks: [] },
    { url: "https://a.test/x", title: "Freedom", text: "being free", outlinks: ["https://a.test/f"] },
    { url: "https://a.test/y", title: "Paris", text: "a city", outlinks: ["https://a.test/f"] },
  ]);
  const { status, body } = await suggest({ q: "Fr" });
  assert.equal(status, 200);
  assert.equal(body.suggestions[0].text, "France", "two pages link to France");
  assert.deepEqual(body.suggestions.map((s) => s.text).sort(), ["France", "Freedom", "French Revolution"]);
  assert.equal(body.suggestions[0].url, "https://a.test/f");
  assert.deepEqual((await suggest({ q: "revol" })).body.suggestions.map((s) => s.text), ["French Revolution"], "matches a later word too");
  assert.deepEqual((await suggest({ q: "zzz" })).body.suggestions, []);
});

test("GET /api/suggest validates input and needs a built index", async () => {
  assert.equal((await suggest({ q: "fr" })).status, 404, "no index yet");
  await seedAndBuild(PAGES);
  assert.equal((await suggest({})).status, 400);
  assert.equal((await suggest({ q: "x".repeat(101) })).status, 400);
  assert.equal((await suggest({ q: "gr", limit: 20 })).status, 400);
  assert.equal((await suggest({ q: "gr", limit: 1 })).body.suggestions.length, 1);
});

// ---------------------------------------------------------------- phrases and typo tolerance

test('a "quoted phrase" needs the words next to each other, in order', async () => {
  await seedAndBuild([
    { url: "https://a.test/ny", text: "I moved to New York in 2010" },
    { url: "https://a.test/apart", text: "York is a new city" },
  ]);
  assert.deepEqual(order((await search({ q: "new york" })).body).sort(), ["apart", "ny"], "without quotes: both pages");
  const { body } = await search({ q: '"new york"' });
  assert.deepEqual(order(body), ["ny"]);
  assert.deepEqual(body.phrases, ["new york"]);
});

test("a phrase keeps the gap of a stopword inside it", async () => {
  await seedAndBuild([
    { url: "https://a.test/usa", text: "the United States of America" },
    { url: "https://a.test/other", text: "America of the United States" },
  ]);
  assert.deepEqual(order((await search({ q: '"united states of america"' })).body), ["usa"]);
});

test("a phrase is required even in mode=any; loose words then only help ranking", async () => {
  await seedAndBuild([
    { url: "https://a.test/ny", text: "New York pizza" },
    { url: "https://a.test/pizza", text: "pizza from Naples" },
  ]);
  assert.deepEqual(order((await search({ q: '"new york" pizza', mode: "any" })).body), ["ny"]);
});

const FRANCE = [
  { url: "https://a.test/fr1", title: "France", text: "France is a country in Europe" },
  { url: "https://a.test/fr2", title: "French Revolution", text: "The revolution in France began in 1789" },
];

test("a misspelled word is corrected to the closest real word", async () => {
  await seedAndBuild(FRANCE);
  const { body } = await search({ q: "frnce revolution" });
  assert.equal(body.correction.corrected, "france revolution");
  assert.deepEqual(body.correction.words, [{ from: "frnce", to: "france" }]);
  assert.equal(body.query, "france revolution");
  assert.deepEqual(order(body), ["fr2"]);
});

test("correct=false searches exactly what was typed", async () => {
  await seedAndBuild(FRANCE);
  const { body } = await search({ q: "frnce", correct: "false" });
  assert.equal(body.total, 0);
  assert.equal(body.correction, null);
  assert.deepEqual(body.missingTerms, ["frnce"]);
});

test("no correction when every word exists, or when nothing is close", async () => {
  await seedAndBuild(FRANCE);
  assert.equal((await search({ q: "france" })).body.correction, null);
  const far = (await search({ q: "qwertyuiop" })).body;
  assert.equal(far.correction, null);
  assert.equal(far.total, 0);
});
