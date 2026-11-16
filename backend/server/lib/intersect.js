// Postings intersection: the core of Boolean AND search.
//
// Every postings list from the index is sorted by docId (the indexer
// guarantees it). Two sorted lists can be intersected in ONE pass with two
// pointers, exactly like the merge step of merge sort:
//
//   a: [1, 3, 5, 8]          b: [3, 4, 8, 9]
//   1 < 3  -> advance a
//   3 = 3  -> keep 3, advance both
//   5 > 4  -> advance b
//   5 < 8  -> advance a
//   8 = 8  -> keep 8, advance both      result: [3, 8]
//
// Cost: O(m + n) steps for lists of length m and n.
//
// But when one list is MUCH shorter (a rare word AND a common word), walking
// the long list step by step is wasteful: [10, 1990] AND (1000 docIds) still
// takes ~1000 steps. Galloping fixes that: for each docId of the short list,
// jump through the long one in steps of 1, 2, 4, 8... until we pass it, then
// binary-search the last jump. Cost: about m * log(n / m), here ~40 steps.

// Gallop when the long list is at least this many times longer. Below it,
// the plain merge is as fast and simpler.
export const GALLOP_RATIO = 8;

const count = (stats) => {
  if (stats) stats.comparisons++;
};

/**
 * Intersect two docId arrays, both sorted ascending, without duplicates.
 * @param {number[]} a
 * @param {number[]} b
 * @param {{ comparisons: number }} [stats]  optional counter, used by tests to
 *   show how much work an intersection costs
 * @returns {number[]} docIds present in both, ascending
 */
export function intersectTwo(a, b, stats) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length * GALLOP_RATIO < long.length) return intersectGalloping(short, long, stats);
  return intersectLinear(a, b, stats);
}

/** The two-pointer merge described at the top of the file. */
export function intersectLinear(a, b, stats) {
  const result = [];
  let i = 0;
  let j = 0;
  // Stop as soon as EITHER list runs out: nothing after that can match.
  while (i < a.length && j < b.length) {
    count(stats);
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++; // a[i] is too small to ever appear in b from here on
    } else {
      j++;
    }
  }
  return result;
}

/** For each docId of the short list, gallop forward in the long list. */
function intersectGalloping(short, long, stats) {
  const result = [];
  let from = 0; // never look back: both lists are sorted
  for (const docId of short) {
    from = gallop(long, from, docId, stats);
    if (from === long.length) break; // the rest of `long` is smaller than docId
    if (long[from] === docId) {
      result.push(docId);
      from++;
    }
  }
  return result;
}

/**
 * First index i >= start with list[i] >= target (list.length if there is none).
 *   1. Exponential phase: probe start, start+1, start+3, start+7... (gaps
 *      1, 2, 4, 8) until a value >= target, or the end of the list.
 *   2. Binary search between the last two probes.
 * Both phases take O(log d) steps, where d is how far the answer is.
 */
export function gallop(list, start, target, stats) {
  let lo = start; // everything before lo is known to be < target
  let hi = start; // next probe
  let step = 1;
  while (hi < list.length && list[hi] < target) {
    count(stats);
    lo = hi + 1;
    hi += step;
    step *= 2;
  }
  // The answer is in [lo, hi]: list[hi] >= target, or hi is past the end.
  let right = Math.min(hi, list.length);
  while (lo < right) {
    count(stats);
    const mid = (lo + right) >>> 1;
    if (list[mid] < target) lo = mid + 1;
    else right = mid;
  }
  return lo;
}

/**
 * Intersect any number of sorted docId arrays (AND of all query terms).
 *
 * Shortest list first. The running result can never be longer than the
 * shortest list, so every later step pairs a SHORT list with a long one,
 * which is exactly the case galloping makes cheap. And the moment the
 * running result is empty we stop: no document can contain all the terms.
 *
 * @param {number[][]} lists
 * @param {{ comparisons: number }} [stats]
 * @returns {number[]}
 */
export function intersectAll(lists, stats) {
  if (lists.length === 0) return [];
  const byLength = [...lists].sort((x, y) => x.length - y.length);
  let result = [...byLength[0]]; // a copy: callers may keep using their lists
  for (let k = 1; k < byLength.length && result.length > 0; k++) {
    result = intersectTwo(result, byLength[k], stats);
  }
  return result;
}
