import { test } from "node:test";
import assert from "node:assert/strict";
import { bm25Weight, idf, scoreCandidates, tfidfWeight } from "../../server/lib/bm25.js";

const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} vs ${expected}`);

// Hand-worked example (do it on paper first):
//   doc 0: "cat cat dog"          length 3
//   doc 1: "cat bird bird fish"   length 4
//   doc 2: "dog fish"             length 2
//   N = 3, avgLength = 3, k1 = 1.2, b = 0.75
//
//   idf(cat): df 2 -> ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln(1.6)  = 0.4700
//   idf(dog): df 2 -> ln(1.6) as well
//   BM25(cat, doc 0): tf 2, length 3 (= avg, so the length factor is 1)
//     = 0.4700 * (2 * 2.2) / (2 + 1.2 * 1)       = 0.4700 * 1.375 = 0.6463
//   BM25(cat, doc 1): tf 1, length 4 -> factor 1 - 0.75 + 0.75 * 4/3 = 1.25
//     = 0.4700 * 2.2 / (1 + 1.2 * 1.25)          = 0.4700 * 0.88  = 0.4136
const corpus = { N: 3, avgLength: 3 };

test("idf: the hand example, and rare words weigh more than common ones", () => {
  close(idf(3, 2), Math.log(1.6));
  assert.ok(idf(2000, 3) > idf(2000, 820));
  assert.ok(idf(2000, 2000) > 0, "this IDF variant never goes negative");
});

test("BM25: the hand example, cat in doc 0 and in doc 1", () => {
  close(bm25Weight({ tf: 2, df: 2, docLength: 3 }, corpus), Math.log(1.6) * (4.4 / 3.2));
  close(bm25Weight({ tf: 1, df: 2, docLength: 4 }, corpus), Math.log(1.6) * (2.2 / 2.5));
});

test("BM25 query score is the sum over the query words", () => {
  // Query "cat dog": doc 0 has both, doc 1 only cat, doc 2 only dog.
  const terms = [
    { df: 2, docIds: [0, 1], tfs: [2, 1] }, // cat
    { df: 2, docIds: [0, 2], tfs: [1, 1] }, // dog
  ];
  const lengths = [3, 4, 2];
  const scores = scoreCandidates([0, 1, 2], terms, (d) => lengths[d], corpus);
  const catDoc0 = bm25Weight({ tf: 2, df: 2, docLength: 3 }, corpus);
  const dogDoc0 = bm25Weight({ tf: 1, df: 2, docLength: 3 }, corpus);
  close(scores.get(0).bm25, catDoc0 + dogDoc0);
  assert.ok(scores.get(0).bm25 > scores.get(1).bm25 && scores.get(0).bm25 > scores.get(2).bm25, "both words beat one word");
});

test("only candidates are scored", () => {
  const terms = [{ df: 2, docIds: [0, 1], tfs: [1, 1] }];
  const scores = scoreCandidates([1], terms, () => 3, corpus);
  assert.deepEqual([...scores.keys()], [1]);
});

test("k1 caps the effect of repeating a word (saturation)", () => {
  const big = { N: 1000, avgLength: 100 };
  const w = (tf) => bm25Weight({ tf, df: 10, docLength: 100 }, big);
  assert.ok(w(2) - w(1) > w(20) - w(19), "the 2nd occurrence adds more than the 20th");
  assert.ok(w(1000) < idf(1000, 10) * 2.2, "never more than idf * (k1 + 1), however large tf gets");
  // TF-IDF has no cap: it keeps growing.
  assert.ok(tfidfWeight({ tf: 1000, df: 10 }, big) > tfidfWeight({ tf: 100, df: 10 }, big) * 1.4);
});

test("b penalizes long pages: same tf, longer page, lower score", () => {
  const big = { N: 1000, avgLength: 100 };
  assert.ok(bm25Weight({ tf: 3, df: 10, docLength: 50 }, big) > bm25Weight({ tf: 3, df: 10, docLength: 500 }, big));
  const noLength = { k1: 1.2, b: 0 };
  close(bm25Weight({ tf: 3, df: 10, docLength: 50 }, big, noLength), bm25Weight({ tf: 3, df: 10, docLength: 500 }, big, noLength));
});

test("k1 = 0 ignores tf: only 'contains the word or not' counts", () => {
  const binary = { k1: 0, b: 0.75 };
  close(bm25Weight({ tf: 1, df: 5, docLength: 10 }, corpus, binary), bm25Weight({ tf: 50, df: 5, docLength: 10 }, corpus, binary));
});

test("TF-IDF: a word on every page weighs zero", () => {
  close(tfidfWeight({ tf: 7, df: 3 }, { N: 3 }), 0);
  close(tfidfWeight({ tf: 1, df: 1 }, { N: 3 }), Math.log(3));
});
