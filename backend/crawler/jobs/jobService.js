// Job-level logic shared by the API and both workers:
//   createJob        -> job document + seeds into the frontier
//   admitLinks       -> new links from a page into the frontier (with limits)
//   maybeCompleteJob -> "is there any work left?" after every finished message
//   changeJobStatus  -> pause / resume / cancel
//   retryFailures    -> put dead-lettered work back in line

import CrawlJob from "../../server/models/CrawlJob.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { hostOf, normalizeUrl } from "../normalizeUrl.js";
import { pagesKey, used } from "./budgets.js";
import { JobInputError, JobNotFoundError, JobStateError } from "./errors.js";

export const DEFAULT_JOB_LIMITS = {
  maxDepth: 2,
  maxPages: 100,
  maxLinksPerPage: 100,
  maxRedirects: 5,
  maxResponseBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 20_000,
  jobTimeoutMs: 60 * 60 * 1000,
  maxPagesPerHost: 100,
  excludePatterns: [],
  sameHostOnly: true,
  order: "bfs", // "bfs" = oldest first; "inlinks" = most linked-to first
};

export async function createJob({ seeds, limits = {} }, queues) {
  const normalized = seeds.map((seed) => normalizeUrl(seed));
  const badIndex = normalized.indexOf(null);
  if (badIndex !== -1) throw new JobInputError(`Seed is not an absolute http(s) URL: ${seeds[badIndex]}`);

  const merged = { ...DEFAULT_JOB_LIMITS, ...limits };
  const job = await CrawlJob.create({
    seeds: [...new Set(normalized)],
    limits: merged,
    deadline: new Date(Date.now() + merged.jobTimeoutMs),
  });
  const candidates = normalized.map((url, i) => ({ url, href: seeds[i], depth: 0, seedUrl: url, parentUrl: null }));
  await admitUrls(job, candidates, queues);
  await maybeCompleteJob(job._id, queues); // every seed may have been excluded
  return job;
}

/** Links found on `parent` (a CrawlUrl doc): apply limits, then admit. */
export function admitLinks(job, parent, links, queues) {
  const candidates = links.map((link) => ({
    url: link.url,
    href: link.href,
    depth: parent.depth + 1,
    seedUrl: parent.seedUrl,
    parentUrl: parent.normalizedUrl,
  }));
  return admitUrls(job, candidates, queues, { cap: job.limits.maxLinksPerPage });
}

/**
 * Insert new URLs into the frontier and queue them for fetching.
 * Safe to call twice with the same input (a redelivered message does this):
 * existing URLs are left alone, and enqueueing is a no-op for queued ones.
 */
export async function admitUrls(job, candidates, { fetchQueue }, { cap = Infinity } = {}) {
  // Page budget used up: nothing new could ever be fetched, so admitting it
  // would only create work that has to be skipped again.
  const allowed = job.budgetExhaustedAt ? [] : candidates.filter((c) => isAllowedCandidate(job, c));
  const accepted = dedupeByUrl(allowed).slice(0, cap); // filter first, then cap
  const excluded = candidates.length - accepted.length;

  let inserted = 0;
  if (accepted.length > 0) {
    inserted = await insertNewUrls(job, accepted);
    // Queue every accepted URL that is still waiting, not only the ones we just
    // inserted: if a crash hit between "insert" and "enqueue" last time, this
    // repairs it. enqueueMany ignores URLs that already have a message.
    const waiting = await CrawlUrl.find({ jobId: job._id, normalizedUrl: { $in: accepted.map((c) => c.url) }, state: "queued" }, { _id: 1 }).lean();
    await fetchQueue.enqueueMany(waiting.map((u) => ({ jobId: job._id, urlId: u._id })));
    // Priority crawling: every page that links to a waiting URL is one vote
    // for it (new URLs go 0 -> 1, known ones n -> n + 1). With a page budget,
    // widely linked pages ("India", "Water") get crawled before one-off ones.
    // A heuristic: a redelivered parse message may count its links twice.
    if (job.limits.order === "inlinks") await fetchQueue.bumpPriority(waiting.map((u) => u._id));
  }
  await CrawlJob.updateOne(
    { _id: job._id },
    { $inc: { "counters.urlsAdmitted": inserted, "counters.duplicateUrls": accepted.length - inserted, "counters.excludedUrls": excluded } },
  );
  return { inserted, duplicates: accepted.length - inserted, excluded };
}

const DROP_BATCH = 1000; // URL ids per bulk update/delete

/**
 * maxPages is used up. Without this, every URL still waiting in the fetch
 * queue would be leased and skipped ONE BY ONE: on a big site that is
 * thousands of round trips (hours on Atlas). Instead, drop them in bulk.
 *
 * Only URLs that have NOT taken budget are dropped. A budgeted URL is either
 * being fetched right now or waiting for a retry; its page counts against
 * maxPages and must still be completed. Runs once per job (the flag).
 */
