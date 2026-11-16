import mongoose from "mongoose";

// The inverted index: one document per (term, chunk).
//
//   { term: "cat", chunk: 0, df: 2,
//     postings: [ { docId: 0, tf: 1, positions: [1] },
//                 { docId: 4, tf: 3, positions: [0, 7, 19] } ] }
//
// df (document frequency) = how many documents contain the term.
// tf (term frequency)     = how often it occurs in ONE document.
// Postings are sorted by docId, which is what makes intersecting two lists
// fast in M4 (walk both lists once, like the merge step of merge sort).
//
// Why chunks? A MongoDB document can hold at most 16 MB. A very common term
// in a big corpus can have a longer postings list than that, so the indexer
// splits it into chunk 0, 1, 2... (each well below the limit). Readers load
// all chunks of a term sorted by chunk and concatenate them. With a few
// thousand pages almost every term fits in chunk 0.
//
// The indexer writes this collection directly (see indexer/buildIndex.js);
// this model is for reading.
const postingSchema = new mongoose.Schema(
  {
    docId: { type: Number, required: true }, // IndexedDocument._id
    tf: { type: Number, required: true },
    positions: { type: [Number], default: [] }, // word positions, ascending
  },
  { _id: false }, // thousands of postings: no ObjectId for each one
);

const termSchema = new mongoose.Schema(
  {
    term: { type: String, required: true },
    chunk: { type: Number, required: true, min: 0 },
    df: { type: Number, required: true }, // for the WHOLE term, same on every chunk
    display: { type: String }, // most common spelling ("france" for "franc"), chunk 0 only
    postings: { type: [postingSchema], default: [] },
  },
  { versionKey: false },
);

// Looking up a term is the hot path of every search: this index makes it
// one B-tree lookup instead of a scan of the whole vocabulary.
termSchema.index({ term: 1, chunk: 1 }, { unique: true });

export default mongoose.model("Term", termSchema, "terms");
