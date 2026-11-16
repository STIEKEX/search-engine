import { test } from "node:test";
import assert from "node:assert/strict";
import { dcgAtK, mean, ndcgAtK, precisionAtK } from "../../eval/metrics.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const labels = new Map([
  ["a", 2],
  ["b", 1],
  ["c", 0],
  ["d", 2],
]);

test("precision@k counts label >= 1 in the top k, missing results count as misses", () => {
  close(precisionAtK(["a", "b", "c", "d"], labels, 4), 3 / 4);
  close(precisionAtK(["a"], labels, 10), 1 / 10);
  close(precisionAtK(["x", "y"], labels, 2), 0, "unlabeled = not relevant");
});

test("DCG by hand: gains 3, 1, 0 at ranks 1, 2, 3", () => {
  // 3/log2(2) + 1/log2(3) + 0/log2(4) = 3 + 0.6309...
  close(dcgAtK([2, 1, 0]), 3 + 1 / Math.log2(3));
});

test("nDCG is 1 for the ideal order and lower when good pages sink", () => {
  close(ndcgAtK(["a", "d", "b", "c"], labels), 1);
  const worse = ndcgAtK(["c", "b", "a", "d"], labels);
  assert.ok(worse < 1 && worse > 0, `${worse}`);
  assert.ok(ndcgAtK(["b", "a"], labels) < ndcgAtK(["a", "b"], labels), "order matters, not just membership");
});

test("nDCG is 0 when the query has no relevant page", () => {
  close(ndcgAtK(["a"], new Map([["a", 0]])), 0);
});

test("mean", () => {
  close(mean([0.5, 1]), 0.75);
  close(mean([]), 0);
});

test("a repeated URL counts once: two copies of a relevant page are not two relevant results", () => {
  const labels = new Map([["a", 2], ["b", 0]]);
  // Before the fix: P@2 was 1.0 and nDCG was above 1 (1.63) for ["a", "a"].
  close(precisionAtK(["a", "a"], labels, 2), 0.5);
  close(ndcgAtK(["a", "a"], labels), 1, "never above the ideal ranking");
  close(ndcgAtK(["a", "a", "b"], labels), ndcgAtK(["a", "b", "b"], labels));
});
