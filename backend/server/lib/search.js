// The search engine's query side: M4 (Boolean AND) + M5 (BM25) + M6/M7
// (PageRank, combined) + M8 (snippets) + phrases and typo tolerance, in one
// pipeline.
//
//   'Solar "milky way"'
//     -> tokenize                     solar + phrase(milki, wai)   (shared/tokenize.js)
//     -> load postings (docId + tf)   ONE database round trip (+ positions if there's a phrase)
//     -> a word on no page?           try the closest real word ("frnce" -> "france"), search again
//     -> candidates                   AND: intersect (M4) / OR: union; then the phrase check
//     -> score                        BM25, TF-IDF, PageRank, combined
//     -> sort, take one page
//     -> url/title from memory, snippet from the page's text file

import { analyzeWithOffsets, tokenize } from "../../shared/tokenize.js";
import Term from "../models/Term.js";
import { scoreCandidates } from "./bm25.js";
import { combineScores } from "./combine.js";
import { intersectAll } from "./intersect.js";
import { findDoc, parsePhrases, phraseMatches } from "./phrase.js";
import { makeSnippet } from "./snippet.js";
import { createSpellChecker } from "./spell.js";

export const MAX_QUERY_TERMS = 10;
export const RANKINGS = ["combined", "bm25", "tfidf", "pagerank", "none"];
export const MODES = ["all", "any"];
// Where a page comes from, for the All / Wikipedia / Medium tabs.
export const SOURCES = ["all", "wikipedia", "medium"];

/** "wikipedia", "medium" or "other", from the page's host. */
export function sourceOf(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return "other";
  }
  if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) return "wikipedia";
  if (host === "medium.com" || host.endsWith(".medium.com")) return "medium";
  return "other";
}
// Chosen by the evaluation in M7 (eval/results.md, 25 queries): BM25 alone
// had the best nDCG@10 (0.903). Mixing in PageRank lowered it at every alpha
// (0.879 at alpha 0.9, 0.512 at 0.5): in this corpus the high-PageRank pages
// are hubs such as "Wikipedia" or "United States", which contain the query
// words but are rarely what the query is about. Re-run `npm run eval`
// before changing these.
export const DEFAULT_RANK = "bm25";
export const DEFAULT_ALPHA = 0.9; // the best alpha, used when rank=combined is asked for

export class SearchInputError extends Error {
  status = 400;
}

/**
 * @param {string} query
 * @param {{ page?: number, limit?: number, mode?: "all"|"any", rank?: string, alpha?: number,
 *           snippets?: boolean, correct?: boolean, source?: "all"|"wikipedia"|"medium" }} opts
 * @param {{ indexCache: object, blobStore: object }} deps
 */
export async function search(query, opts, deps) {
  const startedAt = performance.now();
  const { page = 1, limit = 10, mode = "all", rank = DEFAULT_RANK, alpha = DEFAULT_ALPHA, snippets = true, correct = true, source = "all" } = opts;
  const { terms, phrases } = parseQuery(query);
  const snapshot = await deps.indexCache.get(); // memory, no round trip (usually)
  const postings = await loadPostings(terms, phrases.length > 0); // the one round trip
  const missingTerms = terms.filter((t) => !postings.has(t));

  // Typo tolerance: a word that is on no page is probably misspelled. Try the
  // closest real words ONCE (correct: false stops it from looping).
  if (correct && missingTerms.length > 0) {
    const fixed = await correctQuery(query, missingTerms, snapshot);
    if (fixed) {
      const result = await search(fixed.query, { ...opts, correct: false }, deps);
      if (result.total > 0) {
        return { ...result, correction: { original: query, corrected: fixed.query, words: fixed.words }, tookMs: elapsed(startedAt) };
      }
    }
  }

  const allCandidates = findCandidates({ terms, phrases }, postings, mode);
  // Counted BEFORE filtering, so every tab can show how many results it has.
  const sourceCounts = countBySource(allCandidates, snapshot.docs);
  // Filtering before ranking: pages from other sources are never scored.
  const candidates = source === "all" ? allCandidates : allCandidates.filter((d) => sourceOf(snapshot.docs[d]?.url) === source);
  const ranked = rankCandidates(candidates, [...postings.values()], snapshot.docs, snapshot.stats, rank, alpha);
  const pageItems = ranked.slice((page - 1) * limit, page * limit);
  const results = await Promise.all(pageItems.map((r) => toResult(r, snapshot.docs, terms, snippets ? deps.blobStore : null)));
  return {
    query,
    terms: terms.map((term) => ({ term, df: postings.get(term)?.df ?? 0 })),
    phrases: phrases.map((p) => p.text),
    missingTerms,
    correction: null,
    mode,
    rank,
    alpha: rank === "combined" ? alpha : null,
    source,
    sourceCounts,
    corpusSize: snapshot.stats.N, // "in 120 of 3,748 pages" needs N
    total: ranked.length,
    page,
    limit,
    results,
    tookMs: elapsed(startedAt),
  };
}

