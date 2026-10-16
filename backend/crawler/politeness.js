// Per-host politeness: never start two requests to the same host less than
// `delayMs` apart. Different hosts do not wait for each other.
//
// Example with minDelayMs = 1000:
//   t=0     waitTurn("a.com")  -> starts now,      next slot for a.com: t=1000
//   t=10    waitTurn("b.com")  -> starts now       (different host)
//   t=20    waitTurn("a.com")  -> sleeps 980 ms,   next slot for a.com: t=2000

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object}   opts
 * @param {number}   opts.minDelayMs  floor between request STARTS to one host
 * @param {Function} opts.now         clock (injectable so tests can fake time)
 * @param {Function} opts.sleep       async sleep (injectable for the same reason)
 */
export function createPoliteness({ minDelayMs = 1000, now = Date.now, sleep = defaultSleep } = {}) {
  // host -> time (ms) at which the previous request to that host started.
  const lastStartAt = new Map();

  /**
   * Resolve when it is polite to start a request to `host`.
   * `crawlDelayMs` comes from robots.txt; we use the LARGER of it and our floor,
   * so a site can ask us to slow down but never to go faster than our rule.
   */
  async function waitTurn(host, crawlDelayMs = 0) {
    const gap = Math.max(minDelayMs, crawlDelayMs);
    const previous = lastStartAt.get(host);
    const startAt = previous === undefined ? now() : Math.max(now(), previous + gap);

    // Reserve the slot BEFORE sleeping. If two callers ask for the same host
    // at once, the second one sees this reservation and queues behind it,
    // instead of both reading the old value and firing together.
    lastStartAt.set(host, startAt);

    // Loop, because timers may fire a millisecond early; the rule is ">= gap".
    while (now() < startAt) await sleep(startAt - now());
  }

  return { waitTurn, minDelayMs };
}
