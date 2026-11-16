# Dev log

One entry per finished milestone or stage. "Built" and the numbers are facts
from the code and test runs; "Understood" and "Still fuzzy" are mine to
write after the study protocol (read, break it, rewrite from memory).

Format:

```
## YYYY-MM-DD · Milestone
Built:        what now runs
Numbers:      tests, pages, timings
Understood:   what I can now explain without notes
Still fuzzy:  what I could not explain yet
Next:         the next step
```

---

## 2026-10-16 · M1 / Crawler Stage 1: polite BFS crawler

Built: single-process BFS crawler (`npm run crawl`): URL normalization,
robots.txt with a 24 h cache, 1 request/s per host, safe fetcher (timeouts,
max 5 redirects, 2 MB cap, HTML only), cheerio parsing, hash-named files.
Numbers: 85 tests. Demo: 30 pages of books.toscrape.com in 36 s, 0 failures,
1,566 duplicate links avoided.
Understood: TODO (write after rewriting normalizeUrl and the BFS loop from memory)
Still fuzzy: TODO
Next: Stage 2

## 2026-10-18 · M2 (code) / Crawler Stage 2: reliable crawler with a job API

Built: job API (`POST /api/jobs`, pause/resume/cancel, stats, failures),
MongoDB queues with leases, separate fetch and parse workers, retries with
backoff + jitter and dead letters, URL state machine, content dedup by
SHA-256, per-job limits, SSRF protection.
Numbers: 166 tests. Demo: fetch worker hard-killed after 5 pages; after a
restart the 15-page job completed with 0 failures and nothing lost.
Understood: TODO (write after rewriting lease/ack, transition, isBlockedAddress)
Still fuzzy: TODO
Next: M3

## 2026-10-23 · M3: tokenizer and inverted index

Built: `shared/tokenize.js` (fold, split, stopwords, Porter stem, positions),
`indexer/buildIndex.js` (full rebuild, staging collections, atomic swap),
`GET /api/index/stats`, `GET /api/index/terms/:word`. Fixed a race in
`budgets.take()` that under-counted a brand-new budget.
Numbers: 209 tests. Demo index: 14 pages, 516 terms, 1,252 postings.
Understood: TODO (write after rewriting tokenize and addDocument)
Still fuzzy: TODO
Next: crawl ~2,000 Simple English Wikipedia pages, then M4

## 2026-11-11 · M2 (data): Simple English Wikipedia crawl

Built: crawl job via the API, seed `wiki/Main_Page`, maxPages 2000, depth 3,
article pages only (exclude patterns for Special:, Talk:, Category:, /w/...).
Fixed before the crawl: after maxPages, waiting fetch work is now dropped in
bulk (it was leased and skipped one by one). Fixed during the crawl: the
"any work left?" check counted ~14,000 messages after every ack; it now
stops at the first one.
Numbers: 2,000 pages parsed in 65 min, 0 failed, 0 dead letters, 9 fetch
and 2 parse retries; 71,826 duplicate links avoided; at the budget, 26,110
waiting URLs dropped in one bulk step. Index: 2,014 pages (incl. 14 old
books.toscrape pages), 77,466 terms, 816,667 postings, avg 925 terms/page,
built in 108 s. backend/data/ is 371 MB.
Learned: the crawl was limited by Atlas round trips (~13 per page, 70-500 ms
each), not by politeness: 2 fetch loops gave 19-37 pages/min; 6 loops
reached the 60/min politeness ceiling.
Next: M4

## 2026-11-11 · M4: Boolean search API

Built: `server/lib/intersect.js` (two-pointer merge, galloping for
rare-AND-common, shortest list first, stop on empty),
`server/lib/booleanSearch.js` (tokenize, df check first, docIds only,
one round trip), `GET /api/search?q=&page=&limit=`.
Numbers: 233 tests. Shortest first + galloping: 48 comparisons vs 1,519
longest first on the test lists. On Wikipedia: "graph theory" -> 8 pages,
"world war" -> 357; 280-460 ms per query, almost all of it 4 sequential
Atlas round trips (~75 ms each), not the intersection. Unranked order is
useless ("solar system" -> Israel near the top): M5 fixes that.
Understood: TODO (write after rewriting intersectLinear, gallop, intersectAll)
Still fuzzy: TODO
Next: M5 (TF-IDF, then BM25)

## 2026-11-12 · M5-M8 + M10: ranking, PageRank, evaluation, UI, README

Decision: "fastest finish". Claude built M5, M6, M7, M8 and M10 back to back;
one interview cheat sheet (docs/INTERVIEW-CHEATSHEET.md) instead of a
walkthrough per milestone. M9 (autocomplete) and crawler Stage 3 skipped.