export async function onPageBudgetExhausted(jobId, { fetchQueue }) {
  const flagged = await CrawlJob.updateOne({ _id: jobId, budgetExhaustedAt: null }, { $set: { budgetExhaustedAt: new Date() } });
  if (flagged.modifiedCount === 0) return 0; // another worker already did it

  const ids = (await CrawlUrl.find({ jobId, state: "queued", "fetch.budgeted": false }, { _id: 1 }).lean()).map((u) => u._id);
  for (let i = 0; i < ids.length; i += DROP_BATCH) {
    const batch = ids.slice(i, i + DROP_BATCH);
    // URL first, then message: a worker that leases one of these messages in
    // between sees "skipped" and just acks it.
    await CrawlUrl.updateMany(
      { _id: { $in: batch }, state: "queued", "fetch.budgeted": false },
      { $set: { state: "skipped", skipReason: "max_pages" } },
    );
    await fetchQueue.deleteReady(jobId, { urlIds: batch });
  }
  return ids.length;
}

function isAllowedCandidate(job, c) {
  if (c.depth > job.limits.maxDepth) return false;
  if (job.limits.sameHostOnly && hostOf(c.url) !== hostOf(c.seedUrl)) return false;
  return !isExcluded(job, c.url);
}

function dedupeByUrl(candidates) {
  const byUrl = new Map();
  for (const c of candidates) if (!byUrl.has(c.url)) byUrl.set(c.url, c);
  return [...byUrl.values()];
}

// Compiled exclude patterns, cached per job so we do not rebuild RegExps per link.
const excludeCache = new Map();

export function isExcluded(job, url) {
  const key = String(job._id);
  if (!excludeCache.has(key)) excludeCache.set(key, job.limits.excludePatterns.map((p) => new RegExp(p)));
  return excludeCache.get(key).some((re) => re.test(url));
}

/**
 * One bulkWrite of "insert if absent" upserts keyed on the unique
 * (jobId, normalizedUrl) index. @returns {Promise<number>} how many were new
 */
async function insertNewUrls(job, accepted) {
  const ops = accepted.map((c) => ({
    updateOne: {
      filter: { jobId: job._id, normalizedUrl: c.url },
      update: { $setOnInsert: newUrlDoc(job, c) },
      upsert: true,
    },
  }));
  try {
    // The raw driver collection: we build complete documents ourselves, so
    // Mongoose's casting/defaults are not needed here.
    return (await CrawlUrl.collection.bulkWrite(ops, { ordered: false })).upsertedCount;
  } catch (err) {
    // Two workers upserting the same new URL at the same instant: one insert
    // wins, the other gets a duplicate-key error. For us that is just "duplicate".
    const writeErrors = [].concat(err.writeErrors ?? []);
    if (writeErrors.length > 0 && writeErrors.every((e) => e.code === 11000)) return err.result?.upsertedCount ?? 0;
    throw err;
  }
}

function newUrlDoc(job, c) {
  // new CrawlUrl(...) applies the schema defaults (fetch.attempts = 0, ...);
  // toObject() turns it into a plain document for the driver.
  return new CrawlUrl({
    jobId: job._id,
    normalizedUrl: c.url,
    originalUrl: c.href ?? c.url,
    host: hostOf(c.url),
    depth: c.depth,
    seedUrl: c.seedUrl,
    parentUrl: c.parentUrl,
    state: "queued",
    discoveredAt: new Date(),
  }).toObject();
}

/**
 * Complete the job if no work is left in either queue. Called after every
 * ack. Each worker enqueues follow-up work BEFORE acking its own message, so
 * "0 pending" can only be seen once the whole crawl is really finished.
 */
export async function maybeCompleteJob(jobId, { fetchQueue, parseQueue }) {
  const [fetchPending, parsePending] = await Promise.all([fetchQueue.hasPending(jobId), parseQueue.hasPending(jobId)]);
  if (fetchPending || parsePending) return false;

  const job = await CrawlJob.findById(jobId).lean();
  if (!job || job.status !== "running") return false;
  const result = await CrawlJob.updateOne(
    { _id: jobId, status: "running" }, // conditional: if two workers race, one wins
    { $set: { status: "completed", completionReason: await completionReason(job), finishedAt: new Date() } },
  );
  return result.modifiedCount === 1;
}

async function completionReason(job) {
  if (Date.now() > job.deadline.getTime()) return "job_timeout";
  if ((await used(pagesKey(job._id))) >= job.limits.maxPages) return "max_pages";
  return "frontier_empty";
}

const STATUS_MOVES = {
  pause: { from: ["running"], to: "paused" },
  resume: { from: ["paused"], to: "running" },
  cancel: { from: ["running", "paused"], to: "cancelled" },
};

