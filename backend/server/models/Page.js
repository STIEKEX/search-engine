import mongoose from "mongoose";

// One document per URL the crawler has dealt with.
// The page content itself lives in files (see crawler/storage.js); this
// document only holds metadata and references, which keeps it small and keeps
// MongoDB well under its 16 MB per-document limit.
//
// Status lifecycle in Stage 1:
//   queued -> fetched -> parsed        (happy path)
//   queued -> skipped                  (robots.txt, not HTML, off-host redirect)
//   queued | fetched -> failed         (network error, HTTP 4xx/5xx, too large, parse error)
export const PAGE_STATUSES = ["queued", "fetched", "parsed", "skipped", "failed"];

const pageSchema = new mongoose.Schema(
  {
    // The unique index is the database's own duplicate guard: even if the
    // crawler had a bug, MongoDB would refuse a second document for one URL.
    normalizedUrl: { type: String, required: true, unique: true },
    originalUrl: { type: String, required: true }, // as written in the href / CLI
    host: { type: String, required: true, index: true },
    depth: { type: Number, required: true, min: 0 }, // link hops from the seed
    seedUrl: { type: String, required: true },
    parentUrl: { type: String, default: null }, // page where we found this link
    status: { type: String, enum: PAGE_STATUSES, default: "queued", index: true },

    // Filled by the fetch step
    httpStatus: { type: Number, default: null },
    finalUrl: { type: String, default: null }, // after redirects
    contentType: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    contentHash: { type: String, default: null, index: true }, // SHA-256 of raw HTML
    rawRef: { type: String, default: null }, // path of the raw HTML file
    error: { type: String, default: null },

    // Filled by the parse step
    textRef: { type: String, default: null }, // path of the extracted text file
    title: { type: String, default: null },
    canonicalUrl: { type: String, default: null },
    outlinks: { type: [String], default: [] }, // normalized; used later by PageRank

    discoveredAt: { type: Date, required: true },
    fetchedAt: { type: Date, default: null },
    parsedAt: { type: Date, default: null },
  },
  { versionKey: false },
);

export default mongoose.model("Page", pageSchema);
