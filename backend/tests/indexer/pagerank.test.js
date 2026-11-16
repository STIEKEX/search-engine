import { test } from "node:test";
import assert from "node:assert/strict";
import Graph from "graphology";
import graphologyPagerank from "graphology-metrics/centrality/pagerank.js";
import { buildLinkGraph, pageRank } from "../../indexer/pagerank.js";

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const close = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} vs ${expected}`);

test("hand example: 2 pages linking to each other share the rank equally", () => {
  const { scores, converged } = pageRank(2, [[1], [0]]);
  assert.equal(converged, true);
  close(scores[0], 0.5);
  close(scores[1], 0.5);
});

test("hand example: 4 pages, the page everyone links to wins", () => {
  // A -> C, B -> C, C -> A, D -> C        (A=0, B=1, C=2, D=3)
  // Nobody links to B or D: they only get the random jump, (1-d)/N = 0.0375.
  // C receives everything from A, B and D; A receives everything from C.
  //   C = 0.0375 + 0.85 * (A + B + D)    A = 0.0375 + 0.85 * C
  //   => A + C = 1 - 0.075  and  C = 0.0375 + 0.85 * (A + 0.075)
  //   => C = 0.4876..., A = 0.4374...
  const { scores } = pageRank(4, [[2], [2], [0], [2]]);
  close(scores[1], 0.0375);
  close(scores[3], 0.0375);
  const C = (0.0375 + 0.85 * (0.925 + 0.075)) / 1.85;
  close(scores[2], C);
  close(scores[0], 0.925 - C);
  assert.ok(scores[2] > scores[0] && scores[0] > scores[1]);
});

test("scores always sum to 1, even with dangling pages", () => {
  // Page 2 links nowhere: its rank is spread over everyone.
  const { scores } = pageRank(3, [[1, 2], [2], []]);
  close(sum(scores), 1, 1e-9);
  assert.ok(scores.every((s) => s > 0));
});

test("no links at all: everyone is equal", () => {
  const { scores } = pageRank(4, [[], [], [], []]);
  for (const s of scores) close(s, 0.25);
});

test("empty graph", () => {
  assert.deepEqual(pageRank(0, []), { scores: [], iterations: 0, converged: true });
});

test("matches graphology-metrics' PageRank on a random 200-page graph", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const n = 200;
  const links = Array.from({ length: n }, (_, i) => {
    if (random() < 0.1) return []; // ~10% dangling pages
    const targets = new Set(Array.from({ length: 1 + Math.floor(random() * 8) }, () => Math.floor(random() * n)));
    targets.delete(i);
    return [...targets].sort((a, b) => a - b);
  });

  const graph = new Graph({ type: "directed" });
  for (let i = 0; i < n; i++) graph.addNode(String(i));
  links.forEach((out, i) => out.forEach((j) => graph.addEdge(String(i), String(j))));
  const reference = graphologyPagerank(graph, { alpha: 0.85, tolerance: 1e-12, maxIterations: 500, getEdgeWeight: null });

  const { scores, converged } = pageRank(n, links);
  assert.equal(converged, true);
  for (let i = 0; i < n; i++) close(scores[i], reference[String(i)], 1e-8);
});

test("buildLinkGraph maps URLs to docIds, drops unknown, self and repeated links", () => {
  const docIdByUrl = new Map([
    ["https://w/A", 0],
    ["https://w/B", 1],
    ["https://w/B_redirect", 1], // a redirect to B counts as a link to B
  ]);
  const links = buildLinkGraph(2, [
    { docId: 0, outlinks: ["https://w/B", "https://w/B_redirect", "https://w/A", "https://elsewhere/X"] },
    { docId: 1, outlinks: [] },
  ], docIdByUrl);
  assert.deepEqual(links, [[1], []]);
});
