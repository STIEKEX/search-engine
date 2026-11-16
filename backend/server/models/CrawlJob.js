import mongoose from "mongoose";

// One document per crawl job created through POST /api/jobs.
//
//   running  --pause-->  paused  --resume-->  running
//   running | paused  --cancel-->  cancelled
//   running  --(both queues empty)-->  completed
export const JOB_STATUSES = ["running", "paused", "completed", "cancelled"];

const limitsSchema = new mongoose.Schema(
  {
    maxDepth: { type: Number, required: true },
    maxPages: { type: Number, required: true }, // fetch attempts for the whole job
    maxLinksPerPage: { type: Number, required: true },
    maxRedirects: { type: Number, required: true },
    maxResponseBytes: { type: Number, required: true },
    requestTimeoutMs: { type: Number, required: true },
    jobTimeoutMs: { type: Number, required: true },
    maxPagesPerHost: { type: Number, required: true },
    excludePatterns: { type: [String], default: [] }, // regex sources, tested on normalized URLs
    sameHostOnly: { type: Boolean, required: true },
    order: { type: String, enum: ["bfs", "inlinks"], default: "bfs" }, // which waiting URL is crawled next
  },
  { _id: false },
);

const crawlJobSchema = new mongoose.Schema(
  {
    seeds: { type: [String], required: true }, // normalized
    limits: { type: limitsSchema, required: true },
    status: { type: String, enum: JOB_STATUSES, default: "running", index: true },
    completionReason: { type: String, default: null }, // frontier_empty | max_pages | job_timeout
    deadline: { type: Date, required: true }, // createdAt + jobTimeoutMs
    finishedAt: { type: Date, default: null },
    // Set once, when maxPages is used up: from then on no new links are
    // admitted, and the waiting fetch work was dropped in bulk.
    budgetExhaustedAt: { type: Date, default: null },
    counters: {
      urlsAdmitted: { type: Number, default: 0 },
      duplicateUrls: { type: Number, default: 0 }, // links we already knew: URL-level dedup
      excludedUrls: { type: Number, default: 0 }, // dropped by depth / host / exclude patterns
    },
  },
  { timestamps: true, versionKey: false },
);

export default mongoose.model("CrawlJob", crawlJobSchema);
