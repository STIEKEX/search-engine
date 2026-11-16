// The ranking methods the evaluation compares, and how to run a query with
// one of them. Shared by pool.js (what to label) and evaluate.js (scoring).

import { search } from "../server/lib/search.js";

const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export const METHODS = [
  { name: "bm25", rank: "bm25" },
  { name: "tfidf", rank: "tfidf" },
  { name: "pagerank", rank: "pagerank" },
  ...ALPHAS.map((alpha) => ({ name: `combined a=${alpha}`, rank: "combined", alpha })),
];

// The same mode the search page uses by default: pages with ALL the words.
export const EVAL_MODE = "all";

/** Top-k result URLs of one method for one query. */
export async function topUrls(query, method, deps, k = 10) {
  const res = await search(query, { mode: EVAL_MODE, rank: method.rank, alpha: method.alpha, limit: k, snippets: false }, deps);
  return res.results.map((r) => ({ url: r.url, title: r.title }));
}
