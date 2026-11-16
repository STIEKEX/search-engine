// Atomic budgets for job limits (maxPages, maxPagesPerHost).
//
// Why not just count documents? Two fetch workers could both run
// "count = 9, limit = 10, OK!" at the same moment and both fetch: 11 pages.
// take() does the check and the increment in ONE MongoDB operation:
//   "increment n WHERE n < max"
// MongoDB applies single-document updates one at a time, so exactly
// `max` calls can ever succeed, however many workers race.

import Counter from "../../server/models/Counter.js";

/** Take one unit from budget `key` (limit `max`). @returns {Promise<boolean>} */
export async function take(key, max) {
  // At most two attempts. A duplicate-key error (E11000) has two causes:
  //   1. n >= max: the filter did not match, so the upsert tried to INSERT a
  //      second document with the same _id. The budget really is used up.
  //   2. The counter did not exist yet and several workers raced: ALL of them
  //      tried to insert it, one won, the rest got E11000 with budget left.
  // After a first E11000 the document certainly exists, so cause 2 cannot
  // happen again: a second E11000 can only mean cause 1.
  for (let attempt = 1; ; attempt++) {
    try {
      await Counter.findOneAndUpdate({ _id: key, n: { $lt: max } }, { $inc: { n: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      if (attempt === 2) return false;
    }
  }
}

/** Return one unit (used when a second budget refuses after the first said yes). */
export async function give(key) {
  await Counter.updateOne({ _id: key, n: { $gt: 0 } }, { $inc: { n: -1 } });
}

export async function used(key) {
  return (await Counter.findById(key).lean())?.n ?? 0;
}

export const pagesKey = (jobId) => `${jobId}:pages`;
export const hostKey = (jobId, host) => `${jobId}:host:${host}`;
