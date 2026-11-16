import { test } from "node:test";
import assert from "node:assert/strict";
import { gallop, intersectAll, intersectLinear, intersectTwo } from "../../server/lib/intersect.js";

test("intersectTwo: the example from the comment", () => {
  assert.deepEqual(intersectTwo([1, 3, 5, 8], [3, 4, 8, 9]), [3, 8]);
});

test("intersectTwo: edge cases", () => {
  assert.deepEqual(intersectTwo([], [1, 2]), []);
  assert.deepEqual(intersectTwo([1, 2], []), []);
  assert.deepEqual(intersectTwo([1, 3, 5], [2, 4, 6]), [], "disjoint");
  assert.deepEqual(intersectTwo([1, 2, 3], [1, 2, 3]), [1, 2, 3], "identical");
  assert.deepEqual(intersectTwo([7], [1, 2, 7, 9]), [7], "one element");
  assert.deepEqual(intersectTwo([0, 1000000], [0, 5, 1000000]), [0, 1000000], "first and last");
});

test("the linear merge stops as soon as one list runs out", () => {
  const stats = { comparisons: 0 };
  intersectLinear([1, 2], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], stats);
  assert.equal(stats.comparisons, 2, "after matching 1 and 2, list a is finished: no point reading b");
});

test("gallop finds the first index whose value is >= target", () => {
  const list = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  assert.equal(gallop(list, 0, 1), 0, "before everything");
  assert.equal(gallop(list, 0, 2), 0, "exact first");
  assert.equal(gallop(list, 0, 9), 4, "between 8 and 10");
  assert.equal(gallop(list, 0, 20), 9, "exact last");
  assert.equal(gallop(list, 0, 21), 10, "after everything: list.length");
  assert.equal(gallop(list, 5, 3), 5, "never moves back before start");
});

test("galloping gives exactly the same answers as the linear merge (random lists)", () => {
  let seed = 42; // tiny deterministic random generator, so a failure can be replayed
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const sortedList = (n, max) => [...new Set(Array.from({ length: n }, () => Math.floor(random() * max)))].sort((x, y) => x - y);
  for (let round = 0; round < 200; round++) {
    const a = sortedList(1 + Math.floor(random() * 10), 500);
    const b = sortedList(1 + Math.floor(random() * 300), 500); // often >8x longer: galloping
    assert.deepEqual(intersectTwo(a, b), intersectLinear(a, b), `round ${round}`);
    assert.deepEqual(intersectTwo(b, a), intersectLinear(a, b), `round ${round} (swapped)`);
  }
});

test("intersectAll: the hand-worked index from the M3 walkthrough", () => {
  // cat -> docs 0,1,2   chase -> 0,1   mice -> 0,2
  const cat = [0, 1, 2];
  const chase = [0, 1];
  const mice = [0, 2];
  assert.deepEqual(intersectAll([cat, chase]), [0, 1]);
  assert.deepEqual(intersectAll([cat, mice]), [0, 2]);
  assert.deepEqual(intersectAll([cat, chase, mice]), [0]);
});

test("intersectAll: zero lists, one list, and an empty list", () => {
  assert.deepEqual(intersectAll([]), []);
  assert.deepEqual(intersectAll([[2, 4]]), [2, 4]);
  assert.deepEqual(intersectAll([[1, 2], [], [1, 2]]), []);
});

test("intersectAll does not change the caller's arrays", () => {
  const a = [1, 2, 3];
  const b = [2, 3];
  intersectAll([a, b]);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [2, 3]);
});

test("the answer does not depend on the order of the lists", () => {
  const lists = [[1, 4, 6, 9, 12], [4, 9, 12, 20], [2, 4, 12]];
  const expected = [4, 12];
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    assert.deepEqual(intersectAll(order.map((i) => lists[i])), expected);
  }
});

test("a plain merge walks the long list whatever the order (why galloping is needed)", () => {
  const common = Array.from({ length: 1000 }, (_, i) => i * 2);
  const rare = [10, 1990];
  const stats = { comparisons: 0 };
  intersectLinear(rare, common, stats);
  assert.ok(stats.comparisons > 900, `linear: ${stats.comparisons} steps for 2 rare docIds`);
  const galloping = { comparisons: 0 };
  intersectTwo(rare, common, galloping);
  assert.ok(galloping.comparisons < 50, `galloping: ${galloping.comparisons} steps`);
});

test("shortest list first does far less work than longest first", () => {
  // A common word (every even number up to 2000) AND a rare word (2 docs).
  const common = Array.from({ length: 1000 }, (_, i) => i * 2);
  const alsoCommon = Array.from({ length: 1000 }, (_, i) => i * 2 + (i % 2)); // overlaps half of `common`
  const rare = [10, 1990];

  const shortestFirst = { comparisons: 0 };
  intersectAll([common, alsoCommon, rare], shortestFirst); // sorts: rare goes first

  // Same intersections done longest-first, by hand.
  const longestFirst = { comparisons: 0 };
  const step = intersectTwo(common, alsoCommon, longestFirst);
  intersectTwo(step, rare, longestFirst);

  assert.ok(
    shortestFirst.comparisons * 10 < longestFirst.comparisons,
    `shortest first: ${shortestFirst.comparisons}, longest first: ${longestFirst.comparisons}`,
  );
});

test("an empty running result stops the loop early", () => {
  const stats = { comparisons: 0 };
  const huge = Array.from({ length: 5000 }, (_, i) => i + 100);
  // [1] AND [2] is empty, so the huge list is never walked.
  assert.deepEqual(intersectAll([[1], [2], huge], stats), []);
  assert.equal(stats.comparisons, 1);
});
