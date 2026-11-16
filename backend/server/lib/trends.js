// The public "Trending" page: what OTHER people search for and read.
// A pure function over search logs (models/SearchLog.js), tested by hand
// examples in tests/lib/trends.test.js.
//
//   popular    most searched queries of the last 7 days
//   trending   queries rising NOW: last 24 hours vs the 7 days before
//   reads      most opened results of the last 7 days
//
// Privacy: these lists show text that other people typed, so a query is only
// shown once it was searched at least MIN_PUBLIC_COUNT times AND found
// results. A one-off search (someone's own name, a phone number, a typo) never
// appears. (Site-health numbers such as CTR stay out of this page: see
// analytics.js.)

export const TOP_N = 10;
export const MIN_PUBLIC_COUNT = 2;
export const BASELINE_DAYS = 7; // "trending" compares the last day with these days before it
const DAY_MS = 86_400_000;

/**
 * @param {Array<{ key: string, query: string, page: number, total: number, createdAt: Date,
 *                 clicks: Array<{ url: string }> }>} logs  the last BASELINE_DAYS + 1 days
 * @param {{ now?: Date }} [options]
 * @returns {{ popular: Array<{ query: string, count: number }>,
 *             trending: Array<{ query: string, today: number, perDayBefore: number, growth: number, isNew: boolean }>,
 *             reads: Array<{ url: string, readers: number }> }}
 */
export function trends(logs, { now = new Date() } = {}) {
  const t = now.getTime();
  const lastWeek = (l) => t - new Date(l.createdAt).getTime() < BASELINE_DAYS * DAY_MS;
  // A "search" is a first results page that found something (privacy rule above).
  const searches = logs.filter((l) => l.page === 1 && l.total > 0);
  return {
    popular: popular(searches.filter(lastWeek)),
    trending: trending(searches, t),
    reads: reads(logs.filter(lastWeek)),
  };
}

/** key -> { query (latest spelling), count } for a list of searches. */
function countByQuery(searches) {
  const groups = new Map();
  for (const l of searches) {
    const g = groups.get(l.key) ?? { query: l.query, count: 0, lastAt: 0 };
    g.count++;
    const at = new Date(l.createdAt).getTime();
    if (at >= g.lastAt) {
      g.lastAt = at;
      g.query = l.query;
    }
    groups.set(l.key, g);
  }
  return groups;
}

function popular(searches) {
  return [...countByQuery(searches).entries()]
    .filter(([, g]) => g.count >= MIN_PUBLIC_COUNT)
    .sort(([ka, a], [kb, b]) => b.count - a.count || ka.localeCompare(kb))
    .slice(0, TOP_N)
    .map(([, g]) => ({ query: g.query, count: g.count }));
}

/**
 * Rising queries: searched >= MIN_PUBLIC_COUNT times in the last 24 hours
 * and more than their daily average over the BASELINE_DAYS before.
 *
 *   growth = (today + 1) / (perDayBefore + 1)
 *
 * The +1 on both sides ("smoothing") keeps small numbers sane: without it a
 * query searched 2 times today and never before would be "infinitely"
 * trending, and one searched once before would jump 2x from a single search.
 * Example: 6 today, 2 in the week before (0.29/day) -> (6+1)/(0.29+1) = 5.4x.
 */
function trending(searches, now) {
  const today = searches.filter((l) => now - new Date(l.createdAt).getTime() < DAY_MS);
  const before = searches.filter((l) => {
    const age = now - new Date(l.createdAt).getTime();
    return age >= DAY_MS && age < (BASELINE_DAYS + 1) * DAY_MS;
  });
  const beforeCounts = countByQuery(before);
  return [...countByQuery(today).entries()]
    .map(([key, g]) => {
      const perDayBefore = (beforeCounts.get(key)?.count ?? 0) / BASELINE_DAYS;
      return { key, query: g.query, today: g.count, perDayBefore, growth: (g.count + 1) / (perDayBefore + 1), isNew: perDayBefore === 0 };
    })
    .filter((r) => r.today >= MIN_PUBLIC_COUNT && r.growth > 1)
    .sort((a, b) => b.growth - a.growth || b.today - a.today || a.key.localeCompare(b.key))
    .slice(0, TOP_N)
    .map(({ key, ...rest }) => rest);
}

/**
 * Most opened results: how many result pages (views) had a click on each URL.
 * One reader opening the same link three times counts once.
 * The caller must keep only URLs that are in the index: click URLs come from
 * the browser, so anyone could send a made-up one.
 */
function reads(logs) {
  const counts = new Map();
  for (const l of logs) for (const url of new Set(l.clicks.map((c) => c.url))) counts.set(url, (counts.get(url) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([ua, a], [ub, b]) => b - a || ua.localeCompare(ub))
    .map(([url, readers]) => ({ url, readers }));
}