const elapsed = (startedAt) => Math.round((performance.now() - startedAt) * 10) / 10;

/**
 * Query text -> distinct terms (and quoted phrases), using the SAME
 * tokenizer as the indexer.
 */
export function parseQuery(query) {
  const { phrases, looseText } = parsePhrases(query);
  const phraseTerms = phrases.flatMap((p) => p.terms.map((t) => t.term));
  const terms = [...new Set([...phraseTerms, ...tokenize(looseText)])];
  if (terms.length === 0) {
    throw new SearchInputError(`"${query}" has no searchable words (stopwords such as "the" are not indexed)`);
  }
  if (terms.length > MAX_QUERY_TERMS) {
    throw new SearchInputError(`Too many words: ${terms.length} (max ${MAX_QUERY_TERMS} after removing stopwords)`);
  }
  return { terms, phrases };
}

/**
 * term -> { df, docIds, tfs, positions? } for every term that exists, in ONE
 * round trip. Positions (most of the index's bytes) are loaded only when the
 * query has a phrase, because only the phrase check needs them.
 */
async function loadPostings(terms, withPositions) {
  const projection = { term: 1, chunk: 1, df: 1, "postings.docId": 1, "postings.tf": 1, ...(withPositions && { "postings.positions": 1 }) };
  const chunks = await Term.find({ term: { $in: terms } }, projection)
    .sort({ term: 1, chunk: 1 }) // chunks in order: concatenated, docIds stay sorted
    .lean();
  const byTerm = new Map();
  for (const chunk of chunks) {
    if (!byTerm.has(chunk.term)) byTerm.set(chunk.term, { df: chunk.df, docIds: [], tfs: [], positions: [] });
    const entry = byTerm.get(chunk.term);
    for (const p of chunk.postings) {
      entry.docIds.push(p.docId);
      entry.tfs.push(p.tf);
      if (withPositions) entry.positions.push(p.positions);
    }
  }
  return byTerm;
}

/**
 * AND ("all"): pages containing every word: postings intersection (M4).
 * OR ("any"): pages containing at least one word; ranking puts pages with
 * more of the words first, because each word adds to the BM25 sum.
 * A quoted phrase is always required, in both modes: that's what quotes mean.
 */
function findCandidates({ terms, phrases }, postings, mode) {
  const phraseTerms = [...new Set(phrases.flatMap((p) => p.terms.map((t) => t.term)))];
  const required = mode === "all" ? terms : phraseTerms;

  let candidates;
  if (required.length > 0) {
    if (required.some((t) => !postings.has(t))) return []; // a required word is on no page
    candidates = intersectAll(required.map((t) => postings.get(t).docIds));
  } else {
    const union = new Set();
    for (const { docIds } of postings.values()) for (const d of docIds) union.add(d);
    candidates = [...union].sort((a, b) => a - b);
  }
  // Intersection first (cheap, shrinks the set), positions only for the survivors.
  return phrases.length === 0 ? candidates : candidates.filter((docId) => phrases.every((p) => hasPhrase(docId, p, postings)));
}

function hasPhrase(docId, phrase, postings) {
  const positionLists = phrase.terms.map(({ term }) => {
    const entry = postings.get(term);
    return entry.positions[findDoc(entry.docIds, docId)];
  });
  return phraseMatches(positionLists, phrase.terms.map((t) => t.offset));
}

