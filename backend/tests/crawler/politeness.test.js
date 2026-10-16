import { test } from "node:test";
import assert from "node:assert/strict";
import { createPoliteness } from "../../crawler/politeness.js";

// A fake clock: sleep() advances time instantly, so tests about long delays run fast.
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.t += ms;
  };
  return clock;
}

test("two requests to the same host start >= 1 s apart (real time)", async () => {
  const politeness = createPoliteness({ minDelayMs: 1000 });
  await politeness.waitTurn("a.com");
  const first = Date.now();
  await politeness.waitTurn("a.com");
  const second = Date.now();
  assert.ok(second - first >= 1000, `gap was only ${second - first} ms`);
});

test("different hosts do not wait for each other", async () => {
  const clock = fakeClock();
  const politeness = createPoliteness({ minDelayMs: 1000, now: clock.now, sleep: clock.sleep });
  await politeness.waitTurn("a.com");
  await politeness.waitTurn("b.com");
  assert.deepEqual(clock.sleeps, []);
});

test("only the remaining part of the gap is waited", async () => {
  const clock = fakeClock();
  const politeness = createPoliteness({ minDelayMs: 1000, now: clock.now, sleep: clock.sleep });
  await politeness.waitTurn("a.com");
  clock.t += 300; // the fetch itself took 300 ms
  await politeness.waitTurn("a.com");
  assert.deepEqual(clock.sleeps, [700]);
});

test("a robots.txt Crawl-delay larger than the floor wins", async () => {
  const clock = fakeClock();
  const politeness = createPoliteness({ minDelayMs: 1000, now: clock.now, sleep: clock.sleep });
  await politeness.waitTurn("a.com", 3000);
  await politeness.waitTurn("a.com", 3000);
  assert.equal(clock.t, 3000);
});

test("a Crawl-delay smaller than the floor cannot speed us up", async () => {
  const clock = fakeClock();
  const politeness = createPoliteness({ minDelayMs: 1000, now: clock.now, sleep: clock.sleep });
  await politeness.waitTurn("a.com", 200);
  await politeness.waitTurn("a.com", 200);
  assert.equal(clock.t, 1000);
});

test("concurrent callers for one host are queued, not sent together", async () => {
  const clock = fakeClock();
  const politeness = createPoliteness({ minDelayMs: 1000, now: clock.now, sleep: clock.sleep });
  await Promise.all([1, 2, 3].map(() => politeness.waitTurn("a.com")));
  // Slots at t=0, 1000 and 2000. Without the "reserve before sleeping" step,
  // callers 2 and 3 would both pick t=1000 and fire together.
  assert.equal(clock.t, 2000);
});
