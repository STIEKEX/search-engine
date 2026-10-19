import mongoose from "mongoose";
import { URL_STATES } from "../../crawler/urlStates.js";

// One document per (job, URL): the persistent frontier of Stage 2.
// Stage 1 kept the frontier in memory (lost on crash); here every discovered
// URL is a row, and the queues only carry this document's _id.
const crawlUrlSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "CrawlJob", required: true },
    normalizedUrl: { type: String, required: true },
    originalUrl: { type: String, required: true },
    host: { type: String, required: true },
    depth: { type: Number, required: true, min: 0 },
    seedUrl: { type: String, required: true },
    parentUrl: { type: String, default: null },

    // See crawler/urlStates.js for the state machine and allowed transitions.
    state: { type: String, enum: URL_STATES, default: "queued" },
    skipReason: { type: String, default: null },

    // Fetch and parse keep SEPARATE retry counters: a parse bug should not
    // use up the fetch retries, and vice versa.
    fetch: {
      attempts: { type: Number, default: 0 },
      lastError: { type: String, default: null },
      budgeted: { type: Boolean, default: false }, // counted against maxPages already?
      httpStatus: { type: Number, default: null },
      finalUrl: { type: String, default: null },
      contentType: { type: String, default: null },
      charset: { type: String, default: null },
      sizeBytes: { type: Number, default: null },
      fetchedAt: { type: Date, default: null },
    },
    parse: {
      attempts: { type: Number, default: 0 },
      lastError: { type: String, default: null },
      parsedAt: { type: Date, default: null },
    },

    contentHash: { type: String, default: null }, // SHA-256 of raw HTML; key of Content
    rawRef: { type: String, default: null },
    textRef: { type: String, default: null },
    title: { type: String, default: null },
    canonicalUrl: { type: String, default: null },
    outlinks: { type: [String], default: [] },
    discoveredAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// The unique index is what makes concurrent discovery safe: if two parse
// workers find the same link at the same moment, MongoDB lets exactly one
// insert win. No application lock is needed.
crawlUrlSchema.index({ jobId: 1, normalizedUrl: 1 }, { unique: true });
crawlUrlSchema.index({ jobId: 1, state: 1 });
crawlUrlSchema.index({ contentHash: 1 });

export default mongoose.model("CrawlUrl", crawlUrlSchema, "urls");
