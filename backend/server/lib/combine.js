// Combining two very different scores into one ranking.
//
// BM25 is "how well does the page match the words" (here roughly 0 to 30).
// PageRank is "how important is the page" (roughly 0.0001 to 0.03, and very
// skewed: a few hub pages have 100x the rank of a typical page). Adding them
// raw would let BM25 completely drown PageRank, so first squeeze each onto
// the same 0..1 scale (min-max normalization), then mix:
//
//   final = alpha * BM25_norm + (1 - alpha) * PageRank_norm
//
// alpha = 1 is pure BM25, alpha = 0 is pure PageRank. The evaluation (M7)
// picks alpha from data, not by gut feeling.

/**
 * Min-max normalization: the smallest value becomes 0, the largest 1.
 * If all values are equal the score cannot tell candidates apart, so every
 * value becomes 0 (any constant would rank the same).
 * @param {number[]} values
 * @returns {number[]}
 */
export function minMaxNormalize(values) {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return values.map(() => 0);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * @param {number[]} bm25      one score per candidate
 * @param {number[]} pagerank  one score per candidate, same order
 * @param {number} alpha       weight of BM25, between 0 and 1
 * @returns {number[]} combined scores, same order
 *
 * PageRank goes through a log first. Its values are so skewed that after a
 * plain min-max, one hub page sits at 1 and nearly everything else at ~0,
 * which would make PageRank a "is this the hub?" switch. log spreads the
 * typical pages out, so differences between them still count.
 */
export function combineScores(bm25, pagerank, alpha) {
  const textPart = minMaxNormalize(bm25);
  const linkPart = minMaxNormalize(pagerank.map((p) => Math.log(p)));
  return textPart.map((t, i) => alpha * t + (1 - alpha) * linkPart[i]);
}