Built: BM25 + TF-IDF (`server/lib/bm25.js`), PageRank by power iteration
(`indexer/pagerank.js`, stored at index build), min-max + log combination
(`server/lib/combine.js`), snippets (`server/lib/snippet.js`), in-memory
index cache, one ranked search pipeline (`server/lib/search.js`), evaluation
(`eval/`: 25 queries, pooled blind labels, P@10, nDCG@10), React + Vite
search page (`client/`), README.
Numbers: 273 tests. PageRank matches graphology-metrics to 1e-8, 68
iterations, 53,763 links. nDCG@10: BM25 0.903, TF-IDF 0.741, best BM25 +
PageRank mix (alpha 0.9) 0.879, PageRank alone 0.193 -> default is BM25.
Search 90-160 ms without snippets, 135-260 ms with (Atlas round trip ~100 ms).
Fixes on the way: snippets cut at all words (stopwords too); snippet search
limited to the first 20,000 characters; Porter stems cached.
Labels: drafted by Claude, blind; I still need to review eval/judgments.json.
Understood: TODO (after reading the cheat sheet)
Still fuzzy: TODO
Next: review labels, add a demo GIF to the README, optional M9 autocomplete

## 2026-11-12 · M9: autocomplete

Built: `server/lib/trie.js` (trie, top-8 completions stored per node),
`server/lib/suggest.js` (titles weighted by PageRank, every word of a title
is a start point), `GET /api/suggest`, warm-up at server start, debounced
keyboard-friendly dropdown in the React search box.
Numbers: 283 tests. ~0.1 ms per lookup, ~2-3 ms per HTTP request; the
first build (load 2,014 documents from Atlas + build trie) ~0.9 s, now done
at server start.
Understood: TODO
Still fuzzy: TODO

## 2026-11-12 · Extras: phrase search, typo tolerance, corpus cleanup

Built: quoted phrases (`server/lib/phrase.js`: positions checked after
intersection), typo correction (`server/lib/spell.js`: Damerau-Levenshtein
edit distance over the vocabulary, "Showing results for ..." in the UI),
per-term display spellings stored by the indexer, `index:build --
--exclude-host` (the 14 books.toscrape pages are now left out).
Numbers: 304 tests. Index: 2,000 pages, 77,437 terms. Eval unchanged in
substance: BM25 nDCG@10 0.903, best mix 0.881 (wins 3, ties 10, loses 12).
"frnce revolution" -> "france revolution"; "world war" as a phrase: 182 pages
instead of 357.
Not done: deployment (needs my accounts), crawler Stage 3 (needs Docker running).
Understood: TODO
Still fuzzy: TODO

## 2026-11-12 · Corpus fix: 1,000 core articles

Problem: "we can't search anything". The 2,000 pages were a BFS around the
Main Page (that day: news), so "india", "cricket", "dog" had no page.
Built: a second crawl job seeded with Simple Wikipedia's "List of articles
all languages should have" (maxDepth 1: the list's ~1,000 links only),
`index:build --exclude-url` and `npm run index:wiki` (non-article pages left out).
Numbers: 1,000 pages (983 new, 17 already known), 0 failures despite DNS
and connection drops (12 fetch loops kept it at ~60/min). Index: 2,981 pages,
109,210 terms. 67 new pool pages labeled. BM25 nDCG@10 0.903 -> 0.943; best
BM25+PageRank mix 0.911; PageRank alone 0.164. 305 tests.
Understood: TODO
Still fuzzy: TODO

## 2026-11-14 · Improvements from the Hello Interview crawler design

Built: priority crawling (`order: "inlinks"`: +1 priority per linking page,
lease sorted by priority then age), politeness via queue delay (peek at the
host slot; > 3 s away -> release the message due then; runWorker pauses after
a deferral), re-crawl with conditional GET (`POST /api/jobs/:id/refresh`,
ETag / Last-Modified stored and sent back, 304 -> back to its old state
without parsing; indexer skips content no URL holds), back-of-envelope
section (cheat sheet + README).
Numbers: 316 tests. Experiment, 300 pages from the Main Page: inlinks 122
core articles (40.8%) vs BFS 50 (16.7%), both 57-60 pages/min (one 10-min
pause in the inlinks run = a database connection drop on my network).
Wikipedia answers 304 with 0 bytes to If-Modified-Since.
Understood: TODO
Still fuzzy: TODO

## 2026-11-14 · Database cleanup

Freed space on the 512 MB Atlas free tier: deleted 40,800 "skipped" URL
records (never fetched), dropped the unused `test` database, and removed the
duplicate outlinks lists from `urls` (links are kept once, on `contents`,
for PageRank). The crawler no longer writes that duplicate (new test).
Numbers: used 324 MB -> 207 MB (data + indexes); 305 MB free; `urls` 124 MB
-> 3.7 MB. 317 tests.

## 2026-11-14: Medium importer (RSS) and rate limits

