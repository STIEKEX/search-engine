// PageRank: how important a page is, judged by the links pointing to it.
//
// Picture a "random surfer" who keeps clicking links. A page's PageRank is the
// share of time the surfer spends on it in the long run. A page is important
// if important pages link to it. The formula (d = 0.85, N = number of pages):
//
//   PR(p) = (1 - d) / N  +  d * Σ PR(q) / outlinks(q)    over pages q linking to p
//
//   (1 - d) / N : 15% of the time the surfer gets bored and jumps to a random
//                 page. Without this, rank can get trapped in a loop of pages.
//   Σ ...       : each page splits its rank evenly over the pages it links to.
//
// Dangling pages (no outlinks) would leak rank out of the system, so their
// rank is spread evenly over ALL pages, as if the surfer jumped randomly.
// That keeps the total at exactly 1.
//
// Power iteration: start everyone at 1/N and apply the formula again and
// again until the numbers stop changing.

/**
 * @param {number} n          number of pages; pages are 0 .. n-1 (our docIds)
 * @param {number[][]} links  links[i] = pages that page i links to
 *                            (no duplicates, no self-links: see buildLinkGraph)
 * @param {{ damping?: number, tolerance?: number, maxIterations?: number }} [opts]
 * @returns {{ scores: number[], iterations: number, converged: boolean }}
 */
export function pageRank(n, links, { damping = 0.85, tolerance = 1e-10, maxIterations = 200 } = {}) {
  if (n === 0) return { scores: [], iterations: 0, converged: true };
  let rank = new Float64Array(n).fill(1 / n);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const next = spreadRank(rank, links);
    // Rank of dangling pages + the random jump: shared equally by every page.
    const base = (1 - damping) / n + (damping * next.dangling) / n;
    let change = 0;
    for (let i = 0; i < n; i++) {
      const value = base + damping * next.received[i];
      change += Math.abs(value - rank[i]);
      next.received[i] = value;
    }
    rank = next.received;
    // L1 change: the sum of how much every score moved this round.
    if (change < tolerance) return { scores: Array.from(rank), iterations: iteration, converged: true };
  }
  return { scores: Array.from(rank), iterations: maxIterations, converged: false };
}

/** One step of "every page hands its rank to the pages it links to". */
function spreadRank(rank, links) {
  const received = new Float64Array(rank.length);
  let dangling = 0;
  for (let page = 0; page < rank.length; page++) {
    const out = links[page];
    if (out.length === 0) {
      dangling += rank[page];
      continue;
    }
    const share = rank[page] / out.length;
    for (const target of out) received[target] += share;
  }
  return { received, dangling };
}

/**
 * Turn crawled outlinks (URLs) into a graph over docIds.
 *
 * @param {Array<{ docId: number, outlinks: string[] }>} pages
 * @param {Map<string, number>} docIdByUrl  every URL that leads to an indexed
 *   page: its own URL, redirects, and duplicates of the same content
 * @returns {number[][]} links[docId] = distinct docIds it links to
 *
 * Links to pages we did not crawl are dropped (they are not in our graph),
 * as are self-links and repeated links, which would otherwise let a page
 * vote for itself or vote twice for the same page.
 */
export function buildLinkGraph(n, pages, docIdByUrl) {
  const links = Array.from({ length: n }, () => []);
  for (const { docId, outlinks } of pages) {
    const targets = new Set();
    for (const url of outlinks) {
      const target = docIdByUrl.get(url);
      if (target !== undefined && target !== docId) targets.add(target);
    }
    links[docId] = [...targets].sort((a, b) => a - b);
  }
  return links;
}
