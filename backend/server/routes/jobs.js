import { Router } from "express";
import { z } from "zod";
import { JobNotFoundError } from "../../crawler/jobs/errors.js";
import { countByState, jobStats, listFailures } from "../../crawler/jobs/jobStats.js";
import { changeJobStatus, createJob, refreshJob, retryFailures } from "../../crawler/jobs/jobService.js";
import { normalizeUrl } from "../../crawler/normalizeUrl.js";
import CrawlJob from "../models/CrawlJob.js";
import { checkIdParam, validate } from "./validation.js";

const router = Router();
router.param("id", checkIdParam);

const int = (min, max) => z.number().int().min(min).max(max);

// Exclude patterns become RegExps that run on every discovered URL, so they
// are limited in size and count, and must compile.
const regexSource = z
  .string()
  .min(1)
  .max(200)
  .refine((src) => {
    try {
      new RegExp(src);
      return true;
    } catch {
      return false;
    }
  }, "Invalid regular expression");

// Every limit is optional (defaults in jobService.js) but bounded, so one
// request cannot start a crawl of the whole internet.
const limitsSchema = z
  .object({
    maxDepth: int(0, 10),
    maxPages: int(1, 10_000),
    maxLinksPerPage: int(0, 1000),
    maxRedirects: int(0, 10),
    maxResponseBytes: int(1024, 20 * 1024 * 1024),
    requestTimeoutMs: int(100, 120_000),
    jobTimeoutMs: int(1000, 7 * 24 * 60 * 60 * 1000),
    maxPagesPerHost: int(1, 10_000),
    excludePatterns: z.array(regexSource).max(20),
    sameHostOnly: z.boolean(),
    order: z.enum(["bfs", "inlinks"]), // bfs = oldest first; inlinks = most linked-to first
  })
  .partial()
  .strict(); // unknown keys are errors: a typo like "maxPage" must not be silently ignored

const createJobSchema = z
  .object({
    seeds: z.array(z.string().refine((s) => normalizeUrl(s) !== null, "Must be an absolute http(s) URL")).min(1).max(20),
    limits: limitsSchema.optional(),
  })
  .strict();

function serializeJob(job) {
  const { _id, seeds, limits, status, completionReason, counters, createdAt, deadline, finishedAt } = job;
  return { id: _id, status, seeds, limits, completionReason, counters, createdAt, deadline, finishedAt };
}

async function findJob(id) {
  const job = await CrawlJob.findById(id).lean();
  if (!job) throw new JobNotFoundError(`Job ${id} not found`);
  return job;
}

// POST /api/jobs: create a crawl job; workers pick it up from the queue.
router.post("/jobs", async (req, res) => {
  const body = validate(createJobSchema, req.body, res);
  if (!body) return;
  const job = await createJob(body, req.app.locals.queues);
  res.status(201).json({ job: serializeJob(job) });
});

// GET /api/jobs/:id: status plus how many URLs are in each state.
router.get("/jobs/:id", async (req, res) => {
  const job = await findJob(req.params.id);
  res.json({ job: serializeJob(job), progress: await countByState(job._id) });
});

// POST /api/jobs/:id/pause | resume | cancel
for (const action of ["pause", "resume", "cancel"]) {
  router.post(`/jobs/:id/${action}`, async (req, res) => {
    const job = await changeJobStatus(req.params.id, action, req.app.locals.queues);
    res.json({ job: serializeJob(job) });
  });
}

router.get("/jobs/:id/stats", async (req, res) => {
  const job = await findJob(req.params.id);
  res.json({ job: serializeJob(job), stats: await jobStats(job, req.app.locals.queues) });
});

router.get("/jobs/:id/failures", async (req, res) => {
  const job = await findJob(req.params.id);
  res.json({ failures: await listFailures(job._id, req.app.locals.queues) });
});

router.post("/jobs/:id/failures/retry", async (req, res) => {
  const job = await findJob(req.params.id);
  res.json({ retried: await retryFailures(job._id, req.app.locals.queues) });
});

const refreshSchema = z
  .object({
    olderThanDays: z.number().min(0).max(365).default(7), // re-check pages fetched before this
    limit: int(1, 10_000).default(1000),
  })
  .strict();

// POST /api/jobs/:id/refresh { olderThanDays, limit }: re-crawl stale pages
// with conditional requests (unchanged pages answer 304 and are not re-parsed).
router.post("/jobs/:id/refresh", async (req, res) => {
  const body = validate(refreshSchema, req.body ?? {}, res);
  if (!body) return;
  const job = await findJob(req.params.id);
  const queued = await refreshJob(job._id, { olderThanMs: body.olderThanDays * 24 * 60 * 60 * 1000, limit: body.limit }, req.app.locals.queues);
  res.json({ queued });
});

export default router;
