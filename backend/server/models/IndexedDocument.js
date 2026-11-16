import mongoose from "mongoose";

// One document per page in the search index, under a small integer id.
//
// Why not use the Content hash (64 hex characters) as the id in postings?
// Every posting repeats the docId, so a 64-character string per posting
// would make the index several times bigger. Integers are small, and they
// sort, which postings intersection (M4) depends on.
//
// This collection maps docId -> what a search result needs to show.
const indexedDocumentSchema = new mongoose.Schema(
  {
    _id: { type: Number }, // the docId used in Term postings
    contentHash: { type: String, required: true }, // Content._id
    url: { type: String, required: true },
    title: { type: String, default: "" },
    length: { type: Number, required: true }, // indexed terms (BM25 needs it in M5)
    textRef: { type: String, default: null }, // extracted text in the blob store (snippets)
    pagerank: { type: Number, default: 0 }, // link authority, computed at index build (M6)
    inlinks: { type: Number, default: 0 }, // indexed pages linking here (for display/debugging)
  },
  { versionKey: false },
);

export default mongoose.model("IndexedDocument", indexedDocumentSchema, "documents");
