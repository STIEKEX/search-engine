# Evaluation results

25 queries, mode "all" (pages with all the words), top 10 results.
Labels: eval/judgments.json (DRAFT labels by Claude, see its _about note).

| Method | P@10 | nDCG@10 | judged |
|---|---|---|---|
| bm25 **(chosen)** | 0.644 | 0.884 | 94% |
| tfidf | 0.536 | 0.723 | 92% |
| pagerank | 0.192 | 0.170 | 93% |
| combined a=0.1 | 0.208 | 0.186 | 94% |
| combined a=0.2 | 0.220 | 0.212 | 96% |
| combined a=0.3 | 0.268 | 0.270 | 96% |
| combined a=0.4 | 0.328 | 0.349 | 96% |
| combined a=0.5 | 0.428 | 0.469 | 96% |
| combined a=0.6 | 0.516 | 0.598 | 97% |
| combined a=0.7 | 0.588 | 0.731 | 98% |
| combined a=0.8 | 0.624 | 0.808 | 96% |
| combined a=0.9 | 0.636 | 0.860 | 96% |

Chosen: **bm25** (best mean nDCG@10).

## nDCG@10 per query: BM25 vs PageRank vs the best combined (combined a=0.9)

| Query | bm25 | pagerank | combined a=0.9 |
|---|---|---|---|
| gothic cathedral | 0.76 | 0.21 | 0.75 |
| civil rights movement | 0.85 | 0.00 | 0.76 |
| martin luther king | 0.84 | 0.09 | 0.83 |
| iranian presidential election | 0.99 | 0.22 | 0.83 |
| supreme leader of iran | 0.93 | 0.00 | 0.89 |
| trump impeachment | 0.91 | 0.08 | 0.91 |
| 2020 presidential election | 0.59 | 0.05 | 0.46 |
| ancient greek philosophy | 0.78 | 0.00 | 0.80 |
| roman empire | 0.95 | 0.00 | 0.91 |
| medieval castle | 1.00 | 0.22 | 1.00 |
| world war | 0.99 | 0.00 | 0.96 |
| slavery in the united states | 0.86 | 0.03 | 0.88 |
| farming crops | 0.83 | 0.20 | 0.96 |
| sheep wool | 1.00 | 0.51 | 1.00 |
| snooker championship | 1.00 | 0.75 | 0.96 |
| german university | 1.00 | 0.00 | 0.95 |
| ecuador province | 1.00 | 0.07 | 0.91 |
| greek mythology monster | 0.80 | 0.28 | 0.79 |
| protestant reformation | 0.80 | 0.04 | 0.83 |
| french revolution | 0.82 | 0.09 | 0.82 |
| free software license | 0.86 | 0.34 | 0.79 |
| english verb tense | 0.81 | 0.37 | 0.81 |
| bubonic plague | 0.99 | 0.55 | 1.00 |
| climate change | 0.74 | 0.00 | 0.71 |
| christopher columbus | 1.00 | 0.16 | 1.00 |
