import mongoose from "mongoose";

// One document per DISTINCT page content, keyed by the SHA-256 of the raw HTML.
// When a second URL downloads bytes we have already parsed (e.g. "/" and
// "/index.html"), the fetch worker links that URL to this document and skips
// parsing: content-level deduplication.
const contentSchema = new mongoose.Schema(
  {
    _id: { type: String }, // SHA-256 hex of the raw HTML
    rawRef: { type: String, required: true },
    textRef: { type: String, required: true },
    title: { type: String, default: "" },
    canonicalUrl: { type: String, default: null },
    outlinks: { type: [String], default: [] },
    firstUrlId: { type: mongoose.Schema.Types.ObjectId, required: true }, // who parsed it first
    parsedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export default mongoose.model("Content", contentSchema);
