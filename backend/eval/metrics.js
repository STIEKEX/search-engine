// Ranking quality metrics (IIR chapter 8).
//
// Relevance labels per query and page: 2 = very relevant, 1 = somewhat,
// 0 = not relevant. A result nobody labeled counts as 0 (the usual
// assumption with pooled judgments: every method's top 10 WAS labeled).
//
// A URL that appears AGAIN in the same ranking counts as 0 the second time:
// the user learns nothing new from a repeat. Without this, an index holding
// two copies of a relevant page scored HIGHER (both copies earned the label),
// and nDCG could even exceed 1, because the ideal ranking counts each page once.

/** Each URL's label at its first position; repeats get 0. */
function labelsInOrder(ranked, labels, k) {
  const seen = new Set();
  return ranked.slice(0, k).map((url) => {
    if (seen.has(url)) return 0;
    seen.add(url);
    return labels.get(url) ?? 0;
  });
}

/**
 * Precision@k: what fraction of the top k results are relevant (label >= 1)?
 * Missing results (fewer than k) count as not relevant, so a method cannot
 * score well by returning only its one safest result.
 * @param {string[]} ranked   result URLs, best first
 * @param {Map<string, number>} labels  URL -> 0 | 1 | 2
 */
export function precisionAtK(ranked, labels, k = 10) {
  return labelsInOrder(ranked, labels, k).filter((label) => label >= 1).length / k;
}

/**
 * DCG@k (discounted cumulative gain): relevant results count more near the top.
 *   DCG = Σ (2^label - 1) / log2(rank + 1)      rank = 1, 2, 3...
 * Rank 1 is divided by log2(2) = 1, rank 3 by 2, rank 7 by 3: lower positions
 * matter less, because users read from the top. 2^label - 1 makes a "very
 * relevant" page (gain 3) worth three "somewhat" ones (gain 1 each).
 */
export function dcgAtK(labelsInOrder, k = 10) {
  let dcg = 0;
  labelsInOrder.slice(0, k).forEach((label, i) => {
    dcg += (2 ** label - 1) / Math.log2(i + 2);
  });
  return dcg;
}

/**
 * nDCG@k: DCG divided by the best possible DCG (all judged pages for this
 * query, sorted best first). 1.0 = perfect ranking. Dividing makes queries
 * comparable: a query with 2 relevant pages and one with 50 both top out at 1.
 * A query with no relevant page at all scores 0.
 */
export function ndcgAtK(ranked, labels, k = 10) {
  const ideal = dcgAtK([...labels.values()].sort((a, b) => b - a), k);
  if (ideal === 0) return 0;
  return dcgAtK(labelsInOrder(ranked, labels, k), k) / ideal;
}

export function mean(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
