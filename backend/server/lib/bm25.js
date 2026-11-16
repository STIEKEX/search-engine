// Text relevance scores: TF-IDF (the classic) and BM25 (the standard).
//
// Both answer: "how much is this page about these query words?" Both add up
// one score per query word that the page contains:
//
//   score(page) = Σ  weight(word in page)
//
// Two ideas drive the weight:
//   TF  (term frequency):  a word used often on a page says more about it.
//   IDF (inverse document frequency): a RARE word says more than a common one.
//       "photosynthesis" on 3 of 2,000 pages is a strong signal; "world" on
//       820 of them is weak. A word on EVERY page tells us nothing.

export const BM25_DEFAULTS = Object.freeze({ k1: 1.2, b: 0.75 });

/**
 * IDF as BM25 uses it (the Lucene variant, which never goes negative):
 *   idf = ln(1 + (N - df + 0.5) / (df + 0.5))
 * N = pages in the index, df = pages containing the word.
 */
export function idf(N, df) {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * BM25 weight of ONE word in ONE page:
 *
 *                     tf * (k1 + 1)
 *   idf  *  ------------------------------------------
 *           tf + k1 * (1 - b + b * docLength / avgLength)
 *
 * k1 (1.2): tf SATURATION. The 1st occurrence adds a lot, the 10th very little,
 *           so a page cannot win by repeating a word 100 times.
 *           k1 = 0 ignores tf completely (does the page contain it or not).
 * b (0.75): LENGTH NORMALIZATION. A long page contains every word more often
 *           just because it is long, so its tf counts for less.
 *           b = 0 ignores length; b = 1 normalizes fully.
 *
 * @param {{ tf: number, df: number, docLength: number }} term
 * @param {{ N: number, avgLength: number }} corpus
 */
export function bm25Weight({ tf, df, docLength }, { N, avgLength }, { k1, b } = BM25_DEFAULTS) {
  const lengthRatio = avgLength > 0 ? docLength / avgLength : 1;
  const tfPart = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lengthRatio));
  return idf(N, df) * tfPart;
}

/**
 * TF-IDF weight of one word in one page, for comparison with BM25:
 *   (1 + ln tf) * ln(N / df)
 * The log on tf dampens repeats, but nothing caps it and page length is
 * ignored: the two weaknesses BM25 was designed to fix.
 */
export function tfidfWeight({ tf, df }, { N }) {
  if (tf <= 0 || df <= 0) return 0;
  return (1 + Math.log(tf)) * Math.log(N / df);
}

/**
 * Score candidate pages for a query.
 *
 * @param {number[]} candidates  docIds to score
 * @param {Array<{ df: number, docIds: number[], tfs: number[] }>} terms
 *        one entry per query word: its postings (docIds ascending, tf alongside)
 * @param {(docId: number) => number} docLength
 * @param {{ N: number, avgLength: number }} corpus
 * @returns {Map<number, { bm25: number, tfidf: number }>}
 */
export function scoreCandidates(candidates, terms, docLength, corpus, params = BM25_DEFAULTS) {
  const scores = new Map(candidates.map((docId) => [docId, { bm25: 0, tfidf: 0 }]));
  for (const { df, docIds, tfs } of terms) {
    for (let i = 0; i < docIds.length; i++) {
      const score = scores.get(docIds[i]);
      if (!score) continue; // not a candidate (e.g. AND mode and it lacks another word)
      const term = { tf: tfs[i], df, docLength: docLength(docIds[i]) };
      score.bm25 += bm25Weight(term, corpus, params);
      score.tfidf += tfidfWeight(term, corpus);
    }
  }
  return scores;
}
