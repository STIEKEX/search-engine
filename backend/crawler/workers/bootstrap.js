// Shared start-up for the two worker processes: read config, connect to
// MongoDB, build the collaborators, start the loop, stop cleanly on Ctrl+C.

import dns from "node:dns";
import mongoose from "mongoose";
import connectDb from "../../server/config/db.js";
import { createQueues, readConfig } from "../config.js";
import { createFetcher } from "../fetcher.js";
import { createMongoPoliteness } from "../hostLimiter.js";
import { createRobots } from "../robots.js";
import { LocalBlobStore } from "../storage/LocalBlobStore.js";
import { startWorker } from "./runWorker.js";

/**
 * @param {"fetch"|"parse"} kind
 * @param {Function} buildHandler  (deps) => async (msg) => void
 */
export async function runWorkerProcess(kind, buildHandler) {
  const config = readConfig();
  if (!config.mongoUri) throw new Error("MONGODB_URI is not set in .env");
  if (kind === "fetch" && !config.userAgent?.includes("@")) {
    throw new Error('Set CRAWLER_USER_AGENT in .env, e.g. "MiniSearchBot/0.1 (+mailto:you@example.com)"');
  }
  if (config.allowPrivateNetworks) console.warn("WARNING: ALLOW_PRIVATE_NETWORKS=true, SSRF protection is OFF");

  dns.setServers(["8.8.8.8", "1.1.1.1"]); // same reason as server/server.js (mongodb+srv lookups)
  await connectDb(config.mongoUri);

  const deps = buildDeps(kind, config);
  const worker = startWorker({
    queue: kind === "fetch" ? deps.fetchQueue : deps.parseQueue,
    handle: buildHandler(deps),
    concurrency: kind === "fetch" ? config.fetchConcurrency : config.parseConcurrency,
    workerId: `${kind}-${process.pid}`,
    log: console.log,
  });
  console.log(`${kind} worker started (pid ${process.pid})`);
  installShutdown(worker, deps);
}

function buildDeps(kind, config) {
  const deps = { ...createQueues(config), blobStore: new LocalBlobStore(config.dataDir), log: console.log };
  if (kind === "fetch") {
    deps.politeness = createMongoPoliteness({ minDelayMs: config.minDelayMs });
    deps.fetcher = createFetcher({ userAgent: config.userAgent, allowPrivateNetworks: config.allowPrivateNetworks });
    deps.maxInlineWaitMs = config.maxInlineWaitMs;
    deps.robots = createRobots({ fetcher: deps.fetcher, politeness: deps.politeness, userAgent: config.userAgent });
  }
  return deps;
}

function installShutdown(worker, deps) {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) process.exit(1); // second Ctrl+C: stop now
    stopping = true;
    console.log(`${signal}: finishing in-flight messages (Ctrl+C again to force)...`);
    await worker.stop();
    await deps.fetcher?.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
