// Phase 3 indexer: turn every crawled page into the inverted index.
//
// This is OFFLINE work (run by hand, like the crawler), so that searching
// later is ONLINE and fast: a query looks up a few terms instead of reading
// every page. The full flow:
//
//   Content docs (one per distinct page, from the crawler)
//     -> read text file, tokenize title + body      (shared/tokenize.js)
//     -> assign docId 0, 1, 2...                    (IndexedDocument)
//     -> add to an in-memory Map term -> postings   (addDocument)
//     -> write to staging collections, then swap them in, then write stats
//
// It is a FULL rebuild every time: simple to reason about, and a few thousand
// pages take seconds. (Big engines update incrementally; see the walkthrough.)
//
// Run:  npm run index:build

import dns from "node:dns";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { readConfig } from "../crawler/config.js";
import { LocalBlobStore } from "../crawler/storage/LocalBlobStore.js";
import connectDb from "../server/config/db.js";
import Content from "../server/models/Content.js";
import CorpusStats, { CORPUS_STATS_ID } from "../server/models/CorpusStats.js";
import CrawlUrl from "../server/models/CrawlUrl.js";
import { analyzeWords } from "../shared/tokenize.js";
import { buildLinkGraph, pageRank } from "./pagerank.js";
import { qualityVerdict } from "./quality.js";

// Body positions start this far after the last title word, so a future
// phrase search can't match a "phrase" made of the title's last word and the
// body's first word.
export const TITLE_BODY_GAP = 10;

// Stay far below MongoDB's 16 MB document limit (our size estimate is rough).
export const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;

// The new index is built under these names and only renamed into place once
// it is complete. If the build crashes halfway, the old index keeps working.
export const STAGING = { terms: "terms_build", documents: "documents_build" };

const WRITE_BATCH = 1000; // documents per insertMany call

/**
 * Title and body as ONE stream of tokens. The title comes first, because the
 * page's title is part of what the page is about. Each token keeps the word
 * it came from ("running" for the term "run"), for display spellings.
 * @returns {Array<{ term: string, position: number, word: string }>}
 */
export function documentTokens(title, body) {
  const titleTokens = analyzeWords(title);
  const lastTitlePosition = titleTokens.at(-1)?.position ?? -1;
  const offset = titleTokens.length > 0 ? lastTitlePosition + 1 + TITLE_BODY_GAP : 0;
  const bodyTokens = analyzeWords(body).map((t) => ({ ...t, position: t.position + offset }));
  return [...titleTokens, ...bodyTokens];
}

