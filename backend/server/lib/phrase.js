// Phrase search: "new york" must match the words NEXT TO EACH OTHER, in
// that order. The index stores each word's positions, so:
//
//   page text:  "... I moved to New York in 2010 ..."
//   new  -> positions [41, 87]
//   york -> positions [42]
//   phrase "new york": new at p AND york at p + 1  ->  p = 41 matches.
//
// Stopwords inside a phrase are not indexed, but they still take up a
// position: "united states of america" -> unit +0, state +1, america +3.
// So the phrase checks that SOME word sits in the gap at +2, without
// checking that it is "of". Close enough, and it needs no stopword index.

import { analyze } from "../../shared/tokenize.js";

/**
 * Split a query into quoted phrases and loose words.
 *   'castle "middle ages" england' -> phrases: ["middle ages"], loose: "castle  england"
 * @returns {{ phrases: Array<{ text: string, terms: Array<{ term: string, offset: number }> }>, looseText: string }}
 */
export function parsePhrases(query) {
  const phrases = [];
  const looseText = query.replace(/"([^"]*)"/g, (_, inside) => {
    const tokens = analyze(inside);
    if (tokens.length >= 2) {
      const first = tokens[0].position;
      phrases.push({ text: inside.trim(), terms: tokens.map((t) => ({ term: t.term, offset: t.position - first })) });
      return " ";
    }
    return ` ${inside} `; // a one-word "phrase" is just a word
  });
  return { phrases, looseText: looseText.replace(/"/g, " ") }; // an unclosed quote is ignored
}

/**
 * Does one page contain the phrase?
 * @param {number[][]} positionLists  positions (ascending) of each phrase term in this page,
 *                                    in phrase order
 * @param {number[]} offsets          where each term must be, relative to the first one
 */
export function phraseMatches(positionLists, offsets) {
  const [first, ...rest] = positionLists;
  // Sets make each "is word i at position p + offset?" check O(1).
  const sets = rest.map((positions) => new Set(positions));
  return first.some((p) => sets.every((set, i) => set.has(p + offsets[i + 1])));
}

/**
 * Index of `docId` in a sorted docId array, or -1. Binary search: the
 * postings list of a common word can hold every page in the corpus.
 */
export function findDoc(docIds, docId) {
  let lo = 0;
  let hi = docIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (docIds[mid] === docId) return mid;
    if (docIds[mid] < docId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
