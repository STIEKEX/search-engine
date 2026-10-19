import mongoose from "mongoose";

// A message in one of the work queues ("fetch" or "parse"), stored in MongoDB.
// Messages hold only IDs, never HTML or text: the queue says WHAT to do next,
// the urls collection and blob store hold the data.
//
//   ready  --lease-->  leased  --ack-->  (deleted)
//                         |--nack (retries left)-->  ready, availableAt = now + backoff
//                         |--nack (no retries left)-->  dead
//                         |--lease expires (worker crashed)-->  leasable again
export const MESSAGE_STATUSES = ["ready", "leased", "dead"];

const queueMessageSchema = new mongoose.Schema(
  {
    queue: { type: String, required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true },
    urlId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: MESSAGE_STATUSES, default: "ready" },
    availableAt: { type: Date, required: true }, // not leasable before this (backoff)
    attempts: { type: Number, default: 0 }, // deliveries so far
    leaseToken: { type: String, default: null }, // proves who holds the lease
    leasedBy: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    enqueuedAt: { type: Date, default: Date.now },
    deadAt: { type: Date, default: null },
  },
  { versionKey: false },
);

// At most one message per URL per queue: enqueueing twice is harmless.
queueMessageSchema.index({ queue: 1, urlId: 1 }, { unique: true });
// The two shapes of the lease query (ready + due, or leased + expired).
queueMessageSchema.index({ queue: 1, status: 1, availableAt: 1 });
queueMessageSchema.index({ queue: 1, status: 1, leaseExpiresAt: 1 });
queueMessageSchema.index({ jobId: 1, status: 1 });

export default mongoose.model("QueueMessage", queueMessageSchema);
