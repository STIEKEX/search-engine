// Site-health analytics for the people running the engine (not for
// visitors): turn search logs (models/SearchLog.js) into CTR, zero-result
// rate, CTR by position and latency. NOT served by any route yet: the public
// Trending page uses trends.js instead. Kept for a future admin page, which
// must sit behind a login. A pure function over an array, so every metric can
// be checked against a small example worked out by hand (tests/lib/analytics.test.js).
//
// Definitions (a "view" = one results page shown = one log):
//   searches        views of page 1: what people actually searched for
//   CTR             views with at least one click / all views
//   zero-result     page-1 views that found nothing: what the crawler misses
//   CTR @ position  views where position p was clicked / views that SHOWED p
//                   (position 1 is clicked most partly because it is on top:
//                   "position bias"; a steep drop after 1 means good ranking)
//   latency         p50 / p95 of the server's search time
//
// Why in JavaScript and not a MongoDB aggregation pipeline: 30 days of logs
// for a demo project are a few thousand small documents, and plain code is
// easier to test and explain. At millions of searches a day you would
// pre-aggregate counters per day instead of reading raw logs.

export const TOP_N = 10;
export const MAX_POSITION = 10; // CTR by position for positions 1..10

/**
 * @param {Array<{ query: string, key: string, page: number, limit: number, total: number,
 *                 shown: number, tookMs: number, createdAt: Date,
 *                 clicks: Array<{ position: number, url: string }> }>} logs
 * @param {{ days: number, now?: Date }} options  the window the logs cover
 */
export function summarize(logs, { days, now = new Date() }) {
  const searches = logs.filter((l) => l.page === 1);
  const clicked = logs.filter((l) => l.clicks.length > 0);
  const zero = searches.filter((l) => l.total === 0);
  return {
    days,
    totals: {
      searches: searches.length,
      views: logs.length,
      clicks: logs.reduce((n, l) => n + l.clicks.length, 0),
      ctr: ratio(clicked.length, logs.length),
      zeroResultRate: ratio(zero.length, searches.length),
      p50Ms: percentile(logs.map((l) => l.tookMs), 50),
      p95Ms: percentile(logs.map((l) => l.tookMs), 95),
    },
    perDay: perDay(searches, days, now),
    topQueries: topQueries(searches),
    zeroResultQueries: topQueries(zero),
    ctrByPosition: ctrByPosition(logs),
    topClicked: topClicked(logs),
  };
}

/** a / b, or null when b is 0 (a rate of "nothing" is unknown, not 0%). */
export function ratio(a, b) {
  return b === 0 ? null : a / b;
}

/**
 * Nearest-rank percentile: the smallest value with at least p% of the
 * values at or below it. [10, 20, 30, 40] -> p50 = 20, p95 = 40.
 * @returns {number|null} null for no values
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Searches per UTC day, oldest first, including days with 0. */
function perDay(searches, days, now) {
  const counts = new Map();
  for (const l of searches) {
    const day = isoDay(l.createdAt);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = isoDay(new Date(now.getTime() - i * 86_400_000));
    out.push({ day, searches: counts.get(day) ?? 0 });
  }
  return out;
}

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);

/**
 * Group equal queries (same folded key). Most frequent first; ties broken by
 * the key, so the order is stable. The query shown is the most recent spelling.
 */
function topQueries(logs) {
  const groups = new Map();
  for (const l of logs) {
    const g = groups.get(l.key) ?? { query: l.query, count: 0, clicked: 0, results: 0, lastAt: l.createdAt };
    g.count++;
    if (l.clicks.length > 0) g.clicked++;
    g.results += l.total;
    if (l.createdAt >= g.lastAt) {
      g.lastAt = l.createdAt;
      g.query = l.query;
    }
    groups.set(l.key, g);
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
    .slice(0, TOP_N)
    .map(([, g]) => ({ query: g.query, count: g.count, ctr: g.clicked / g.count, avgResults: g.results / g.count, lastAt: g.lastAt }));
}

/**
 * For positions 1..MAX_POSITION: how often each was shown and clicked.
 * A view of page 2 (limit 10, 7 results) shows positions 11..17, so it
 * counts for none of 1..10. A position clicked twice in one view counts once:
 * CTR is "did people click it", not "how many times".
 */
function ctrByPosition(logs) {
  const rows = [];
  for (let position = 1; position <= MAX_POSITION; position++) {
    let impressions = 0;
    let clicks = 0;
    for (const l of logs) {
      const first = (l.page - 1) * l.limit + 1;
      if (position < first || position >= first + l.shown) continue;
      impressions++;
      if (l.clicks.some((c) => c.position === position)) clicks++;
    }
    rows.push({ position, impressions, clicks, ctr: ratio(clicks, impressions) });
  }
  return rows;
}

/** The most clicked result URLs. */
function topClicked(logs) {
  const counts = new Map();
  for (const l of logs) for (const c of l.clicks) counts.set(c.url, (counts.get(c.url) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([ua, a], [ub, b]) => b - a || ua.localeCompare(ub))
    .slice(0, TOP_N)
    .map(([url, clicks]) => ({ url, clicks }));
}