export async function changeJobStatus(jobId, action, queues) {
  const move = STATUS_MOVES[action];
  const extra = move.to === "cancelled" ? { finishedAt: new Date(), completionReason: "cancelled" } : {};
  const job = await CrawlJob.findOneAndUpdate({ _id: jobId, status: { $in: move.from } }, { $set: { status: move.to, ...extra } }, { returnDocument: "after" }).lean();
  if (!job) {
    const existing = await CrawlJob.findById(jobId).lean();
    if (!existing) throw new JobNotFoundError(`Job ${jobId} not found`);
    throw new JobStateError(`Cannot ${action} a ${existing.status} job`);
  }
  if (action === "cancel") await dropPendingWork(job, queues);
  // Nothing may be left to do after a resume (the last message finished while
  // paused), and nobody else would notice.
  if (action === "resume") await maybeCompleteJob(job._id, queues);
  return job;
}

async function dropPendingWork(job, { fetchQueue, parseQueue }) {
  await Promise.all([fetchQueue.deleteReady(job._id), parseQueue.deleteReady(job._id)]);
  // queued -> skipped is an allowed transition; done in bulk for speed.
  await CrawlUrl.updateMany({ jobId: job._id, state: "queued" }, { $set: { state: "skipped", skipReason: "job_cancelled" } });
}

/** Move dead-lettered work back into the queues. @returns {Promise<number>} */
export async function retryFailures(jobId, { fetchQueue, parseQueue }) {
  const job = await CrawlJob.findById(jobId).lean();
  if (!job) throw new JobNotFoundError(`Job ${jobId} not found`);
  if (job.status === "cancelled") throw new JobStateError("Cannot retry failures of a cancelled job");

  const [deadFetch, deadParse] = await Promise.all([fetchQueue.listDead(jobId), parseQueue.listDead(jobId)]);
  // URL state first, then the message: a worker must never lease a message
  // whose URL is still "failed".
  await CrawlUrl.updateMany({ _id: { $in: deadFetch.map((m) => m.urlId) }, state: "failed" }, { $set: { state: "queued", skipReason: null } });
  await CrawlUrl.updateMany({ _id: { $in: deadParse.map((m) => m.urlId) }, state: "failed" }, { $set: { state: "fetched" } });
  const retried = (await fetchQueue.retryDead(jobId)) + (await parseQueue.retryDead(jobId));

  if (retried > 0 && job.status === "completed") {
    // Re-open the job, with a fresh time budget, so the retried work can run.
    await CrawlJob.updateOne(
      { _id: jobId, status: "completed" },
      { $set: { status: "running", finishedAt: null, completionReason: null, deadline: new Date(Date.now() + job.limits.jobTimeoutMs) } },
    );
  }
  return retried;
}

/**
 * Re-crawl: queue again the pages of a job that were fetched before
 * `olderThanMs` ago. The fetch worker sends the stored validators, so an
 * unchanged page costs one tiny "304 Not Modified" and is not parsed again;
 * a changed page goes through fetch -> parse as usual.
 * No page budget is used (these URLs were counted the first time), and no
 * new links are admitted if the job's budget is already used up.
 * @returns {Promise<number>} how many pages were queued
 */
export async function refreshJob(jobId, { olderThanMs, limit = 1000 }, { fetchQueue }) {
  const job = await CrawlJob.findById(jobId).lean();
  if (!job) throw new JobNotFoundError(`Job ${jobId} not found`);
  if (job.status === "cancelled") throw new JobStateError("Cannot refresh a cancelled job");

  const cutoff = new Date(Date.now() - olderThanMs);
  const urls = await CrawlUrl.find({ jobId, state: { $in: ["parsed", "duplicate"] }, "fetch.fetchedAt": { $lte: cutoff } }, { state: 1 })
    .sort({ "fetch.fetchedAt": 1 }) // stalest first
    .limit(limit)
    .lean();
  if (urls.length === 0) return 0;

  // parsed | duplicate -> queued, remembering where to return if unchanged.
  // Conditional per URL (WHERE state = its old state), like transition().
  const moved = await CrawlUrl.bulkWrite(
    urls.map((u) => ({
      updateOne: { filter: { _id: u._id, state: u.state }, update: { $set: { state: "queued", "fetch.previousState": u.state } } },
    })),
    { ordered: false },
  );
  // Re-open the job (with a fresh time budget) so the workers take its messages.
  await CrawlJob.updateOne(
    { _id: jobId },
    { $set: { status: "running", finishedAt: null, completionReason: null, deadline: new Date(Date.now() + job.limits.jobTimeoutMs) } },
  );
  await fetchQueue.enqueueMany(urls.map((u) => ({ jobId: job._id, urlId: u._id })));
  return moved.modifiedCount;
}
