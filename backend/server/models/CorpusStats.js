import mongoose from "mongoose";

// Corpus-wide numbers, one document with _id "corpus".
// BM25 (M5) needs N and avgLength for every query; computing them per query
// would mean reading every document, so the indexer stores them once.
const corpusStatsSchema = new mongoose.Schema(
  {
    _id: { type: String }, // always "corpus"
    N: { type: Number, required: true }, // number of indexed documents
    avgLength: { type: Number, required: true }, // average IndexedDocument.length
    vocabularySize: { type: Number, required: true }, // distinct terms
    totalPostings: { type: Number, required: true },
    // Pages the indexer could not use, by reason. A big missingText usually
    // means the data/ folder is not on this machine (it is not in git).
    skipped: {
      empty: { type: Number, default: 0 }, // no indexable words (e.g. images only)
      noUrl: { type: Number, default: 0 }, // content whose URL record is gone
      missingText: { type: Number, default: 0 }, // text file not found on disk
      excludedHost: { type: Number, default: 0 }, // left out on purpose (--exclude-host)
      excludedUrl: { type: Number, default: 0 }, // left out on purpose (--exclude-url)
      stale: { type: Number, default: 0 }, // old versions of re-crawled pages that changed
      olderVersion: { type: Number, default: 0 }, // same URL crawled again by another job: newest kept
      notEnglish: { type: Number, default: 0 }, // quality filter: not in English (indexer/quality.js)
      spam: { type: Number, default: 0 }, // quality filter: spam title (indexer/quality.js)
    },
    builtAt: { type: Date, required: true },
    buildMs: { type: Number, required: true },
  },
  { versionKey: false },
);

export const CORPUS_STATS_ID = "corpus";

export default mongoose.model("CorpusStats", corpusStatsSchema, "stats");