Medium article pages answer 403 to an honest bot, so we read RSS instead:
tag feeds (links only) lead to author/publication feeds (full article text).
First real run: Medium answered 429 after ~25 feed requests and the importer
kept going (bug). Stopped by hand; 0 articles stored. Fix: minimum 5 s
between requests, honor `Retry-After`, back off 30/60/120 s, then stop the
whole import (`RateLimitedError`). Tag feeds also surfaced spam authors, so
`--source` lets us read a hand-picked list of feeds instead. Fixed a flaky
server-side politeness test (978 ms vs a 980 ms threshold under parallel
load; tolerance now 950 ms). 331 tests.

## 2026-11-15: Medium import worked; index quality filter; dedup; metric bug

Re-ran the Medium import at the new 5 s pace: 1,000 articles from 172
author/publication feeds, no 429, one dead feed (404). Quality was mixed:
roughly half good tech/career/life posts, a quarter marketing spam, a fifth
not in English.

Quality filter in the indexer (indexer/quality.js, skip, don't delete):
- Language. A minimum English-stopword share would have dropped ~320
  Wikipedia tables/lists (share 0.02-0.15, same range as Portuguese posts).
  So the rule is relative: foreign function words (es/pt/fr/de/it/id) must be
  >= 0.08 of words AND outnumber English ones, or > 50% non-Latin letters.
  Highest foreign share on Wikipedia: 0.104 ("Salve, Oh Patria", quotes Spanish
  lyrics) - kept, English share 0.198. Result: 0 Wikipedia, 107 Medium skipped.
- Spam: 6 title rules; 29 pages. A body-phrase rule was dropped: its only own
  hits were false positives ("price your services" contains "our services";
  an article quoting example calls to action).

Duplicates: 505 documents were extra copies of the same URL crawled by
different jobs (URL records are per job; Wikipedia bytes change between
visits, so hashes differ), plus 132 redirect aliases (/wiki/MLK, canonical
Martin_Luther_King_Jr.). Indexer now keeps the newest copy per canonical URL
(same host only) and maps links to skipped copies onto the kept document.

Evaluation: after the dedup BM25 nDCG@10 fell 0.969 -> 0.882. Cause 1: the
metric gave every position its label, so duplicates counted twice (nDCG of
[a, a] was 1.63). Fixed: a repeated URL earns 0. Cause 2: labels were keyed
by the alias URL shown at labeling time; after canonical dedup, 58 judged
URLs show under another URL, judged share fell to 84%. Fixed: eval/labels.js
moves labels to the page's current URL. Final: BM25 0.884, 94% judged; the
old 0.943 was inflated. Index 3,748 docs; DB 216 MB of 512. 354 tests.

## 2026-11-16: search analytics and the UI redesign

The user supplied a minimalist mockup ("kuro"). Its AI-synthesis card,
knowledge card and Academic/Code tabs were hard-coded text; the user chose
real replacements: All/Wikipedia/Medium tabs with real counts (new `source`
filter in search()), and a "How this ranked" panel from response data.

Analytics: SearchLog per results page shown, clicks embedded, TTL 30 days,
no user identifiers. The browser's view id is an idempotency key (upsert +
$setOnInsert), so React StrictMode's double effect logs once. Log written
after the response. summarize() is a pure, tested function: CTR, zero-result
queries, CTR by position (impressions = views that showed the position),
p50/p95, per day. Charts are plain SVG; bar color #2a78d6 / #3987e5 validated
(contrast, lightness band) on both card surfaces; each bar has hover + focus
tooltips and a table view.

Checked in a real browser (headless Chrome screenshots, light/dark, phone).
Found: the compact search box would not shrink in the header (flex item
without min-width: 0); fixed. Also learned headless Chrome lays out at >= 504
px wide even when asked for 390, so narrower screenshots are cropped, not
the page. "virat kohli" returned 1 result: a Medium article mentions him
(no typo correction involved). Smoke-test logs deleted afterwards. 377 tests.

Same day, user feedback: removed the "How this ranked" panel and restyled
results like a real search engine (site icon from the site's own
/favicon.ico with a letter fallback, site name + breadcrumb URL, blue title
links, purple when visited, matched words in bold instead of yellow).
Noticed while checking: some Wikipedia snippets contain "[change | change
source]" from the edit links - a text-extraction issue, not UI.

Same day, user feedback: the analytics page is for visitors, so it must not
show site-health numbers. Replaced it with a public Trending page
(server/lib/trends.js, GET /api/trends, /trending): trending now (>= 2
searches in 24 h, growth (today+1)/(avg before+1) > 1), most searched (7
days), popular reads (most opened results). Privacy rules: a query appears
only after 2 searches that found results; reads only for pages in our index
(click URLs are client-supplied). GET /api/analytics removed (404, tested);
summarize() kept, unserved, for a future admin page behind a login. "Trending
news" was not built: there is no news source, and inventing one is not OK.
385 tests.
