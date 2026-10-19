import mongoose from "mongoose";

// Named counters used as budgets, e.g. "<jobId>:pages" or "<jobId>:host:a.com".
// Several workers take from the same budget at once, so "check then
// increment" in two steps would let them overshoot. crawler/jobs/budgets.js
// does both in ONE atomic MongoDB operation instead.
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    n: { type: Number, default: 0 },
  },
  { versionKey: false },
);

export default mongoose.model("Counter", counterSchema);
