import { test } from "node:test";
import assert from "node:assert/strict";
import { trends } from "../../server/lib/trends.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);
/** n searches of one query, `hours` ago. */
const searches = (query, n, hours, over = {}) =>
  Array.from({ length: n }, () => ({ query, key: query.toLowerCase(), page: 1, total: 5, createdAt: hoursAgo(hours), clicks: [], ...over }));

test("popular: last 7 days, at least 2 searches, most first", () => {
  const { popular } = trends([
    ...searches("gothic cathedral", 3, 50),
    ...searches("python", 2, 5),
    ...searches("my phone 0123456", 1, 3), // one-off: never public
    ...searches("old query", 5, 24 * 9), // older than 7 days
  ], { now: NOW });
  assert.deepEqual(popular, [{ query: "gothic cathedral", count: 3 }, { query: "python", count: 2 }]);
});

test("searches that found nothing are never shown (typos, private text)", () => {
  const { popular, trending } = trends(searches("asdfgh", 4, 2, { total: 0 }), { now: NOW });
  assert.deepEqual(popular, []);
  assert.deepEqual(trending, []);
});

test("later pages of the same search are not extra searches", () => {
  const { popular } = trends([...searches("python", 1, 2), ...searches("python", 3, 2, { page: 2 })], { now: NOW });
  assert.deepEqual(popular, [], "1 real search + 3 page-2 views is still 1 search");
});

test("trending: the worked example from the comment (6 today, 2 the week before)", () => {
  const { trending } = trends([...searches("virat kohli", 6, 2), ...searches("virat kohli", 2, 72)], { now: NOW });
  assert.equal(trending.length, 1);
  assert.equal(trending[0].today, 6);
  assert.equal(trending[0].isNew, false);
  assert.ok(Math.abs(trending[0].growth - 7 / (2 / 7 + 1)) < 1e-9, `growth ${trending[0].growth}`);
});

test("trending: a steady query is not trending; a new one is, ranked by growth", () => {
  const steady = []; // 2 a day, every day: today is just normal
  for (let d = 0; d < 8; d++) steady.push(...searches("weather", 2, d * 24 + 1));
  const { trending } = trends([...steady, ...searches("new phone launch", 4, 1), ...searches("eclipse", 2, 3)], { now: NOW });
  assert.deepEqual(trending.map((t) => t.query), ["new phone launch", "eclipse"]);
  assert.equal(trending[0].isNew, true);
  assert.equal(trending[0].growth, 5, "(4+1)/(0+1)");
});

test("trending needs at least 2 searches today", () => {
  assert.deepEqual(trends(searches("rare thing", 1, 1), { now: NOW }).trending, []);
});

test("reads: one reader opening a link twice counts once; most read first", () => {
  const view = (urls, hours = 2) => ({ query: "q", key: "q", page: 1, total: 3, createdAt: hoursAgo(hours), clicks: urls.map((url) => ({ url })) });
  const { reads } = trends([view(["https://a.test/x", "https://a.test/x"]), view(["https://a.test/y"]), view(["https://a.test/y"]), view(["https://a.test/z"], 24 * 9)], { now: NOW });
  assert.deepEqual(reads, [{ url: "https://a.test/y", readers: 2 }, { url: "https://a.test/x", readers: 1 }]);
});