/** Count how often each word spelling produced each term: term -> Map(word -> count). */
export function countSpellings(spellings, tokens) {
  for (const { term, word } of tokens) {
    let counts = spellings.get(term);
    if (!counts) spellings.set(term, (counts = new Map()));
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
}

/**
 * Most common spelling per term: "franc" -> "france". Spell correction shows
 * and compares these, because a stem such as "franc" is not a real word.
 * Ties go to the alphabetically first word, so builds are repeatable.
 */
export function mostCommonSpellings(spellings) {
  const display = new Map();
  for (const [term, counts] of spellings) {
    let best = null;
    for (const [word, n] of counts) {
      if (!best || n > best.n || (n === best.n && word < best.word)) best = { word, n };
    }
    display.set(term, best.word);
  }
  return display;
}

/**
 * Add one document to the in-memory index (Map term -> postings array).
 *
 * Documents MUST arrive in increasing docId order. Then every postings list
 * is sorted by docId for free, just by appending, with no sort step at the end.
 *
 *   tokens: cat@1 sat@2 cat@9   ->   index "cat": [..., { docId, tf: 2, positions: [1, 9] }]
 *                                     index "sat": [..., { docId, tf: 1, positions: [2] }]
 */
export function addDocument(index, docId, tokens) {
  // Step 1: group this document's positions by term.
  const positionsByTerm = new Map();
  for (const { term, position } of tokens) {
    const positions = positionsByTerm.get(term);
    if (positions) positions.push(position);
    else positionsByTerm.set(term, [position]);
  }

  // Step 2: one posting per distinct term, appended to that term's list.
  for (const [term, positions] of positionsByTerm) {
    const postings = index.get(term);
    const posting = { docId, tf: positions.length, positions };
    if (!postings) {
      index.set(term, [posting]);
      continue;
    }
    // Guard the sorted-postings invariant: M4's intersection depends on it.
    if (postings.at(-1).docId >= docId) {
      throw new Error(`addDocument: docId ${docId} arrived after ${postings.at(-1).docId}; docIds must increase`);
    }
    postings.push(posting);
  }
}

/**
 * Split one term's postings into chunks small enough for a MongoDB document.
 * Order is kept, so concatenating the chunks gives back the full sorted list.
 * @returns {Array<Array<object>>}  at least one chunk for a non-empty list
 */
export function chunkPostings(postings, maxBytes = DEFAULT_MAX_CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const posting of postings) {
    const bytes = estimatePostingBytes(posting);
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(posting);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Rough BSON size of one posting: field names and numbers (~48 bytes), plus
// ~12 bytes per array element (type byte + index key + 4-byte int).
function estimatePostingBytes(posting) {
  return 48 + 12 * posting.positions.length;
}

/** Term documents ready to insert, in alphabetical term order. */
function* termDocuments(index, maxChunkBytes, displayByTerm) {
  for (const term of [...index.keys()].sort()) {
    const postings = index.get(term);
    const chunks = chunkPostings(postings, maxChunkBytes);
    for (let chunk = 0; chunk < chunks.length; chunk++) {
      // The spelling is stored once, on chunk 0 (where df is read from too).
      const display = chunk === 0 ? { display: displayByTerm.get(term) ?? term } : {};
      yield { term, chunk, df: postings.length, ...display, postings: chunks[chunk] };
    }
  }
}

/**
 * One document per URL: the most recently parsed version wins.
 *
 * Why this is needed: URL records belong to a crawl JOB, so two jobs that
 * both visit /wiki/Sword on different days each keep their own copy. A
 * Wikipedia page changes a little between visits (a new edit, a different
 * "retrieved on" date), so the bytes differ, the content hashes differ, and
 * content dedup cannot merge them. Without this step both copies are
 * indexed: the user sees "Sword" twice, and BM25 counts every word of it twice.
 *
 * @param {Array<{ _id: string, parsedAt: Date }>} contents  live contents
 * @param {(content: object) => string|null} resultUrl  the URL a result shows
 * @returns {Set<string>} ids of the contents to index
 */
export function newestVersionPerUrl(contents, resultUrl) {
  const best = new Map(); // url -> content
  for (const content of contents) {
    const url = resultUrl(content);
    if (!url) continue;
    const current = best.get(url);
    // Ties (same parsedAt) go to the larger hash: arbitrary, but stable.
    if (!current || content.parsedAt > current.parsedAt || (+content.parsedAt === +current.parsedAt && content._id > current._id)) {
      best.set(url, content);
    }
  }
  return new Set([...best.values()].map((c) => c._id));
}

/**
 * Rebuild the whole index from the Content collection.
 * Needs an open mongoose connection.
 *
 * @param {object} deps
 * @param {import("../crawler/storage/BlobStore.js").BlobStore} deps.blobStore  where the text files are
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.maxChunkBytes]  tests make this tiny to force chunking
 * @param {string[]} [deps.excludeHosts] pages from these hosts are left out of
 *   the index (e.g. an old test crawl), without deleting the crawled data
 * @param {string[]} [deps.excludeUrlPatterns] regexes: matching URLs are left
 *   out too (e.g. Wikipedia's own "Wikipedia:..." pages, which are lists and
 *   help pages, not articles: a list naming 1,000 topics would match everything)
 * @param {boolean} [deps.qualityFilter] leave out non-English and spam pages
 *   (see quality.js). On by default; false indexes everything.
 */
export async function buildIndex({ blobStore, log = () => {}, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES, excludeHosts = [], excludeUrlPatterns = [], qualityFilter = true }) {
  const startedAt = Date.now();

  // Sorted by hash so docIds are stable between rebuilds of the same corpus.
  const contents = await Content.find({}, { textRef: 1, title: 1, firstUrlId: 1, canonicalUrl: 1, outlinks: 1, parsedAt: 1 }).sort({ _id: 1 }).lean();
  const urlOf = await loadResultUrls(contents);
  const resultUrl = (content) => pageUrl(content, urlOf.get(String(content.firstUrlId)));
  // Content that no URL holds any more: after a re-crawl, a changed page has
  // a new hash and its old version must not stay in the index next to it.
  const live = new Set(await CrawlUrl.distinct("contentHash", { contentHash: { $ne: null } }));
  const liveContents = contents.filter((c) => live.has(c._id));
  const newest = newestVersionPerUrl(liveContents, resultUrl);
  // Every live version's page URL, also of the copies we skip: a link to a
  // skipped copy (an alias like /wiki/Weave) must still count for the
  // document that IS indexed (/wiki/Weaving) when PageRank is computed.
  const pageUrlByHash = new Map(liveContents.map((c) => [c._id, resultUrl(c)]));
  log(`Indexing ${contents.length} distinct pages...`);

  const index = new Map();
  const documents = [];
  const skipped = { empty: 0, noUrl: 0, missingText: 0, excludedHost: 0, excludedUrl: 0, stale: 0, olderVersion: 0, notEnglish: 0, spam: 0 };
  const outlinksByDocId = []; // used for PageRank, not stored in documents
  const spellings = new Map(); // term -> Map(word -> count), for display spellings
  const excluded = new Set(excludeHosts.map((h) => h.toLowerCase()));
  const excludedUrls = excludeUrlPatterns.map((p) => new RegExp(p));
  let totalLength = 0;

  for (const content of contents) {
    if (!live.has(content._id)) {
      skipped.stale++;
      continue;
    }
    const url = resultUrl(content);
    if (!url) {
      skipped.noUrl++;
      continue;
    }
    if (!newest.has(content._id)) {
      skipped.olderVersion++; // a newer crawl of the same URL is indexed instead
      continue;
    }
    if (excluded.has(new URL(url).host)) {
      skipped.excludedHost++;
      continue;
    }
    if (excludedUrls.some((re) => re.test(url))) {
      skipped.excludedUrl++;
      continue;
    }
    const text = await readText(blobStore, content.textRef);
    if (text === null) {
      skipped.missingText++;
      continue;
    }
    // Before tokenizing: no point analyzing a page we are not going to keep.
    const verdict = qualityFilter ? qualityVerdict(content.title, text) : null;
    if (verdict) {
      skipped[verdict]++;
      continue;
    }
    const tokens = documentTokens(content.title, text);
    if (tokens.length === 0) {
      skipped.empty++;
      continue;
    }

    const docId = documents.length; // 0, 1, 2... in loop order = increasing
    addDocument(index, docId, tokens);
    countSpellings(spellings, tokens);
    documents.push({ _id: docId, contentHash: content._id, url, title: content.title, length: tokens.length, textRef: content.textRef });
    outlinksByDocId.push(content.outlinks ?? []);
    totalLength += tokens.length;
    if (documents.length % 500 === 0) log(`  ${documents.length} pages indexed`);
  }

  const pagerank = await addPageRank(documents, outlinksByDocId, pageUrlByHash);
  log(`PageRank: ${pagerank.iterations} iterations${pagerank.converged ? "" : " (did NOT converge)"}`);
  const { termDocs, totalPostings } = await writeAndSwap(index, documents, maxChunkBytes, mostCommonSpellings(spellings));

  const summary = {
    N: documents.length,
    avgLength: documents.length > 0 ? totalLength / documents.length : 0,
    vocabularySize: index.size,
    totalPostings,
    termDocs,
    skipped,
    pagerankIterations: pagerank.iterations,
    linkEdges: pagerank.edges,
    buildMs: Date.now() - startedAt,
  };
  // Written last: stats describe the index that is now live.
  await CorpusStats.replaceOne(
    { _id: CORPUS_STATS_ID },
    { N: summary.N, avgLength: summary.avgLength, vocabularySize: summary.vocabularySize, totalPostings, skipped, builtAt: new Date(), buildMs: summary.buildMs },
    { upsert: true },
  );
  return summary;
}

/**
 * Compute PageRank over the indexed pages and store it on each document
 * (in memory, before the documents are written).
 */
async function addPageRank(documents, outlinksByDocId, pageUrlByHash) {
  const docIdByUrl = await loadDocIdByUrl(documents, pageUrlByHash);
  const pages = documents.map((d) => ({ docId: d._id, outlinks: outlinksByDocId[d._id] }));
  const links = buildLinkGraph(documents.length, pages, docIdByUrl);
  const { scores, iterations, converged } = pageRank(documents.length, links);

  const inlinks = new Array(documents.length).fill(0);
  for (const out of links) for (const target of out) inlinks[target]++;
  documents.forEach((d) => {
    d.pagerank = scores[d._id];
    d.inlinks = inlinks[d._id];
  });
  return { iterations, converged, edges: links.reduce((n, out) => n + out.length, 0) };
}

/**
 * Every URL that leads to an indexed page -> its docId. A link can point to
 * any of them: the page's own URL, a URL that redirected to it, another URL
 * with byte-identical content (content dedup), or a URL whose copy was
 * skipped for a newer or canonical version of the same page.
 * @param {Map<string, string>} pageUrlByHash content hash -> page URL, for
 *   every live content (indexed or skipped as olderVersion)
 */
async function loadDocIdByUrl(documents, pageUrlByHash) {
  const docIdByPageUrl = new Map(documents.map((d) => [d.url, d._id]));
  const docIdByUrl = new Map(docIdByPageUrl);
  const urls = await CrawlUrl.find({ contentHash: { $in: [...pageUrlByHash.keys()] } }, { normalizedUrl: 1, "fetch.finalUrl": 1, contentHash: 1 }).lean();
  for (const u of urls) {
    const docId = docIdByPageUrl.get(pageUrlByHash.get(u.contentHash));
    if (docId === undefined) continue; // that page is not indexed (spam, excluded...)
    docIdByUrl.set(u.normalizedUrl, docId);
    if (u.fetch?.finalUrl) docIdByUrl.set(u.fetch.finalUrl, docId);
  }
  return docIdByUrl;
}

/**
 * The URL that identifies a page: its canonical URL when the page declares
 * one on the SAME host, else the URL we fetched (after redirects).
 *
 * Wikipedia serves aliases such as /wiki/MLK as normal pages ("Redirected
 * from MLK") with <link rel="canonical" href=".../Martin_Luther_King_Jr.">.
 * Without this, the alias and the article are two documents.
 * Same host only: a canonical tag pointing to another site could be used to
 * hijack a page's identity, and a misconfigured site would merge with others.
 *
 * @param {{ canonicalUrl?: string|null }} content
 * @param {string|undefined} fetchedUrl
 * @returns {string|null}
 */
export function pageUrl(content, fetchedUrl) {
  const canonical = content.canonicalUrl;
  if (!fetchedUrl) return canonical ?? null;
  if (!canonical) return fetchedUrl;
  try {
    return new URL(canonical).host === new URL(fetchedUrl).host ? canonical : fetchedUrl;
  } catch {
    return fetchedUrl; // an unparsable canonical tag: ignore it
  }
}

/** Map firstUrlId -> URL to show in results (after redirects, if any). */
async function loadResultUrls(contents) {
  const ids = contents.map((c) => c.firstUrlId);
  const urls = await CrawlUrl.find({ _id: { $in: ids } }, { normalizedUrl: 1, "fetch.finalUrl": 1 }).lean();
  return new Map(urls.map((u) => [String(u._id), u.fetch?.finalUrl ?? u.normalizedUrl]));
}

/** The page's text, or null if its file is gone. Other errors are real bugs: rethrow. */
async function readText(blobStore, textRef) {
  try {
    return (await blobStore.get(textRef)).toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write the new index under staging names, then rename it over the live one. */
async function writeAndSwap(index, documents, maxChunkBytes, displayByTerm) {
  const db = mongoose.connection.db;
  // Leftovers from a build that crashed earlier would mix into this one.
  for (const name of Object.values(STAGING)) await dropIfExists(db, name);
  const termsBuild = await db.createCollection(STAGING.terms);
  const documentsBuild = await db.createCollection(STAGING.documents);

  await insertInBatches(documentsBuild, documents);
  const termDocs = await insertInBatches(termsBuild, termDocuments(index, maxChunkBytes, displayByTerm));
  let totalPostings = 0;
  for (const postings of index.values()) totalPostings += postings.length;
  // Building the index after the bulk insert is faster than updating it
  // on every insert. It must exist before the swap: lookups depend on it.
  await termsBuild.createIndex({ term: 1, chunk: 1 }, { unique: true });

  // rename + dropTarget replaces the live collection in one step. Between
  // the two renames, a reader could briefly see new terms with old documents
  // (a few milliseconds; acceptable here, see the walkthrough).
  await documentsBuild.rename("documents", { dropTarget: true });
  await termsBuild.rename("terms", { dropTarget: true });
  return { termDocs, totalPostings };
}

/** insertMany in batches from any iterable; returns how many were inserted. */
async function insertInBatches(collection, docs) {
  let batch = [];
  let inserted = 0;
  for (const doc of docs) {
    batch.push(doc);
    if (batch.length === WRITE_BATCH) {
      await collection.insertMany(batch, { ordered: false });
      inserted += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await collection.insertMany(batch, { ordered: false });
    inserted += batch.length;
  }
  return inserted;
}

async function dropIfExists(db, name) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (exists) await db.dropCollection(name);
}

function printSummary(s) {
  console.log("\n===== Index summary =====");
  console.log(`documents (N):       ${s.N}`);
  console.log(`avg length (terms):  ${s.avgLength.toFixed(1)}`);
  console.log(`vocabulary:          ${s.vocabularySize} distinct terms`);
  console.log(`postings:            ${s.totalPostings}`);
  console.log(`term documents:      ${s.termDocs} (more than vocabulary = some terms were chunked)`);
  console.log(`skipped:             ${JSON.stringify(s.skipped)}`);
  console.log(`link graph:          ${s.linkEdges} links between indexed pages; PageRank ${s.pagerankIterations} iterations`);
  console.log(`time taken:          ${(s.buildMs / 1000).toFixed(1)} s`);
}

async function main() {
  const { MONGODB_URI } = process.env;
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in .env");
  // Same reason as in server/server.js: some networks refuse the SRV DNS lookup.
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
  await connectDb(MONGODB_URI);
  // npm run index:build -- --exclude-host books.toscrape.com --exclude-url "/wiki/Wikipedia:"
  // (npm run index:wiki runs it with the settings for the Wikipedia corpus)
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "exclude-host": { type: "string", multiple: true }, "exclude-url": { type: "string", multiple: true }, "keep-all": { type: "boolean" } },
  });
  const excludeHosts = values["exclude-host"] ?? [];
  const excludeUrlPatterns = values["exclude-url"] ?? [];
  if (excludeHosts.length > 0) console.log(`Leaving out pages from: ${excludeHosts.join(", ")}`);
  if (excludeUrlPatterns.length > 0) console.log(`Leaving out URLs matching: ${excludeUrlPatterns.join(", ")}`);
  // --keep-all turns the language/spam filter off (to compare, or to debug it).
  const qualityFilter = !values["keep-all"];
  console.log(qualityFilter ? "Leaving out non-English and spam pages (--keep-all to index everything)" : "Quality filter OFF: indexing every page");
  try {
    const config = readConfig();
    const summary = await buildIndex({ blobStore: new LocalBlobStore(config.dataDir), log: console.log, excludeHosts, excludeUrlPatterns, qualityFilter });
    printSummary(summary);
  } finally {
    await mongoose.disconnect();
  }
}

// Run main() only when executed directly, not when a test imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Index build failed: ${err.message}`);
    process.exit(1);
  });
}
