// The pieces that let several worker processes cooperate through MongoDB:
// shared politeness (HostSlot), atomic budgets (Counter), and conditional
// URL state transitions.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { take } from "../../crawler/jobs/budgets.js";
import { createMongoPoliteness } from "../../crawler/hostLimiter.js";
import { canTransition, transition } from "../../crawler/urlStates.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
before(async () => (db = await startTestDb()));
after(() => db.stop());
beforeEach(() => db.clear());

test("two 'processes' asking for the same host get slots 1 s apart", async () => {
  const now = () => Date.parse("2026-01-01T00:00:00Z"); // frozen clock
  const workerA = createMongoPoliteness({ minDelayMs: 1000, now });
  const workerB = createMongoPoliteness({ minDelayMs: 1000, now }); // separate instance, shared DB
  const waits = await Promise.all([workerA.reserve("a.com"), workerB.reserve("a.com"), workerA.reserve("a.com")]);
  assert.deepEqual(waits.sort((x, y) => x - y), [0, 1000, 2000]);
});

test("shared politeness in real time: request starts are >= 1 s apart", async () => {
  const workerA = createMongoPoliteness({ minDelayMs: 1000 });
  const workerB = createMongoPoliteness({ minDelayMs: 1000 });
  const starts = [];
  await Promise.all([workerA, workerB].map(async (w) => {
    await w.waitTurn("a.com");
    starts.push(Date.now());
  }));
  assert.ok(Math.abs(starts[1] - starts[0]) >= 1000, `gap ${Math.abs(starts[1] - starts[0])} ms`);
});

test("a larger Crawl-delay is used, and other hosts are not affected", async () => {
  const now = () => Date.parse("2026-01-01T00:00:00Z");
  const p = createMongoPoliteness({ minDelayMs: 1000, now });
  await p.reserve("slow.com", 5000);
  assert.equal(await p.reserve("slow.com", 5000), 5000);
  assert.equal(await p.reserve("other.com"), 0);
});

test("a budget of 3 says yes exactly 3 times, even when 10 workers race", async () => {
  const answers = await Promise.all(Array.from({ length: 10 }, () => take("job1:pages", 3)));
  assert.equal(answers.filter(Boolean).length, 3);
});

test("a brand-new budget is not under-counted when racers all try to create it", async () => {
  // Regression: the losers of the "who inserts the counter" race used to
  // answer "no" while budget was left (1 or 2 yes instead of 3). It only
  // shows with truly parallel requests, so open pooled connections first.
  for (let round = 0; round < 20; round++) {
    await Promise.all(Array.from({ length: 10 }, () => mongoose.connection.db.admin().ping()));
    const answers = await Promise.all(Array.from({ length: 10 }, () => take(`fresh${round}:pages`, 3)));
    assert.equal(answers.filter(Boolean).length, 3, `round ${round}`);
  }
});

test("canTransition follows the documented table", () => {
  assert.equal(canTransition("queued", "fetched"), true);
  assert.equal(canTransition("fetched", "parsed"), true);
  assert.equal(canTransition("parsed", "queued"), true, "re-crawl");
  assert.equal(canTransition("skipped", "parsed"), false);
  assert.equal(canTransition("skipped", "fetched"), false);
});

test("transition is conditional: a repeated delivery cannot apply it twice", async () => {
  const url = await CrawlUrl.create({
    jobId: new mongoose.Types.ObjectId(),
    normalizedUrl: "https://a.com/",
    originalUrl: "https://a.com/",
    host: "a.com",
    depth: 0,
    seedUrl: "https://a.com/",
  });
  assert.equal(await transition(CrawlUrl, url._id, "queued", "fetched", { title: "first" }), true);
  assert.equal(await transition(CrawlUrl, url._id, "queued", "fetched", { title: "second" }), false);
  assert.equal((await CrawlUrl.findById(url._id)).title, "first");
  await assert.rejects(() => transition(CrawlUrl, url._id, "skipped", "parsed"), /Illegal URL transition/);
});

test("peek tells how long until a host is free, without reserving the slot", async () => {
  let t = Date.parse("2026-01-01T00:00:00Z");
  const p = createMongoPoliteness({ minDelayMs: 1000, now: () => t });
  assert.equal(await p.peek("new.com"), 0, "never used: free now");
  await p.reserve("busy.com", 5000);
  assert.equal(await p.peek("busy.com"), 5000);
  assert.equal(await p.peek("busy.com"), 5000, "peeking twice changes nothing");
  t += 2000;
  assert.equal(await p.peek("busy.com"), 3000);
});
