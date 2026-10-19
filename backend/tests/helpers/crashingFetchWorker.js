// Run as a CHILD PROCESS by crashRecovery.test.js.
// It behaves like a real fetch worker until the worst moment: it leases a
// message, downloads the page, and then hangs before saving anything. The
// test then kills this process with SIGKILL (no cleanup code can run), just
// like a crash or a power cut.
//
// argv: <mongoUri> <dataDir>

import mongoose from "mongoose";
import { createFetcher } from "../../crawler/fetcher.js";
import { createMongoPoliteness } from "../../crawler/hostLimiter.js";
import { MongoQueue } from "../../crawler/queue/MongoQueue.js";
import { createRobots } from "../../crawler/robots.js";
import { createFetchHandler } from "../../crawler/workers/fetchHandler.js";
import { USER_AGENT } from "./pipeline.js";

const [mongoUri, visibilityMs] = process.argv.slice(2);
await mongoose.connect(mongoUri);

const queueOpts = { visibilityTimeoutMs: Number(visibilityMs) };
const fetchQueue = new MongoQueue({ name: "fetch", ...queueOpts });
const parseQueue = new MongoQueue({ name: "parse", ...queueOpts });
const fetcher = createFetcher({ userAgent: USER_AGENT, allowPrivateNetworks: true });
const politeness = createMongoPoliteness({ minDelayMs: 0 });
const robots = createRobots({ fetcher, politeness, userAgent: USER_AGENT });
const stuckBlobStore = {
  putRawHtml() {
    process.send("stuck"); // page downloaded; now "crash" before storing it
    return new Promise(() => {}); // never resolves
  },
};

const handle = createFetchHandler({ fetchQueue, parseQueue, fetcher, robots, politeness, blobStore: stuckBlobStore });
const msg = await fetchQueue.lease("doomed-worker");
await handle(msg);
