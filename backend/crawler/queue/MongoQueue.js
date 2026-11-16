// A work queue stored in a MongoDB collection (QueueMessage).
//
// The key idea is the LEASE (also called "visibility timeout", as in AWS SQS):
//   lease()  atomically picks one due message and marks it
//            { status: "leased", leaseExpiresAt: now + 2 min, leaseToken: <random> }.
//   ack()    deletes it, but only if we still hold that leaseToken.
// If the worker crashes, nobody acks. When leaseExpiresAt passes, lease()
// treats the message as available again and another worker picks it up.
// That is the whole crash-recovery mechanism: no heartbeats, no coordinator.

import { randomUUID } from "node:crypto";
import QueueMessage from "../../server/models/QueueMessage.js";
import { backoffDelay, Queue } from "./Queue.js";

export class MongoQueue extends Queue {
  /**
   * @param {object} opts
   * @param {string} opts.name                "fetch" or "parse"
   * @param {number} opts.visibilityTimeoutMs how long a lease hides a message
   * @param {number} opts.maxAttempts         deliveries before dead-lettering (1 + retries)
   * @param {object} opts.backoff             { baseMs, maxMs } for backoffDelay()
   */
  constructor({ name, visibilityTimeoutMs = 120_000, maxAttempts = 4, backoff = {}, model = QueueMessage, now = () => new Date(), random = Math.random }) {
    super();
    Object.assign(this, { name, visibilityTimeoutMs, maxAttempts, backoff, model, now, random });
  }

  async enqueue({ jobId, urlId }, { delayMs = 0 } = {}) {
    return (await this.enqueueMany([{ jobId, urlId }], { delayMs })) === 1;
  }

  /** Upsert keyed on (queue, urlId): a message that already exists is left untouched. */
  async enqueueMany(messages, { delayMs = 0 } = {}) {
    if (messages.length === 0) return 0;
    const availableAt = new Date(this.now().getTime() + delayMs);
    const ops = messages.map(({ jobId, urlId }) => ({
      updateOne: {
        filter: { queue: this.name, urlId },
        update: { $setOnInsert: { queue: this.name, jobId, urlId, status: "ready", availableAt, attempts: 0, priority: 0, enqueuedAt: this.now() } },
        upsert: true,
      },
    }));
    const result = await this.model.bulkWrite(ops, { ordered: false });
    return result.upsertedCount;
  }

  async lease(workerId, { excludeJobIds = [] } = {}) {
    for (;;) {
      const msg = await this.#leaseOne(workerId, excludeJobIds);
      if (!msg) return null;
      if (msg.attempts <= this.maxAttempts) return msg;
      // Delivered again and again without ack OR nack: the worker most likely
      // crashes on this message every time (a "poison message"). Park it so
      // it cannot take the workers down forever.
      await this.deadLetter(msg, msg.lastError ?? "Lease expired too many times (worker crashed?)");
    }
  }

