// Snippet generation: the 1-2 lines of page text shown under a search
// result, with the query words highlighted.
//
// Goal: the window of text that contains the MOST DIFFERENT query words
// (ties: more matches in total, then earlier in the page). For the query
// "solar system planets", a window mentioning all three beats one that says
// "system" five times.
//
// Algorithm (sliding window, like intersecting sorted lists):
//   1. Tokenize the page with offsets; keep the matches (query terms).
//   2. Two pointers over the matches: window = matches whose word position
//      is within WINDOW_WORDS of the first one. Count distinct terms.
//   3. Keep the best window, cut the original text around it.
// Cost: O(words in page) for tokenizing + O(matches) for the window.

import { analyzeWithOffsets, wordSpans } from "../../shared/tokenize.js";

export const WINDOW_WORDS = 30; // length of the snippet, in words
export const CONTEXT_WORDS = 4; // words shown before the first match
// Only the start of a page is searched for the window (about 3,000 words).
// Stemming every word of a 20,000-word page, for each of 10 results, made
// snippets cost more than the whole rest of the search (measured: +100 to
// +240 ms per query). The trade-off: a match that appears only deep inside
// a very long page is not highlighted (we show the page start instead).
export const MAX_SNIPPET_SOURCE_CHARS = 20_000;
const FALLBACK_CHARS = 200; // no match / no offsets: start of the page

/**
 * @param {string} text            the page's extracted text
 * @param {Iterable<string>} terms query terms, already tokenized (stemmed)
 * @returns {{ fragments: Array<{ text: string, highlight: boolean }>, truncatedStart: boolean, truncatedEnd: boolean }}
 *   Fragments, not HTML: the UI renders highlight=true as <mark>, so page
 *   text can never inject markup into our page.
 */
export function makeSnippet(fullText, terms) {
  const text = (fullText ?? "").slice(0, MAX_SNIPPET_SOURCE_CHARS);
  const wanted = new Set(terms);
  const tokens = analyzeWithOffsets(text);
  if (tokens.length === 0 || tokens[0].start === null) return plainStart(text);

  const matches = tokens.filter((t) => wanted.has(t.term));
  if (matches.length === 0) return plainStart(text);

  const best = bestWindow(matches);
  // Cut by ALL words (stopwords too), so "The Solar System" keeps its "The".
  const spans = wordSpans(text);
  const fromPosition = Math.max(0, matches[best.first].position - CONTEXT_WORDS);
  const toPosition = Math.min(spans.length, fromPosition + WINDOW_WORDS) - 1;
  // At the very start or end of the page, keep the punctuation around the words too.
  const cutStart = fromPosition === 0 ? 0 : spans[fromPosition].start;
  const cutEnd = toPosition === spans.length - 1 ? text.length : spans[toPosition].end;
  const highlights = matches.filter((t) => t.position >= fromPosition && t.position <= toPosition);

  return {
    fragments: toFragments(text, cutStart, cutEnd, highlights),
    truncatedStart: cutStart > 0,
    truncatedEnd: cutEnd < text.length,
  };
}

/**
 * Index of the first match of the best window.
 * Two pointers: `first` walks every match; `last` only moves forward, so the
 * whole scan is O(matches).
 */
export function bestWindow(matches, windowWords = WINDOW_WORDS) {
  const countByTerm = new Map();
  let best = { first: 0, distinct: 0, total: 0 };
  let last = 0; // one past the last match inside the window
  for (let first = 0; first < matches.length; first++) {
    while (last < matches.length && matches[last].position < matches[first].position + windowWords) {
      countByTerm.set(matches[last].term, (countByTerm.get(matches[last].term) ?? 0) + 1);
      last++;
    }
    const total = last - first;
    if (countByTerm.size > best.distinct || (countByTerm.size === best.distinct && total > best.total)) {
      best = { first, distinct: countByTerm.size, total };
    }
    // Slide: the match at `first` leaves the window.
    const term = matches[first].term;
    const left = countByTerm.get(term) - 1;
    if (left === 0) countByTerm.delete(term);
    else countByTerm.set(term, left);
  }
  return best;
}

function toFragments(text, cutStart, cutEnd, highlights) {
  const fragments = [];
  let at = cutStart;
  for (const h of highlights) {
    if (h.start > at) fragments.push({ text: text.slice(at, h.start), highlight: false });
    fragments.push({ text: text.slice(h.start, h.end), highlight: true });
    at = h.end;
  }
  if (at < cutEnd) fragments.push({ text: text.slice(at, cutEnd), highlight: false });
  return fragments;
}

function plainStart(text = "") {
  const cutEnd = Math.min(text.length, FALLBACK_CHARS);
  return {
    fragments: cutEnd > 0 ? [{ text: text.slice(0, cutEnd), highlight: false }] : [],
    truncatedStart: false,
    truncatedEnd: cutEnd < text.length,
  };
}
