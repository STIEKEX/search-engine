import mongoose from "mongoose";

// Per-host politeness state shared by ALL worker processes.
// Stage 1 kept "next allowed time per host" in a Map in memory; with two
// fetch-worker processes each would have its own Map and both would hit the
// same site. Keeping it in MongoDB makes the 1-request-per-second rule global.
const hostSlotSchema = new mongoose.Schema(
  {
    _id: { type: String }, // host, e.g. "books.toscrape.com"
    startAt: { type: Date }, // start time of the most recently reserved request
    nextAllowedAt: { type: Date }, // earliest start time for the next request
  },
  { versionKey: false },
);

export default mongoose.model("HostSlot", hostSlotSchema);
