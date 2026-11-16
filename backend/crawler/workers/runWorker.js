// The loop every worker runs: lease a message, handle it, repeat.
// `concurrency` loops run side by side in one process. While one loop waits on
// the network (or a politeness sleep), the others keep working; that is why
// Node can do several fetches at once on a single thread.

import CrawlJob from "../../server/models/CrawlJob.js";
import { DEFERRED } from "./common.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object}   opts
 * @param {object}   opts.queue        a Queue (lease/nack)
 * @param {Function} opts.handle       async (msg) => void; acks/nacks itself
 * @param {number}   opts.concurrency  parallel loops in this process
 * @param {number}   opts.pollMs       wait when the queue is empty
 * @returns {{ stop: () => Promise<void> }}
 */
export function startWorker({ queue, handle, concurrency = 2, pollMs = 500, workerId = `worker-${process.pid}`, log = () => {} }) {
  let stopping = false;
  let pausedJobIds = [];

  // Leasing skips messages of paused/cancelled jobs. Refreshing this list once
  // a second is cheaper than asking MongoDB about the job on every lease;
  // handlers still re-check the job status, so a stale list is never unsafe.
  const refreshPaused = async () => {
    try {
      pausedJobIds = (await CrawlJob.find({ status: { $in: ["paused", "cancelled"] } }, { _id: 1 }).lean()).map((j) => j._id);
    } catch (err) {
      log(`[worker] could not refresh paused jobs: ${err.message}`);
    }
  };
  const timer = setInterval(refreshPaused, 1000);
  const ready = refreshPaused();

  async function loop(slot) {
    await ready;
    while (!stopping) {
      let msg = null;
      try {
        msg = await queue.lease(`${workerId}#${slot}`, { excludeJobIds: pausedJobIds });
        if (!msg) {
          await sleep(pollMs);
          continue;
        }
        // A message put back for later (politeness): pause before the next
        // lease, otherwise this loop would keep picking up and putting back
        // messages for the same busy site.
        if ((await handle(msg)) === DEFERRED) await sleep(pollMs);
      } catch (err) {
        // A bug or a database hiccup. Never let one message kill the loop:
        // count it as a failed attempt so it is retried, then carry on.
        log(`[worker] error: ${err.stack ?? err.message}`);
        if (msg) await queue.nack(msg, `Unexpected error: ${err.message}`).catch(() => {});
        else await sleep(pollMs); // e.g. MongoDB unreachable: do not spin
      }
    }
  }

  const loops = Array.from({ length: concurrency }, (_, i) => loop(i));
  return {
    // Graceful stop: no new leases; messages being handled are finished.
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.all(loops);
    },
  };
}
