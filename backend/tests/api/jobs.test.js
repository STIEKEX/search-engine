import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import app from "../../server/app.js";
import { startMockServer } from "../helpers/mockServer.js";
import { buildPipeline, waitForJob } from "../helpers/pipeline.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
let dataDir;
let site; // the mock website being crawled
let api; // our Express app on a random port
let pipeline;
let brokenPage = true; // /sometimes answers 500 while true

before(async () => {
  db = await startTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "api-test-"));
  site = await startMockServer({
    "/sometimes": (req, res) => {
      res.writeHead(brokenPage ? 500 : 200, { "content-type": "text/html" }).end("<title>Sometimes</title><p>up</p>");
    },
  });
  pipeline = buildPipeline({ dataDir, maxAttempts: 2 });
  // The API must use the same queues and blob store as the workers.
  app.locals.queues = pipeline.queues;
  app.locals.blobStore = pipeline.deps.blobStore;
  const server = app.listen(0);
  api = { server, base: `http://localhost:${server.address().port}/api` };
});
after(async () => {
  await pipeline.close();
  api.server.close();
  await site.close();
  await db.stop();
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await pipeline.stop();
  await db.clear();
});

async function call(method, route, body) {
  const res = await fetch(`${api.base}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------- validation

test("POST /api/jobs rejects bad input with 400 and a list of issues", async () => {
  const cases = [
    [{}, "seeds"],
    [{ seeds: [] }, "seeds"],
    [{ seeds: ["ftp://example.com/"] }, "seeds.0"],
    [{ seeds: ["not a url"] }, "seeds.0"],
    [{ seeds: [site.url("/")], limits: { maxPages: 0 } }, "limits.maxPages"],
    [{ seeds: [site.url("/")], limits: { maxDepth: 2.5 } }, "limits.maxDepth"],
    [{ seeds: [site.url("/")], limits: { excludePatterns: ["(unclosed"] } }, "limits.excludePatterns.0"],
  ];
  for (const [body, pathWithError] of cases) {
    const res = await call("POST", "/jobs", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.issues.some((i) => i.path === pathWithError), `${JSON.stringify(body)} -> ${JSON.stringify(res.body.issues)}`);
  }
});

test("POST /api/jobs rejects unknown fields (typos are not silently ignored)", async () => {
  const res = await call("POST", "/jobs", { seeds: [site.url("/")], limits: { maxPage: 5 } });
  assert.equal(res.status, 400);
  assert.match(res.body.issues[0].message, /maxPage/);
});

test("invalid JSON is a 400, not a 500", async () => {
  const res = await call("POST", "/jobs", "{ not json");
  assert.equal(res.status, 400);
});

test("a malformed id is 400, an unknown id is 404", async () => {
  assert.equal((await call("GET", "/jobs/123")).status, 400);
  assert.equal((await call("GET", "/jobs/0123456789abcdef01234567")).status, 404);
  assert.equal((await call("POST", "/jobs/0123456789abcdef01234567/pause")).status, 404);
});

// ---------------------------------------------------------------- job lifecycle

test("pause / resume / cancel follow the allowed transitions (409 otherwise)", async () => {
  const created = await call("POST", "/jobs", { seeds: [site.url("/")] });
  assert.equal(created.status, 201);
  const id = created.body.job.id;

  assert.equal((await call("POST", `/jobs/${id}/resume`)).status, 409, "cannot resume a running job");
  assert.equal((await call("POST", `/jobs/${id}/pause`)).body.job.status, "paused");
  assert.equal((await call("POST", `/jobs/${id}/pause`)).status, 409, "already paused");
  assert.equal((await call("POST", `/jobs/${id}/resume`)).body.job.status, "running");
  assert.equal((await call("POST", `/jobs/${id}/cancel`)).body.job.status, "cancelled");
  const again = await call("POST", `/jobs/${id}/resume`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "Cannot resume a cancelled job");
});

test("full flow: create a job, workers crawl it, read status, stats and pages", async () => {
  // Depth 2, because "/index.html" (the content duplicate of "/") is only
  // linked from depth-1 pages.
  const created = await call("POST", "/jobs", { seeds: [site.url("/")], limits: { maxDepth: 2 } });
  assert.equal(created.body.job.status, "running");
  pipeline.start();
  await waitForJob(created.body.job.id);
  const id = created.body.job.id;

  const status = await call("GET", `/jobs/${id}`);
  assert.equal(status.body.job.status, "completed");
  assert.ok(status.body.progress.parsed >= 4);

  const { stats } = (await call("GET", `/jobs/${id}/stats`)).body;
  assert.equal(stats.httpStatus["404"], 1);
  assert.equal(stats.deadLetters.fetch, 0);
  assert.equal(stats.duplicates.content, 1); // "/index.html"
  assert.equal(stats.skipReasons.robots_disallowed, 1);
  assert.deepEqual(stats.queues.fetch, { ready: 0, leased: 0, dead: 0, oldestReadyAgeMs: 0 });

  const list = await call("GET", `/pages?jobId=${id}&q=product&state=parsed`);
  assert.deepEqual(list.body.items.map((p) => p.title).sort(), ["Product A", "Product B"]);

  const one = await call("GET", `/pages/${list.body.items[0].id}`);
  assert.match(one.body.text, /Product (A|B)/);
  assert.equal(one.body.page.title, list.body.items[0].title);
});

test("GET /api/pages validates its query string", async () => {
  assert.equal((await call("GET", "/pages?limit=1000")).status, 400);
  assert.equal((await call("GET", "/pages?state=nonsense")).status, 400);
  assert.equal((await call("GET", "/pages?jobId=xyz")).status, 400);
});

test("failures: dead-lettered URLs are listed and can be retried", async () => {
  brokenPage = true;
  const created = await call("POST", "/jobs", { seeds: [site.url("/sometimes")] });
  const id = created.body.job.id;
  pipeline.start();
  await waitForJob(id);

  const { failures } = (await call("GET", `/jobs/${id}/failures`)).body;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "fetch");
  assert.equal(failures[0].lastError, "HTTP 500");
  assert.equal(failures[0].url, site.url("/sometimes"));

  brokenPage = false; // the site recovered
  assert.equal((await call("POST", `/jobs/${id}/failures/retry`)).body.retried, 1);
  await waitForJob(id);
  assert.equal((await call("GET", `/jobs/${id}/failures`)).body.failures.length, 0);
  assert.equal((await call("GET", `/jobs/${id}`)).body.progress.parsed, 1);
});

test("GET /api/health reports DB and storage readiness", async () => {
  const res = await call("GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.deepEqual(res.body.checks, { db: { ok: true }, storage: { ok: true } });
});
