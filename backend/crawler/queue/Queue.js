// The contract every work queue must follow. Workers only use these methods,
// so MongoQueue (Stage 2) can be swapped for a Redis/BullMQ or SQS queue
// (Stage 3) without changing the workers.
//
// Delivery guarantee: AT LEAST ONCE. A message is never lost, but it can be
// delivered more than once (a worker crashes after doing the work but before
// ack). So every handler must be idempotent: running it twice must give the
// same result as running it once.

export class Queue {
  /** Add one message ({ jobId, urlId }). Adding the same urlId twice is a no-op. */
  async enqueue(message, opts) {
    throw new Error(`${this.constructor.name}.enqueue is not implemented`);
  }

  /** Add many messages at once (same no-op rule). @returns {Promise<number>} newly added */
  async enqueueMany(messages) {
    throw new Error(`${this.constructor.name}.enqueueMany is not implemented`);
  }

  /**
   * Take the next due message and hide it from other workers until the lease
   * expires (visibility timeout). Returns null when nothing is due.
   */
  async lease(workerId, opts) {
    throw new Error(`${this.constructor.name}.lease is not implemented`);
  }

  /** The work is fully done: remove the message. @returns {Promise<boolean>} */
  async ack(message) {
    throw new Error(`${this.constructor.name}.ack is not implemented`);
  }

  /** The work failed: retry later with backoff, or dead-letter when out of retries. */
  async nack(message, error) {
    throw new Error(`${this.constructor.name}.nack is not implemented`);
  }

  /** Give the message back without counting an attempt (e.g. the job is paused). */
  async release(message, delayMs) {
    throw new Error(`${this.constructor.name}.release is not implemented`);
  }

  /** Park the message for a human: it is kept, but never delivered again. */
  async deadLetter(message, error) {
    throw new Error(`${this.constructor.name}.deadLetter is not implemented`);
  }

  /** Counts per status and the age of the oldest waiting message. */
  async stats(filter) {
    throw new Error(`${this.constructor.name}.stats is not implemented`);
  }
}

/**
 * Exponential backoff with "equal jitter".
 *   attempt 1 -> 1-2 s, attempt 2 -> 2-4 s, attempt 3 -> 4-8 s ... capped at maxMs.
 *
 * Why exponential? A failing server needs time to recover; retrying at a
 * fixed short interval just adds load while it is down.
 * Why jitter? If 200 URLs fail in the same second (site briefly down), plain
 * exponential backoff retries all 200 in the same second again: a
 * "thundering herd". The random half spreads them out.
 */
export function backoffDelay(attempt, { baseMs = 2000, maxMs = 60_000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