// ---------------------------------------------------------------- typo tolerance

// One spell checker per index snapshot: built from the vocabulary (term,
// df and readable spelling of every indexed word) the first time a query
// needs it, then kept in memory until a new index is built.
const spellCheckers = new WeakMap();

export async function spellCheckerFor(snapshot) {
  if (!spellCheckers.has(snapshot)) {
    const loading = loadVocabulary().then((vocabulary) => createSpellChecker(vocabulary));
    // A failed load (e.g. a network blip) must not be remembered: try again next time.
    loading.catch(() => spellCheckers.delete(snapshot));
    spellCheckers.set(snapshot, loading);
  }
  return spellCheckers.get(snapshot);
}

async function loadVocabulary() {
  const rows = await Term.find({ chunk: 0, display: { $exists: true } }, { term: 1, df: 1, display: 1 }).lean();
  return rows.map((r) => ({ word: r.display, term: r.term, df: r.df }));
}

/**
 * Replace each misspelled word of the query (one whose term is on no page)
 * with the closest real word. Returns null if nothing could be corrected.
 * @returns {Promise<{ query: string, words: Array<{ from: string, to: string }> } | null>}
 */
async function correctQuery(query, missingTerms, snapshot) {
  const checker = await spellCheckerFor(snapshot);
  const missing = new Set(missingTerms);
  const fixes = [];
  for (const token of analyzeWithOffsets(query)) {
    if (!missing.has(token.term) || token.start === null) continue;
    const best = checker.correct(token.word);
    if (best) fixes.push({ start: token.start, end: token.end, from: query.slice(token.start, token.end), to: best.word });
  }
  if (fixes.length === 0) return null;
  // Replace from the end, so the earlier offsets stay valid.
  let corrected = query;
  for (const f of [...fixes].reverse()) corrected = corrected.slice(0, f.start) + f.to + corrected.slice(f.end);
  return { query: corrected, words: fixes.map(({ from, to }) => ({ from, to })) };
}

/** Score and sort. Ties go to the lower docId, so pages are stable across requests. */
function rankCandidates(candidates, termPostings, docs, stats, rank, alpha) {
  if (rank === "none") return candidates.map((docId) => ({ docId, score: null, bm25: null, pagerank: docs[docId]?.pagerank ?? null }));

  const text = scoreCandidates(candidates, termPostings, (d) => docs[d].length, stats);
  const bm25 = candidates.map((d) => text.get(d).bm25);
  // An index built before M6 has no PageRank: treat every page as average.
  const pagerank = candidates.map((d) => docs[d].pagerank || 1 / stats.N);
  const final = {
    bm25: () => bm25,
    tfidf: () => candidates.map((d) => text.get(d).tfidf),
    pagerank: () => pagerank,
    combined: () => combineScores(bm25, pagerank, alpha),
  }[rank]();

  return candidates
    .map((docId, i) => ({ docId, score: final[i], bm25: bm25[i], pagerank: pagerank[i] }))
    .sort((a, b) => b.score - a.score || a.docId - b.docId);
}

/** { all, wikipedia, medium, other } -> number of candidate pages from each. */
function countBySource(candidates, docs) {
  const counts = { all: candidates.length, wikipedia: 0, medium: 0, other: 0 };
  for (const docId of candidates) counts[sourceOf(docs[docId]?.url)]++;
  return counts;
}

async function toResult({ docId, score, bm25, pagerank }, docs, terms, blobStore) {
  const doc = docs[docId];
  return {
    docId,
    url: doc?.url ?? null,
    title: doc?.title ?? null,
    source: sourceOf(doc?.url),
    inlinks: doc?.inlinks ?? null, // indexed pages linking here (the "How this ranked" panel)
    score,
    scores: { bm25, pagerank },
    snippet: blobStore && doc?.textRef ? await loadSnippet(blobStore, doc.textRef, terms) : null,
  };
}

async function loadSnippet(blobStore, textRef, terms) {
  try {
    return makeSnippet((await blobStore.get(textRef)).toString("utf8"), terms);
  } catch (err) {
    if (err.code === "ENOENT") return null; // text file missing (e.g. data/ not on this machine)
    throw err;
  }
}
