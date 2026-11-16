import mongoose from "mongoose";

// One document per results page the user SAW (a search, or a later page of
// it), plus the clicks made on that page. Analytics (top queries, zero-result
// queries, CTR, CTR by position, latency) is computed from these.
//
// Privacy by design: no IP address, no user id, no cookie. Only the query
// text and what happened to it. Logs expire after 30 days (TTL index below),
// which also caps their size on the 512 MB free database tier.

// Days a log is kept. MongoDB's TTL monitor deletes older documents by itself
// (it runs about once a minute).
export const LOG_RETENTION_DAYS = 30;
// One page view can't grow without limit: keep its last 50 clicks.
export const MAX_CLICKS_PER_SEARCH = 50;

const clickSchema = new mongoose.Schema(
  {
    position: { type: Number, required: true }, // 1 = first result of page 1, 11 = first of page 2
    url: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const searchLogSchema = new mongoose.Schema(
  {
    // The browser's id for this page view (an idempotency key): a request
    // sent twice is still ONE log. See server/routes/search.js.
    _id: { type: String },
    query: { type: String, required: true }, // as typed
    key: { type: String, required: true }, // folded ("Gothic  Cathedral" -> "gothic cathedral"), to group equal queries
    page: { type: Number, required: true },
    limit: { type: Number, required: true }, // results per page, to turn a row into a position
    rank: { type: String, required: true },
    mode: { type: String, required: true },
    source: { type: String, required: true },
    total: { type: Number, required: true }, // results found
    shown: { type: Number, required: true }, // results on this page (impressions)
    tookMs: { type: Number, required: true },
    corrected: { type: String, default: null }, // the corrected query, if typo correction was used
    clicks: { type: [clickSchema], default: [] },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false },
);

searchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: LOG_RETENTION_DAYS * 24 * 60 * 60 });

export default mongoose.model("SearchLog", searchLogSchema, "searchlogs");
