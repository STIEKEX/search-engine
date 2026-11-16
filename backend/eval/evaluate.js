// Step 2 of the evaluation: score every ranking method on the labeled queries.
//
// For each method and query: take the top 10 results, look up their labels
// (eval/judgments.json), compute Precision@10 and nDCG@10. Average over
// the queries. Then pick alpha (BM25's weight in the combined score) as the
// value with the best mean nDCG@10: tuned on data, not by gut feeling.
//
// Run: npm run eval   -> prints the table and writes eval/results.md

import dns from "node:dns";
import { readFile, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import connectDb from "../server/config/db.js";
import { createIndexCache } from "../server/lib/indexCache.js";
import { loadPageUrls, resolveLabels } from "./labels.js";
import { METHODS, topUrls, EVAL_MODE } from "./methods.js";
import { mean, ndcgAtK, precisionAtK } from "./metrics.js";

const here = (file) => new URL(file, import.meta.url);
const K = 10;

/** Run one method on every query. */
async function evaluateMethod(method, queries, judgments, deps) {
  const perQuery = [];
  let judged = 0;
  let shown = 0;
  for (const { query } of queries) {
    const labels = new Map(Object.entries(judgments[query] ?? {}));
    const ranked = (await topUrls(query, method, deps, K)).map((r) => r.url);
    judged += ranked.filter((u) => labels.has(u)).length;
    shown += ranked.length;
    perQuery.push({ query, p10: precisionAtK(ranked, labels, K), ndcg10: ndcgAtK(ranked, labels, K) });
  }
  return {
    name: method.name,
    p10: mean(perQuery.map((q) => q.p10)),
    ndcg10: mean(perQuery.map((q) => q.ndcg10)),
    judgedShare: shown === 0 ? 1 : judged / shown, // should be 1.0: every shown result was labeled
    perQuery,
  };
}

function report(results, best, queries) {
  const row = (r) => `| ${r.name}${r === best ? " **(chosen)**" : ""} | ${r.p10.toFixed(3)} | ${r.ndcg10.toFixed(3)} | ${(r.judgedShare * 100).toFixed(0)}% |`;
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  const bestCombined = results.filter((r) => r.name.startsWith("combined")).reduce((a, b) => (b.ndcg10 > a.ndcg10 ? b : a));
  const perQuery = queries.map(({ query }, i) => {
    const cell = (name) => byName[name].perQuery[i].ndcg10.toFixed(2);
    return `| ${query} | ${cell("bm25")} | ${cell("pagerank")} | ${cell(bestCombined.name)} |`;
  });
  return [
    "# Evaluation results",
    "",
    `${queries.length} queries, mode "${EVAL_MODE}" (pages with all the words), top ${K} results.`,
    "Labels: eval/judgments.json (DRAFT labels by Claude, see its _about note).",
    "",
    "| Method | P@10 | nDCG@10 | judged |",
    "|---|---|---|---|",
    ...results.map(row),
    "",
    `Chosen: **${best.name}** (best mean nDCG@10).`,
    "",
    `## nDCG@10 per query: BM25 vs PageRank vs the best combined (${bestCombined.name})`,
    "",
    `| Query | bm25 | pagerank | ${bestCombined.name} |`,
    "|---|---|---|---|",
    ...perQuery,
    "",
  ].join("\n");
}

async function main() {
  dns.setServers(["8.8.8.8", "1.1.1.1"]); // same reason as server/server.js
  await connectDb(process.env.MONGODB_URI);
  const queries = JSON.parse(await readFile(here("./queries.json"), "utf8"));
  const { queries: rawJudgments } = JSON.parse(await readFile(here("./judgments.json"), "utf8"));
  // Labels follow the page: a page labeled as /wiki/Vault is now shown as
  // /wiki/Vault_(architecture) (its canonical URL). See eval/labels.js.
  const pageUrlOf = await loadPageUrls([...new Set(Object.values(rawJudgments).flatMap((q) => Object.keys(q)))]);
  const judgments = Object.fromEntries(Object.entries(rawJudgments).map(([query, labels]) => [query, Object.fromEntries(resolveLabels(new Map(Object.entries(labels)), pageUrlOf))]));
  const deps = { indexCache: createIndexCache(), blobStore: null };

  const results = [];
  for (const method of METHODS) {
    const r = await evaluateMethod(method, queries, judgments, deps);
    results.push(r);
    console.log(`${r.name.padEnd(16)} P@10 ${r.p10.toFixed(3)}   nDCG@10 ${r.ndcg10.toFixed(3)}   judged ${(r.judgedShare * 100).toFixed(0)}%`);
  }
  // Best nDCG@10; on a tie, the higher P@10.
  const best = results.reduce((a, b) => (b.ndcg10 > a.ndcg10 + 1e-12 || (Math.abs(b.ndcg10 - a.ndcg10) <= 1e-12 && b.p10 > a.p10) ? b : a));
  await writeFile(here("./results.md"), report(results, best, queries));
  console.log(`\nBest: ${best.name}. Wrote eval/results.md`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
