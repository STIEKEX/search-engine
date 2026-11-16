// Keeps the small, read-mostly part of the index in server memory:
// corpus stats (N, avgLength) and, per document, url, title, length,
// PageRank and textRef. For 2,000 pages that is a few hundred KB.
//
// Why: every search needs these values for every candidate (BM25 needs the
// length, ranking needs PageRank, results need url + title). Loading them
// from Atlas cost 2-3 extra round trips of ~75 ms each per query. Now a
// query needs ONE round trip: the postings of its words.
//
// Staying fresh: at most once every `checkEveryMs` we read the stats
// document (tiny). If its builtAt changed, `npm run index:build` produced a
// new index, so we reload the documents.

import CorpusStats, { CORPUS_STATS_ID } from "../models/CorpusStats.js";
import IndexedDocument from "../models/IndexedDocument.js";

export class IndexNotBuiltError extends Error {
  status = 404;
}

export function createIndexCache({ checkEveryMs = 10_000, now = Date.now } = {}) {
  let snapshot = null; // { builtAt, stats, docs: docs[docId] }
  let lastCheckAt = -Infinity;
  let refreshing = null; // shared, so 50 parallel searches trigger ONE reload

  async function refresh() {
    const stats = await CorpusStats.findById(CORPUS_STATS_ID).lean();
    lastCheckAt = now();
    if (!stats) {
      snapshot = null;
      return;
    }
    if (snapshot?.builtAt === stats.builtAt.getTime()) return; // same index as before
    const rows = await IndexedDocument.find({}, { url: 1, title: 1, length: 1, pagerank: 1, inlinks: 1, textRef: 1 }).lean();
    const docs = [];
    for (const row of rows) docs[row._id] = row; // docIds are 0..N-1: an array is the fastest map
    snapshot = { builtAt: stats.builtAt.getTime(), stats, docs };
  }

  /** The current index snapshot. Throws IndexNotBuiltError (404) if there is none. */
  async function get() {
    if (now() - lastCheckAt >= checkEveryMs) {
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
    }
    if (!snapshot) throw new IndexNotBuiltError("Index not built yet. Run: npm run index:build");
    return snapshot;
  }

  return { get };
}
