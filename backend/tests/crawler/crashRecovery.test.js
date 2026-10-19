import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJob } from "../../crawler/jobs/jobService.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import QueueMessage from "../../server/models/QueueMessage.js";
import { startMockServer } from "../helpers/mockServer.js";
import { buildPipeline, waitForJob } from "../helpers/pipeline.js";
import { startTestDb } from "../helpers/testDb.js";

const CHILD = fileURLToPath(new URL("../helpers/crashingFetchWorker.js", import.meta.url));
const VISIBILITY_MS = 1500;
let db;
let dataDir;
let server;

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "crash-test-"));
  server = await startMockServer();
});
after(async () => {
  await server.close();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("a worker killed mid-task: the lease expires and another worker finishes the job once", async () => {
  const pipeline = buildPipeline({ dataDir, visibilityTimeoutMs: VISIBILITY_MS });
  const job = await createJob({ seeds: [server.url("/about.html")], limits: { maxDepth: 0 } }, pipeline.queues);

  // 1. A separate worker process leases the message, downloads the page...
  const child = fork(CHILD, [db.uri, String(VISIBILITY_MS)], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
  // ...and dies before saving anything. SIGKILL: no cleanup, no ack, no nack.
  child.removeAllListeners("exit");
  child.kill("SIGKILL");

  const leased = await QueueMessage.findOne({ queue: "fetch" }).lean();
  assert.equal(leased.status, "leased", "the dead worker still 'holds' the message");
  assert.equal((await CrawlUrl.findOne().lean()).state, "queued", "nothing was saved");

  // 2. A healthy worker starts. Once the lease expires, it takes over.
  pipeline.start();
  await waitForJob(job._id, { timeoutMs: 10_000 });
  await pipeline.close();

  // 3. The work completed exactly once: one URL, parsed, nothing left queued.
  const urls = await CrawlUrl.find().lean();
  assert.equal(urls.length, 1);
  assert.equal(urls[0].state, "parsed");
  assert.equal(urls[0].fetch.attempts, 2, "the crashed attempt + the successful one");
  assert.equal(await QueueMessage.countDocuments(), 0);
  // Honest consequence of at-least-once delivery: the page was DOWNLOADED twice
  // (the crashed worker had already fetched it). Results are not duplicated.
  assert.equal(server.pathsRequested().filter((p) => p === "/about.html").length, 2);
});
