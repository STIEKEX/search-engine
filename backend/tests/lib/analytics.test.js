import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { percentile, ratio, summarize } from "../../server/lib/analytics.js";

const NOW = new Date("2026-11-16T12:00:00Z");
let n = 0;
/** One log (a results page shown), with sensible defaults. */
const log = (over = {}) => ({
  query: "gothic cathedral", key: "gothic cathedral", page: 1, limit: 10, total: 12, shown: 10,
  tookMs: 100, createdAt: new Date("2026-11-16T10:00:00Z"), clicks: [], _n: n++, ...over,
});
const click = (position, url = `https://w.test/${position}`) => ({ position, url, at: NOW });

describe("percentile (nearest rank)", () => {
  test("the worked example from the comment", () => {
    assert.equal(percentile([40, 10, 30, 20], 50), 20);
    assert.equal(percentile([40, 10, 30, 20], 95), 40);
  });
  test("one value, and no values", () => {
    assert.equal(percentile([7], 95), 7);
    assert.equal(percentile([], 50), null);
  });
});

test("ratio is null, not 0, when there is nothing to divide by", () => {
  assert.equal(ratio(1, 4), 0.25);
  assert.equal(ratio(0, 0), null);
});

describe("summarize", () => {
  // 4 views: three searches (page 1) and one page-2 view.
  //   A "gothic cathedral"  12 results, clicked at 1 and 3      100 ms
  //   B "Gothic  Cathedral" (same key) 12 results, no click     200 ms
  //   C "virat kohli"        0 results                          300 ms
  //   D "gothic cathedral" page 2: shows 11-12, clicked at 11   400 ms
  const logs = [
    log({ clicks: [click(1), click(3)], tookMs: 100 }),
    log({ query: "Gothic  Cathedral", tookMs: 200, createdAt: new Date("2026-11-16T11:00:00Z") }),
    log({ query: "virat kohli", key: "virat kohli", total: 0, shown: 0, tookMs: 300, createdAt: new Date("2026-11-15T09:00:00Z") }),
    log({ page: 2, shown: 2, clicks: [click(11)], tookMs: 400 }),
  ];
  const s = summarize(logs, { days: 3, now: NOW });

  test("totals: searches count page 1 only; CTR is over all views", () => {
    assert.equal(s.totals.searches, 3);
    assert.equal(s.totals.views, 4);
    assert.equal(s.totals.clicks, 3);
    assert.equal(s.totals.ctr, 2 / 4, "A and D got a click");
    assert.equal(s.totals.zeroResultRate, 1 / 3);
    assert.equal(s.totals.p50Ms, 200);
    assert.equal(s.totals.p95Ms, 400);
  });

  test("top queries group equal queries and show the latest spelling", () => {
    assert.deepEqual(s.topQueries.map((q) => [q.query, q.count, q.ctr]), [
      ["Gothic  Cathedral", 2, 0.5], // A (clicked) + B (not); B is later
      ["virat kohli", 1, 0],
    ]);
    assert.equal(s.topQueries[0].avgResults, 12);
  });

  test("zero-result queries: only searches that found nothing", () => {
    assert.deepEqual(s.zeroResultQueries.map((q) => [q.query, q.count]), [["virat kohli", 1]]);
  });

  test("CTR by position: impressions are the views that SHOWED the position", () => {
    const at = (p) => s.ctrByPosition[p - 1];
    // Positions 1..10 were shown by A and B (C showed nothing, D shows 11-12).
    assert.deepEqual([at(1).impressions, at(1).clicks, at(1).ctr], [2, 1, 0.5]);
    assert.deepEqual([at(2).impressions, at(2).clicks, at(2).ctr], [2, 0, 0]);
    assert.deepEqual([at(3).impressions, at(3).clicks], [2, 1]);
    assert.equal(s.ctrByPosition.length, 10, "position 11 (page 2) is not in the 1..10 table");
  });

  test("a position clicked twice in one view counts once", () => {
    const r = summarize([log({ clicks: [click(1), click(1)] })], { days: 1, now: NOW });
    assert.equal(r.ctrByPosition[0].clicks, 1);
    assert.equal(r.totals.clicks, 2, "but the click total counts both");
  });

  test("searches per day, oldest first, days without searches included", () => {
    assert.deepEqual(s.perDay, [
      { day: "2026-11-14", searches: 0 },
      { day: "2026-11-15", searches: 1 },
      { day: "2026-11-16", searches: 2 },
    ]);
  });

  test("most clicked URLs", () => {
    assert.deepEqual(s.topClicked.map((c) => c.clicks), [1, 1, 1]);
  });

  test("no logs at all: zeros and nulls, no NaN", () => {
    const empty = summarize([], { days: 2, now: NOW });
    assert.deepEqual(empty.totals, { searches: 0, views: 0, clicks: 0, ctr: null, zeroResultRate: null, p50Ms: null, p95Ms: null });
    assert.equal(empty.ctrByPosition[0].ctr, null);
    assert.equal(empty.perDay.length, 2);
  });
});
