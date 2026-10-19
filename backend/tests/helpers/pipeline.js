// Builds the whole Stage 2 pipeline inside the test process: two queues,
// fetcher, politeness, robots, blob store, and fetch/parse workers.
// Production runs the workers as separate processes; in-process loops share
// the same code and the same MongoDB, which is what the tests exercise.

import CrawlJob from "../../server/models/CrawlJob.js";
import { createFetcher } from "../../crawler/fetcher.js";
import { createMongoPoliteness } from "../../crawler/hostLimiter.js";
import { MongoQueue } from "../../crawler/queue/MongoQueue.js";
import { createRobots } from "../../crawler/robots.js";
import { LocalBlobStore } from "../../crawler/storage/LocalBlobStore.js";
import { createFetchHandler } from "../../crawler/workers/fetchHandler.js";
import { createParseHandler } from "../../crawler/workers/parseHandler.js";
import { startWorker } from "../../crawler/workers/runWorker.js";

export const USER_AGENT = "MiniSearchBot/0.1 (+mailto:test@example.com)";

export function buildPipeline({ dataDir, minDelayMs = 0, maxAttempts = 3, visibilityTimeoutMs = 10_000, fetcherOptions = {}, parse } = {}) {
  const queueOpts = { visibilityTimeoutMs, maxAttempts, backoff: { baseMs: 20, maxMs: 100 } }; // fast retries for tests
  const fetchQueue = new MongoQueue({ name: "fetch", ...queueOpts });
  const parseQueue = new MongoQueue({ name: "parse", ...queueOpts });
  // The mock server is on 127.0.0.1, so SSRF protection is switched off HERE,
  // explicitly, and nowhere globally.
  const fetcher = createFetcher({ userAgent: USER_AGENT, allowPrivateNetworks: true, totalTimeoutMs: 2000, ...fetcherOptions });
  const politeness = createMongoPoliteness({ minDelayMs });
  const robots = createRobots({ fetcher, politeness, userAgent: USER_AGENT });
  const blobStore = new LocalBlobStore(dataDir);
  const deps = { fetchQueue, parseQueue, fetcher, politeness, robots, blobStore, ...(parse && { parse }) };
  let workers = [];

  return {
    deps,
    queues: { fetchQueue, parseQueue },
    handleFetch: createFetchHandler(deps),
    handleParse: createParseHandler(deps),
    /** Start fetch and parse worker loops (fetchProcesses > 1 = several "processes"). */
    start({ fetchConcurrency = 2, parseConcurrency = 2, fetchProcesses = 1 } = {}) {
      for (let i = 0; i < fetchProcesses; i++) {
        workers.push(startWorker({ queue: fetchQueue, handle: createFetchHandler(deps), concurrency: fetchConcurrency, pollMs: 20, workerId: `fetch-${i}` }));
      }
      workers.push(startWorker({ queue: parseQueue, handle: createParseHandler(deps), concurrency: parseConcurrency, pollMs: 20, workerId: "parse" }));
    },
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
      workers = [];
    },
    async close() {
      await this.stop();
      await fetcher.close();
    },
  };
}

/** Poll until the job reaches `status`; fail with its last state on timeout. */
export async function waitForJob(jobId, { status = "completed", timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await CrawlJob.findById(jobId).lean();
    if (job?.status === status) return job;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} still "${job?.status}" after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
