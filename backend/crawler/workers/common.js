// Small helpers shared by the fetch and parse handlers.

import CrawlJob from "../../server/models/CrawlJob.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { maybeCompleteJob } from "../jobs/jobService.js";

/** Load the URL and job a message points to (fresh reads: status may have changed). */
export async function loadWork(msg) {
  const url = await CrawlUrl.findById(msg.urlId).lean();
  const job = url ? await CrawlJob.findById(url.jobId).lean() : null;
  return { url, job };
}

/** Ack, then check whether that was the job's last piece of work. */
export async function finish(queue, msg, job, queues) {
  await queue.ack(msg);
  if (job) await maybeCompleteJob(job._id, queues);
}

// Returned by a handler that put its message back for later (politeness):
// runWorker then pauses briefly instead of leasing again straight away.
export const DEFERRED = "deferred";

// A paused job's message goes back to the queue. The 1 s delay stops this
// worker from leasing it again straight away, before its list of paused jobs
// (refreshed every second in runWorker) has caught up.
export const PAUSE_RELEASE_DELAY_MS = 1000;
