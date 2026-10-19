import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoQueue } from "../../crawler/queue/MongoQueue.js";
import { backoffDelay } from "../../crawler/queue/Queue.js";
import QueueMessage from "../../server/models/QueueMessage.js";
import { startTestDb } from "../helpers/testDb.js";

let db;
before(async () => (db = await startTestDb()));
after(() => db.stop());
beforeEach(() => db.clear());

// A clock the test moves by hand, so "wait 2 minutes" takes no time.
function makeQueue(opts = {}) {
  const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
  const queue = new MongoQueue({
    name: "fetch",
    visibilityTimeoutMs: 60_000,
    maxAttempts: 3,
    backoff: { baseMs: 1000, maxMs: 10_000 },
    now: () => new Date(clock.t),
    random: () => 0.5,
    ...opts,
  });
  return { queue, clock };
}
const newMessage = () => ({ jobId: new mongoose.Types.ObjectId(), urlId: new mongoose.Types.ObjectId() });

test("lease hands a message to one worker only", async () => {
  const { queue } = makeQueue();
  await queue.enqueue(newMessage());
  const first = await queue.lease("A");
  assert.equal(first.status, "leased");
  assert.equal(first.attempts, 1);
  assert.equal(await queue.lease("B"), null); // hidden while leased
});

test("enqueueing the same URL twice keeps one message", async () => {
  const { queue } = makeQueue();
  const msg = newMessage();
  assert.equal(await queue.enqueue(msg), true);
  assert.equal(await queue.enqueue(msg), false);
  assert.equal(await queue.enqueueMany([msg, newMessage()]), 1);
  assert.equal(await QueueMessage.countDocuments(), 2);
});

test("ack removes the message", async () => {
  const { queue } = makeQueue();
  await queue.enqueue(newMessage());
  const msg = await queue.lease("A");
  assert.equal(await queue.ack(msg), true);
  assert.equal(await QueueMessage.countDocuments(), 0);
});

test("visibility timeout: an expired lease goes to another worker, and the old ack fails", async () => {
  const { queue, clock } = makeQueue();
  await queue.enqueue(newMessage());
  const crashed = await queue.lease("A"); // worker A "crashes" and never acks

  clock.t += 59_000;
  assert.equal(await queue.lease("B"), null, "still hidden before the timeout");

  clock.t += 2_000;
  const recovered = await queue.lease("B");
  assert.ok(recovered, "visible again after the timeout");
  assert.equal(String(recovered._id), String(crashed._id));
  assert.equal(recovered.attempts, 2);
  assert.notEqual(recovered.leaseToken, crashed.leaseToken);

  assert.equal(await queue.ack(crashed), false, "A's late ack must not delete B's work");
  assert.equal(await queue.ack(recovered), true);
});

test("nack schedules a retry after an exponential backoff", async () => {
  const { queue, clock } = makeQueue();
  await queue.enqueue(newMessage());
  const msg = await queue.lease("A");
  const { dead, delayMs } = await queue.nack(msg, "HTTP 503");
  assert.equal(dead, false);
  assert.equal(delayMs, backoffDelay(1, { baseMs: 1000, maxMs: 10_000, random: () => 0.5 }));

  clock.t += delayMs - 1;
  assert.equal(await queue.lease("A"), null, "not before the backoff ends");
  clock.t += 1;
  const retried = await queue.lease("A");
  assert.equal(retried.attempts, 2);
  assert.equal(retried.lastError, "HTTP 503");
});

test("after maxAttempts the message is dead-lettered and never delivered again", async () => {
  const { queue, clock } = makeQueue({ maxAttempts: 2 });
  await queue.enqueue(newMessage());
  let msg = await queue.lease("A");
  await queue.nack(msg, "boom 1");
  clock.t += 60_000;
  msg = await queue.lease("A");
  const result = await queue.nack(msg, "boom 2");
  assert.equal(result.dead, true);

  clock.t += 3_600_000;
  assert.equal(await queue.lease("A"), null);
  const stats = await queue.stats();
  assert.equal(stats.dead, 1);
  assert.equal((await queue.listDead(msg.jobId))[0].lastError, "boom 2");
});

test("a message whose worker keeps crashing (poison message) is dead-lettered", async () => {
  const { queue, clock } = makeQueue({ maxAttempts: 2 });
  await queue.enqueue(newMessage());
  for (let i = 0; i < 2; i++) {
    assert.ok(await queue.lease("A")); // leased... and never acked or nacked
    clock.t += 61_000;
  }
  assert.equal(await queue.lease("A"), null, "third delivery refused");
  assert.equal((await queue.stats()).dead, 1);
});

test("release gives a message back without using up an attempt", async () => {
  const { queue } = makeQueue();
  await queue.enqueue(newMessage());
  await queue.release(await queue.lease("A"));
  const again = await queue.lease("A");
  assert.equal(again.attempts, 1);
});

test("lease skips messages of excluded (paused) jobs", async () => {
  const { queue } = makeQueue();
  const paused = newMessage();
  await queue.enqueue(paused);
  assert.equal(await queue.lease("A", { excludeJobIds: [paused.jobId] }), null);
  assert.ok(await queue.lease("A"));
});

test("retryDead puts dead messages back with a fresh retry budget", async () => {
  const { queue } = makeQueue({ maxAttempts: 1 });
  const m = newMessage();
  await queue.enqueue(m);
  await queue.nack(await queue.lease("A"), "boom");
  assert.equal(await queue.retryDead(m.jobId), 1);
  const msg = await queue.lease("A");
  assert.equal(msg.attempts, 1);
});

test("stats counts statuses and the age of the oldest waiting message", async () => {
  const { queue, clock } = makeQueue();
  await queue.enqueue(newMessage());
  await queue.enqueue(newMessage());
  await queue.lease("A");
  clock.t += 5000;
  assert.deepEqual(await queue.stats(), { ready: 1, leased: 1, dead: 0, oldestReadyAgeMs: 5000 });
});

test("backoffDelay doubles per attempt, is capped, and adds jitter", () => {
  const opts = { baseMs: 1000, maxMs: 8000 };
  assert.equal(backoffDelay(1, { ...opts, random: () => 0 }), 500); // half fixed...
  assert.equal(backoffDelay(1, { ...opts, random: () => 1 }), 1000); // ...half random
  assert.equal(backoffDelay(3, { ...opts, random: () => 1 }), 4000);
  assert.equal(backoffDelay(10, { ...opts, random: () => 1 }), 8000); // capped
  const spread = new Set(Array.from({ length: 50 }, () => backoffDelay(2, opts)));
  assert.ok(spread.size > 1, "jitter makes retries differ");
});
