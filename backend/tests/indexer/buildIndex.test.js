import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mongoose from "mongoose";
import { LocalBlobStore } from "../../crawler/storage/LocalBlobStore.js";
import { addDocument, buildIndex, chunkPostings, countSpellings, documentTokens, mostCommonSpellings, newestVersionPerUrl, pageUrl, STAGING, TITLE_BODY_GAP } from "../../indexer/buildIndex.js";
import Content from "../../server/models/Content.js";
import CorpusStats from "../../server/models/CorpusStats.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import IndexedDocument from "../../server/models/IndexedDocument.js";
import Term from "../../server/models/Term.js";
import { analyze, analyzeWords } from "../../shared/tokenize.js";
import { startTestDb } from "../helpers/testDb.js";

// ================================================== pure functions (no DB)

describe("addDocument", () => {
  test("the 3-sentence example from the roadmap, worked by hand", () => {
    // doc 0: "Cats chase mice"           -> cat@0 chase@1 mice@2
    // doc 1: "Dogs are chasing the cat"  -> dog@0 chase@2 cat@4   ("are", "the" dropped)
    // doc 2: "Mice fear cats and cats"   -> mice@0 fear@1 cat@2 cat@4
    const index = new Map();
    ["Cats chase mice", "Dogs are chasing the cat", "Mice fear cats and cats"].forEach((text, docId) =>
      addDocument(index, docId, analyze(text)),
    );

    assert.deepEqual(index.get("cat"), [
      { docId: 0, tf: 1, positions: [0] },
      { docId: 1, tf: 1, positions: [4] },
      { docId: 2, tf: 2, positions: [2, 4] },
    ]);
    assert.deepEqual(index.get("chase"), [
      { docId: 0, tf: 1, positions: [1] },
      { docId: 1, tf: 1, positions: [2] },
    ]);
    assert.deepEqual(index.get("dog"), [{ docId: 1, tf: 1, positions: [0] }]);
    assert.equal(index.has("the"), false); // stopword: never indexed
    assert.equal(index.size, 5); // cat, chase, mice, dog, fear
  });

  test("postings come out sorted by docId without any sort step", () => {
    const index = new Map();
    for (let docId = 0; docId < 50; docId++) addDocument(index, docId, analyze("common word"));
    const ids = index.get("common").map((p) => p.docId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  test("rejects a docId that does not increase: sorted postings are an invariant", () => {
    const index = new Map();
    addDocument(index, 5, analyze("cat"));
    assert.throws(() => addDocument(index, 5, analyze("cat")), /docIds must increase/);
    assert.throws(() => addDocument(index, 2, analyze("cat")), /docIds must increase/);
  });
});

describe("documentTokens", () => {
  test("title first, then body, with a position gap between them", () => {
    const tokens = documentTokens("Cat Facts", "Cats purr");
    // title: cat@0 fact@1; body starts at 1 + 1 + GAP
    const bodyStart = 2 + TITLE_BODY_GAP;
    assert.deepEqual(
      tokens.map((t) => `${t.term}@${t.position}`),
      ["cat@0", "fact@1", `cat@${bodyStart}`, `purr@${bodyStart + 1}`],
    );
  });

  test("no title: body positions start at 0", () => {
    assert.deepEqual(documentTokens("", "cats purr"), analyzeWords("cats purr"));
  });
});

describe("chunkPostings", () => {
  const posting = (docId, n) => ({ docId, tf: n, positions: Array.from({ length: n }, (_, i) => i) });

  test("everything fits: one chunk", () => {
    const postings = [posting(0, 3), posting(1, 2)];
    assert.deepEqual(chunkPostings(postings), [postings]);
  });

  test("splits when the size budget is exceeded, keeping order", () => {
    const postings = Array.from({ length: 10 }, (_, i) => posting(i, 5)); // ~108 bytes each
    const chunks = chunkPostings(postings, 250);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flat(), postings); // concatenating gives back the full list
    for (const chunk of chunks) assert.ok(chunk.length >= 1);
  });

  test("a single posting bigger than the budget still gets its own chunk (never dropped)", () => {
    const big = posting(0, 1000);
    assert.deepEqual(chunkPostings([big, posting(1, 1)], 100), [[big], [posting(1, 1)]]);
  });

  test("an empty list gives no chunks", () => {
    assert.deepEqual(chunkPostings([]), []);
  });
});

describe("display spellings", () => {
  test("each term remembers its most common original word", () => {
    const spellings = new Map();
    countSpellings(spellings, documentTokens("France", "France and the French. Running, run, runs, running."));
    const display = mostCommonSpellings(spellings);
    assert.equal(display.get("franc"), "france");
    assert.equal(display.get("run"), "running", "2x running beats 1x run and 1x runs");
  });

  test("ties go to the alphabetically first word (repeatable builds)", () => {
    const spellings = new Map();
    countSpellings(spellings, analyzeWords("runs run"));
    assert.equal(mostCommonSpellings(spellings).get("run"), "run");
  });
});

describe("newestVersionPerUrl", () => {
  const urlOf = (c) => c.url;
  test("keeps the most recently parsed content of each URL", () => {
    const kept = newestVersionPerUrl([
      { _id: "h1", url: "u/sword", parsedAt: new Date("2026-11-09") },
      { _id: "h2", url: "u/sword", parsedAt: new Date("2026-11-13") },
      { _id: "h3", url: "u/sword", parsedAt: new Date("2026-11-11") },
      { _id: "h4", url: "u/axe", parsedAt: new Date("2026-11-01") },
    ], urlOf);
    assert.deepEqual([...kept].sort(), ["h2", "h4"]);
  });

  test("a tie on parsedAt is broken the same way every time", () => {
    const at = new Date("2026-11-13");
    const a = newestVersionPerUrl([{ _id: "aa", url: "u", parsedAt: at }, { _id: "bb", url: "u", parsedAt: at }], urlOf);
    const b = newestVersionPerUrl([{ _id: "bb", url: "u", parsedAt: at }, { _id: "aa", url: "u", parsedAt: at }], urlOf);
    assert.deepEqual([...a], ["bb"]);
    assert.deepEqual([...b], ["bb"], "input order does not matter");
  });

  test("contents without a URL are left out (the indexer counts them as noUrl)", () => {
    assert.equal(newestVersionPerUrl([{ _id: "x", url: null, parsedAt: new Date() }], urlOf).size, 0);
  });
});

describe("pageUrl", () => {
  const fetched = "https://w.test/wiki/MLK";
  test("a same-host canonical URL wins over the fetched URL", () => {
    assert.equal(pageUrl({ canonicalUrl: "https://w.test/wiki/Martin_Luther_King_Jr." }, fetched), "https://w.test/wiki/Martin_Luther_King_Jr.");
  });
  test("a canonical URL on ANOTHER host is ignored (it could hijack the page's identity)", () => {
    assert.equal(pageUrl({ canonicalUrl: "https://evil.test/x" }, fetched), fetched);
  });
  test("no canonical: the fetched URL; no fetched URL: the canonical one, else null", () => {
    assert.equal(pageUrl({ canonicalUrl: null }, fetched), fetched);
    assert.equal(pageUrl({ canonicalUrl: "https://w.test/a" }, undefined), "https://w.test/a");
    assert.equal(pageUrl({ canonicalUrl: null }, undefined), null);
  });
  test("an unparsable canonical value is ignored", () => {
    assert.equal(pageUrl({ canonicalUrl: "not a url" }, fetched), fetched);
  });
});

// ============================================ buildIndex against a real DB

describe("buildIndex", () => {
  let db;
  let dataDir;
  let blobStore;
  let jobId;

  before(async () => {
    db = await startTestDb();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "index-test-"));
    blobStore = new LocalBlobStore(dataDir);
  });
  after(async () => {
    await db.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.clear();
    jobId = new mongoose.Types.ObjectId();
  });

  /** Store a page the way the crawler does: text file + CrawlUrl + Content. */
  async function seedPage({ url, title, text, finalUrl = null, outlinks = [], job = jobId, parsedAt = new Date(), canonicalUrl = null }) {
    const { hash, ref: textRef } = await blobStore.putText(text);
    const crawlUrl = await CrawlUrl.create({
      jobId: job, normalizedUrl: url, originalUrl: url, host: new URL(url).host, depth: 0, seedUrl: url,
      state: "parsed", contentHash: hash, textRef, title, fetch: { finalUrl },
    });
    await Content.create({ _id: hash, rawRef: `raw/${hash}.html`, textRef, title, canonicalUrl, outlinks, firstUrlId: crawlUrl._id, parsedAt });
    return { hash, crawlUrl };
  }

  test("an alias page (same canonical URL) merges into the article; links to the alias still count", async () => {
    const article = "https://w.test/wiki/Weaving";
    await seedPage({ url: article, title: "Weaving", text: "weaving makes cloth", canonicalUrl: article, parsedAt: new Date("2026-11-09") });
    // /wiki/Weave serves the same article plus "(Redirected from Weave)", so
    // its bytes differ; it is newer, but its canonical URL is the article's.
    await seedPage({ url: "https://w.test/wiki/Weave", title: "Weaving", text: "weaving makes cloth (redirected from weave)", canonicalUrl: article, parsedAt: new Date("2026-11-13") });
    // Two pages link to the ALIAS URL only.
    await seedPage({ url: "https://w.test/wiki/Loom", title: "Loom", text: "a loom", outlinks: ["https://w.test/wiki/Weave"] });
    await seedPage({ url: "https://w.test/wiki/Wool", title: "Wool", text: "wool yarn", outlinks: ["https://w.test/wiki/Weave"] });

    const summary = await buildIndex({ blobStore });
    assert.equal(summary.N, 3, "Weaving once, Loom, Wool");
    assert.equal(summary.skipped.olderVersion, 1);
    const weaving = await IndexedDocument.findOne({ title: "Weaving" }).lean();
    assert.equal(weaving.url, article, "the result shows the canonical URL");
    assert.equal(weaving.inlinks, 2, "links to the alias count for the article");
  });

  test("the same URL crawled by two jobs is indexed ONCE, newest version", async () => {
    // Monday's and Friday's copy of one Wikipedia page: slightly different
    // bytes, so different hashes, so content dedup can't merge them.
    await seedPage({ url: "https://w.test/wiki/Sword", title: "Sword", text: "a sword is a blade (monday)", parsedAt: new Date("2026-11-09") });
    await seedPage({ url: "https://w.test/wiki/Sword", title: "Sword", text: "a sword is a blade (friday)", parsedAt: new Date("2026-11-13"), job: new mongoose.Types.ObjectId() });
    await seedPage({ url: "https://w.test/wiki/Axe", title: "Axe", text: "an axe chops wood" });

    const summary = await buildIndex({ blobStore });
    assert.equal(summary.N, 2, "Sword once, Axe once");
    assert.equal(summary.skipped.olderVersion, 1);
    assert.ok(await termDoc(analyze("friday")[0].term), "the newest copy is the one indexed");
    assert.equal(await termDoc(analyze("monday")[0].term), null);
    assert.equal((await termDoc("blade")).df, 1, "BM25 sees one Sword page, not two");
  });

  const termDoc = (term) => Term.findOne({ term, chunk: 0 }).lean();

  test("stores the most common spelling of each term (for spell correction)", async () => {
    await seedPage({ url: "https://a.test/fr", title: "France", text: "France is in Europe. France France." });
    await buildIndex({ blobStore });
    assert.equal((await termDoc("franc")).display, "france");
  });

  test("excludeUrlPatterns leaves matching URLs out of the index", async () => {
    await seedPage({ url: "https://w.test/wiki/Dog", title: "Dog", text: "dogs bark" });
    await seedPage({ url: "https://w.test/wiki/Wikipedia:List", title: "List", text: "dog cat cow" });
    const summary = await buildIndex({ blobStore, excludeUrlPatterns: ["/wiki/Wikipedia:"] });
    assert.equal(summary.N, 1);
    assert.equal(summary.skipped.excludedUrl, 1);
    assert.equal(await termDoc("cow"), null);
  });

  test("excludeHosts leaves those pages out of the index", async () => {
    await seedPage({ url: "https://keep.test/a", title: "Kept", text: "alpha" });
    await seedPage({ url: "https://drop.test/b", title: "Dropped", text: "beta" });
    const summary = await buildIndex({ blobStore, excludeHosts: ["drop.test"] });
    assert.equal(summary.N, 1);
    assert.equal(summary.skipped.excludedHost, 1);
    assert.equal(await termDoc("beta"), null);
  });

  test("the quality filter leaves out non-English and spam pages; qualityFilter:false keeps them", async () => {
    const english = "The history of the bridge is long and the town is proud of it. ".repeat(10);
    const indonesian = "Saya tidak tahu apa yang akan terjadi dengan kita dan dunia ini. ".repeat(10);
    await seedPage({ url: "https://m.test/en", title: "A bridge", text: english });
    await seedPage({ url: "https://m.test/id", title: "Dunia", text: indonesian });
    await seedPage({ url: "https://m.test/spam", title: "How to Earn $50-$200 a Day Online", text: `${english} Start today.` });

    const filtered = await buildIndex({ blobStore });
    assert.equal(filtered.N, 1);
    assert.equal(filtered.skipped.notEnglish, 1);
    assert.equal(filtered.skipped.spam, 1);
    assert.equal(await termDoc("dunia"), null, "nothing from the skipped page is in the index");
    assert.equal((await CorpusStats.findById("corpus").lean()).skipped.spam, 1, "stats record it too");

    const all = await buildIndex({ blobStore, qualityFilter: false });
    assert.equal(all.N, 3, "skipping, not deleting: the pages come back");
  });

  test("stores PageRank, inlinks and textRef on each document", async () => {
    // A and C both link to B; B links to A. A redirect URL of B counts as B.
    await seedPage({ url: "https://a.test/A", title: "A", text: "alpha page", outlinks: ["https://a.test/B-old"] });
    await seedPage({ url: "https://a.test/B", title: "B", text: "beta page", finalUrl: "https://a.test/B-old", outlinks: ["https://a.test/A"] });
    await seedPage({ url: "https://a.test/C", title: "C", text: "gamma page", outlinks: ["https://a.test/B", "https://elsewhere.test/x"] });

    const summary = await buildIndex({ blobStore });
    const docs = Object.fromEntries((await IndexedDocument.find().lean()).map((d) => [d.title, d]));
    assert.equal(summary.linkEdges, 3);
    assert.ok(docs.B.pagerank > docs.A.pagerank && docs.A.pagerank > docs.C.pagerank, "B has 2 inlinks, A 1, C 0");
    assert.deepEqual([docs.A.inlinks, docs.B.inlinks, docs.C.inlinks], [1, 2, 0]);
    const total = docs.A.pagerank + docs.B.pagerank + docs.C.pagerank;
    assert.ok(Math.abs(total - 1) < 1e-9, `PageRank sums to ${total}`);
    assert.match(docs.A.textRef, /^text\//);
  });

  test("builds terms, documents and corpus stats from crawled pages", async () => {
    await seedPage({ url: "https://a.test/cats", title: "Cats", text: "Cats purr. Cats sleep." });
    await seedPage({ url: "https://a.test/dogs", title: "Dogs", text: "Dogs bark at cats" });

    const summary = await buildIndex({ blobStore });

    assert.equal(summary.N, 2);
    const cat = await termDoc("cat");
    assert.equal(cat.df, 2);
    const tfByUrl = {};
    for (const p of cat.postings) tfByUrl[(await IndexedDocument.findById(p.docId)).url] = p.tf;
    assert.deepEqual(tfByUrl, { "https://a.test/cats": 3, "https://a.test/dogs": 1 }); // title counts too

    const stats = await CorpusStats.findById("corpus").lean();
    assert.equal(stats.N, 2);
    // "cats": cat cat purr cat sleep = 5 terms; "dogs": dog dog bark cat = 4 ("at" is a stopword)
    assert.equal(stats.avgLength, 4.5);
    assert.equal(stats.vocabularySize, summary.vocabularySize);
    assert.deepEqual(stats.skipped, { empty: 0, noUrl: 0, missingText: 0, excludedHost: 0, excludedUrl: 0, stale: 0, olderVersion: 0, notEnglish: 0, spam: 0 });
  });

  test("every postings list in the database is sorted by docId", async () => {
    for (let i = 0; i < 12; i++) await seedPage({ url: `https://a.test/p${i}`, title: `Page ${i}`, text: `shared words page${i}` });
    await buildIndex({ blobStore });
    const ids = (await termDoc("share")).postings.map((p) => p.docId);
    assert.equal(ids.length, 12);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  });

  test("a result shows the URL after redirects, when there was one", async () => {
    await seedPage({ url: "https://a.test/old", finalUrl: "https://a.test/new", title: "Moved", text: "moved here" });
    await buildIndex({ blobStore });
    assert.equal((await IndexedDocument.findById(0)).url, "https://a.test/new");
  });

  test("two URLs with the same content are ONE document (crawler dedup carries over)", async () => {
    const { hash, crawlUrl } = await seedPage({ url: "https://a.test/", title: "Home", text: "welcome home" });
    // A second URL that downloaded identical bytes points at the same Content.
    await CrawlUrl.create({
      jobId, normalizedUrl: "https://a.test/index.html", originalUrl: "https://a.test/index.html",
      host: "a.test", depth: 1, seedUrl: "https://a.test/", state: "duplicate", contentHash: hash,
    });
    const summary = await buildIndex({ blobStore });
    assert.equal(summary.N, 1);
    assert.equal((await IndexedDocument.findById(0)).url, crawlUrl.normalizedUrl); // the first URL
  });

  test("pages that can't be indexed are skipped and counted by reason", async () => {
    await seedPage({ url: "https://a.test/ok", title: "Fine", text: "real words" });
    await seedPage({ url: "https://a.test/empty", title: "", text: "the and of" }); // stopwords only
    const { hash } = await seedPage({ url: "https://a.test/gone", title: "Gone", text: "file deleted" });
    await rm(path.join(dataDir, "text", hash.slice(0, 2), `${hash}.txt`));
    const orphan = await seedPage({ url: "https://a.test/orphan", title: "Orphan", text: "no url record" });
    await CrawlUrl.deleteOne({ _id: orphan.crawlUrl._id });

    const summary = await buildIndex({ blobStore });
    assert.equal(summary.N, 1);
    // The orphan's content is held by no URL any more: "stale", like the old
    // version of a re-crawled page that changed.
    assert.deepEqual(summary.skipped, { empty: 1, noUrl: 0, missingText: 1, excludedHost: 0, excludedUrl: 0, stale: 1, olderVersion: 0, notEnglish: 0, spam: 0 });
  });

  test("a long postings list is split into chunks that read back as the full list", async () => {
    for (let i = 0; i < 20; i++) await seedPage({ url: `https://a.test/${i}`, title: "", text: `common common unique${i}` });
    await buildIndex({ blobStore, maxChunkBytes: 300 }); // tiny budget forces chunking

    const chunks = await Term.find({ term: "common" }).sort({ chunk: 1 }).lean();
    assert.ok(chunks.length > 1, `expected several chunks, got ${chunks.length}`);
    for (const c of chunks) assert.equal(c.df, 20); // df is for the whole term, on every chunk
    const ids = chunks.flatMap((c) => c.postings.map((p) => p.docId));
    assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => i));
  });

  test("rebuilding replaces the old index completely and leaves no staging collections", async () => {
    await seedPage({ url: "https://a.test/one", title: "", text: "alpha beta" });
    const two = await seedPage({ url: "https://a.test/two", title: "", text: "gamma" });
    await buildIndex({ blobStore });
    assert.ok(await termDoc("gamma"));

    await Content.deleteOne({ _id: two.hash });
    const summary = await buildIndex({ blobStore });

    assert.equal(summary.N, 1);
    assert.equal(await termDoc("gamma"), null); // gone, not left over from the first build
    assert.equal(await IndexedDocument.countDocuments(), 1);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    for (const staging of Object.values(STAGING)) assert.ok(!names.includes(staging), `${staging} left behind`);
  });

  test("leftovers from a crashed build are dropped, not mixed into the new index", async () => {
    await mongoose.connection.db.collection(STAGING.terms).insertOne({ term: "stale", chunk: 0, df: 1, postings: [] });
    await seedPage({ url: "https://a.test/x", title: "", text: "fresh" });
    await buildIndex({ blobStore });
    assert.equal(await termDoc("stale"), null);
    assert.ok(await termDoc("fresh"));
  });

  test("an empty corpus builds an empty index (N = 0) instead of failing", async () => {
    const summary = await buildIndex({ blobStore });
    assert.equal(summary.N, 0);
    assert.equal((await CorpusStats.findById("corpus")).avgLength, 0);
    assert.equal(await Term.countDocuments(), 0);
  });

  test("the live terms collection keeps its unique (term, chunk) index after the swap", async () => {
    await seedPage({ url: "https://a.test/x", title: "", text: "word" });
    await buildIndex({ blobStore });
    const indexes = await Term.collection.indexes();
    assert.ok(indexes.some((i) => i.unique && i.key.term === 1 && i.key.chunk === 1));
  });
});
