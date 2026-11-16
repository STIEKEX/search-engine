// Politeness shared by every worker process, stored in MongoDB (HostSlot).
//
// Same idea as Stage 1's politeness.js ("reserve the next slot, then sleep
// until it"), but the reservation is one atomic MongoDB update, so two fetch
// workers in different processes can never pick the same slot:
//
//   startAt       = max(previous nextAllowedAt, now)
//   nextAllowedAt = startAt + gap
//
// Example, gap = 1000 ms, three workers asking for "a.com" at t=0:
//   worker A gets startAt 0     (waits 0 ms)
//   worker B gets startAt 1000  (waits 1000 ms)
//   worker C gets startAt 2000  (waits 2000 ms)
//
// Clock note: `now` is this worker's clock. Workers on one machine share a
// clock; across machines, clock skew would weaken the guarantee. Stage 3
// fixes that by using the shared server's clock (Redis TIME).

import HostSlot from "../server/models/HostSlot.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMongoPoliteness({ minDelayMs = 1000, model = HostSlot, now = Date.now, sleep = defaultSleep } = {}) {
  /** Reserve the next slot for `host`. @returns {Promise<number>} ms to wait before starting */
  async function reserve(host, crawlDelayMs = 0) {
    const gap = Math.max(minDelayMs, crawlDelayMs);
    const t = new Date(now());
    // An update PIPELINE (array form) can read the old value ($nextAllowedAt)
    // while computing the new one, all inside one atomic operation.
    const doc = await model.collection.findOneAndUpdate(
      { _id: host },
      [
        { $set: { startAt: { $max: [{ $ifNull: ["$nextAllowedAt", t] }, t] } } },
        { $set: { nextAllowedAt: { $add: ["$startAt", gap] } } },
      ],
      { upsert: true, returnDocument: "after" },
    );
    return Math.max(0, doc.startAt.getTime() - t.getTime());
  }

  /** Same interface as Stage 1's politeness: resolves when it is our turn. */
  async function waitTurn(host, crawlDelayMs = 0) {
    const waitMs = await reserve(host, crawlDelayMs);
    if (waitMs > 0) await sleep(waitMs);
  }

  /**
   * How long until `host` has a free slot, WITHOUT reserving it. Workers use
   * this to decide "wait here briefly" vs "put the message back for later":
   * reserving first and then giving up would waste the slot.
   */
  async function peek(host) {
    const doc = await model.collection.findOne({ _id: host }, { projection: { nextAllowedAt: 1 } });
    return doc?.nextAllowedAt ? Math.max(0, doc.nextAllowedAt.getTime() - now()) : 0;
  }

  return { reserve, waitTurn, peek, minDelayMs };
}