  async #leaseOne(workerId, excludeJobIds) {
    const now = this.now();
    return this.model.findOneAndUpdate(
      {
        queue: this.name,
        ...(excludeJobIds.length > 0 && { jobId: { $nin: excludeJobIds } }),
        $or: [
          { status: "ready", availableAt: { $lte: now } },
          { status: "leased", leaseExpiresAt: { $lte: now } }, // owner crashed or is too slow
        ],
      },
      {
        $set: {
          status: "leased",
          leaseToken: randomUUID(), // a new token, so the previous holder's ack fails
          leasedBy: workerId,
          leaseExpiresAt: new Date(now.getTime() + this.visibilityTimeoutMs),
        },
        $inc: { attempts: 1 },
      },
      // Most important first; among equals, oldest first (so priority 0 everywhere = plain FIFO/BFS).
      { sort: { priority: -1, availableAt: 1 }, returnDocument: "after", lean: true },
    );
  }

  /**
   * Raise the priority of waiting messages (used for "most linked-to first").
   * Only "ready" ones: a message already being worked on gains nothing.
   */
  async bumpPriority(urlIds, by = 1) {
    if (urlIds.length === 0) return 0;
    const result = await this.model.updateMany({ queue: this.name, urlId: { $in: urlIds }, status: "ready" }, { $inc: { priority: by } });
    return result.modifiedCount;
  }

  async ack(msg) {
    const result = await this.model.deleteOne({ _id: msg._id, leaseToken: msg.leaseToken });
    // 0 deleted = our lease expired and someone else owns the message now.
    return result.deletedCount === 1;
  }

  /** @returns {Promise<{ dead: boolean, delayMs?: number }>} */
  async nack(msg, error) {
    if (msg.attempts >= this.maxAttempts) {
      await this.deadLetter(msg, error);
      return { dead: true };
    }
    const delayMs = backoffDelay(msg.attempts, { ...this.backoff, random: this.random });
    await this.#returnToReady(msg, { availableAt: new Date(this.now().getTime() + delayMs), lastError: error });
    return { dead: false, delayMs };
  }

  async release(msg, delayMs = 0) {
    // $inc -1 undoes the attempt that lease() counted: a pause is not a failure.
    await this.#returnToReady(msg, { availableAt: new Date(this.now().getTime() + delayMs) }, { attempts: -1 });
  }

  async deadLetter(msg, error) {
    await this.model.updateOne(
      { _id: msg._id, leaseToken: msg.leaseToken },
      { $set: { status: "dead", lastError: error, deadAt: this.now() }, $unset: { leaseToken: 1, leasedBy: 1, leaseExpiresAt: 1 } },
    );
  }

  #returnToReady(msg, fields, inc = {}) {
    return this.model.updateOne(
      { _id: msg._id, leaseToken: msg.leaseToken },
      { $set: { status: "ready", ...fields }, $unset: { leaseToken: 1, leasedBy: 1, leaseExpiresAt: 1 }, ...(Object.keys(inc).length && { $inc: inc }) },
    );
  }

  /** { ready, leased, dead, oldestReadyAgeMs } for this queue, optionally one job. */
  async stats({ jobId } = {}) {
    const match = { queue: this.name, ...(jobId && { jobId }) };
    const groups = await this.model.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 }, oldest: { $min: "$enqueuedAt" } } }]);
    const by = Object.fromEntries(groups.map((g) => [g._id, g]));
    const oldest = by.ready?.oldest;
    return {
      ready: by.ready?.n ?? 0,
      leased: by.leased?.n ?? 0,
      dead: by.dead?.n ?? 0,
      oldestReadyAgeMs: oldest ? this.now().getTime() - oldest.getTime() : 0,
    };
  }

  /**
   * Is any message of this job still to be worked on (ready or in flight)?
   * Dead ones do not count. exists() stops at the first match; a count would
   * read every waiting message (14,000 in the Wikipedia crawl) on every ack.
   */
  async hasPending(jobId) {
    return (await this.model.exists({ queue: this.name, jobId, status: { $in: ["ready", "leased"] } })) !== null;
  }

  listDead(jobId) {
    return this.model.find({ queue: this.name, jobId, status: "dead" }).sort({ deadAt: 1 }).lean();
  }

  /** Put dead messages back in line with a fresh retry budget. */
  async retryDead(jobId) {
    const result = await this.model.updateMany(
      { queue: this.name, jobId, status: "dead" },
      { $set: { status: "ready", availableAt: this.now(), attempts: 0, deadAt: null } },
    );
    return result.modifiedCount;
  }

  /**
   * Drop work that has not started yet: all of a job's ready messages (job
   * cancelled), or only those for the given URLs (page budget used up).
   */
  async deleteReady(jobId, { urlIds } = {}) {
    const result = await this.model.deleteMany({ queue: this.name, jobId, status: "ready", ...(urlIds && { urlId: { $in: urlIds } }) });
    return result.deletedCount;
  }
}
