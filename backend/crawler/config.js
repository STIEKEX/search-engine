// Configuration for the workers and the API, read from environment variables
// (backend/.env). One place, so both sides build their queues the same way.

import { MongoQueue } from "./queue/MongoQueue.js";
import { DEFAULT_DATA_DIR } from "./storage/LocalBlobStore.js";

function int(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function readConfig(env = process.env) {
  return {
    mongoUri: env.MONGODB_URI,
    userAgent: env.CRAWLER_USER_AGENT,
    dataDir: env.CRAWLER_DATA_DIR || DEFAULT_DATA_DIR,
    // CLAUDE.md rule: at least 1 s between requests to a host. Env can only slow it down.
    minDelayMs: Math.max(1000, int(env.CRAWLER_MIN_DELAY_MS, 1000)),
    fetchConcurrency: Math.max(1, int(env.FETCH_CONCURRENCY, 2)),
    parseConcurrency: Math.max(1, int(env.PARSE_CONCURRENCY, 2)),
    // Must be longer than the slowest message takes, including politeness
    // waits (about concurrency x 1 s for one busy host) plus the fetch timeout.
    visibilityTimeoutMs: int(env.QUEUE_VISIBILITY_TIMEOUT_MS, 120_000),
    maxRetries: int(env.QUEUE_MAX_RETRIES, 3),
    backoffBaseMs: int(env.QUEUE_BACKOFF_BASE_MS, 2000),
    backoffMaxMs: int(env.QUEUE_BACKOFF_MAX_MS, 60_000),
    // Only the exact string "true" turns SSRF protection off.
    allowPrivateNetworks: env.ALLOW_PRIVATE_NETWORKS === "true",
  };
}

export function createQueues(config) {
  const common = {
    visibilityTimeoutMs: config.visibilityTimeoutMs,
    maxAttempts: config.maxRetries + 1, // first try + retries
    backoff: { baseMs: config.backoffBaseMs, maxMs: config.backoffMaxMs },
  };
  return {
    fetchQueue: new MongoQueue({ name: "fetch", ...common }),
    parseQueue: new MongoQueue({ name: "parse", ...common }),
  };
}
