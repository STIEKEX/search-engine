// The ONE text pipeline of the search engine (CLAUDE.md rule).
//
// The indexer runs page text through it, and the search API runs the user's
// query through it. Both sides must produce identical terms: if the index
// holds "run" (from "running") but the query side looked up "running", the
// search would silently miss every page. So nothing else in the codebase
// may lowercase, split, drop stopwords or stem on its own.
//
//   "The Cat's café is RUNNING!"
//     1. fold:      "the cat's cafe is running!"     (lowercase, strip Latin accents)
//     2. split:     the | cat's | cafe | is | running   (positions 0..4)
//     3. clean:     the | cat   | cafe | is | running   (possessive 's removed)
//     4. stopwords: drop "the" and "is"   (their positions stay used up)
//     5. stem:      cat@1  cafe@2  run@4

import { stemmer } from "stemmer";

// Words so common that they say nothing about what a page is about. Dropping
// them shrinks the index a lot: "the" alone would have a postings entry for
// nearly every page. Our own short list of English function words; it is
// checked BEFORE stemming, so it holds surface forms ("was", not "wa").
export const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
  "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more",
  "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she",
  "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "why", "will", "with", "would", "you",
  "your", "yours", "yourself", "yourselves",
]);

// Longer "words" are almost always junk: base64, hashes, minified code that
// slipped into the text. Real English words this long are vanishingly rare.
export const MAX_TOKEN_LENGTH = 40;

// A word = letters/digits in any script, optionally joined by apostrophes
// ("don't", "o'brien"). \p{L} is "any letter", \p{M} keeps combining marks
// (Hindi vowel signs are marks: without \p{M}, "हिंदी" would split apart).
// Everything else (spaces, punctuation, hyphens) separates words.
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * Turn text into terms WITH their word positions. The indexer uses this,
 * because positions enable phrase search and snippets later.
 *
 * Positions count every word, including dropped stopwords, so they match the
 * original text: "the cat sat on the mat" -> cat@1 sat@2 mat@5. Position 5
 * still tells us "mat" is the 6th word, although "the" and "on" are gone.
 *
 * @param {string} text
 * @returns {Array<{ term: string, position: number }>}
 */
export function analyze(text) {
  return analyzeWords(text).map(({ term, position }) => ({ term, position }));
}

/**
 * analyze(), plus the readable word each term came from (folded, before
 * stemming): "Running cats" -> { term: "run", word: "running" }, ...
 * The indexer keeps each term's most common word, so the search engine can
 * say "Showing results for france" instead of the stem "franc".
 * @returns {Array<{ term: string, position: number, word: string }>}
 */
export function analyzeWords(text) {
  const tokens = [];
  if (!text) return tokens;

  let position = 0;
  for (const match of foldCase(text).matchAll(WORD)) {
    const word = cleanWord(match[0]);
    const current = position++; // used up even if the word is dropped below
    if (word.length === 0 || word.length > MAX_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.push({ term: stem(word), position: current, word });
  }
  return tokens;
}

/**
 * analyze(), plus where each word sits in the ORIGINAL text ({ start, end }
 * character offsets), so a snippet can cut and highlight the real text.
 *
 * analyze() works on the case-folded text, which can differ in length from
 * the original ("ﬁ" becomes "fi"). So we find the words of the original
 * separately and pair them up by word number. If folding changed the number
 * of words (very rare symbols such as "½"), the pairing would be wrong, so
 * the offsets are left out (start/end null) instead of being guessed.
 *
 * @param {string} text
 * @returns {Array<{ term: string, position: number, word: string, start: number|null, end: number|null }>}
 */
export function analyzeWithOffsets(text) {
  const tokens = analyzeWords(text);
  const spans = wordSpans(text);
  const foldedWordCount = (foldCase(text ?? "").match(WORD) ?? []).length;
  const aligned = spans.length === foldedWordCount;
  return tokens.map((t) => ({
    ...t,
    start: aligned ? spans[t.position].start : null,
    end: aligned ? spans[t.position].end : null,
  }));
}

/**
 * Where EVERY word of the original text is, stopwords included: entry i is
 * word number i (the same numbering as analyze()'s positions). Snippets use
 * it to cut the text at word boundaries.
 * @returns {Array<{ start: number, end: number }>}
 */
export function wordSpans(text) {
  return [...(text ?? "").matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/**
 * Turn text into terms only. The query side uses this:
 * tokenize("Running shoes") -> ["run", "shoe"].
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return analyze(text).map((t) => t.term);
}

/**
 * Case- and accent-folded text with single spaces, WITHOUT stemming or
 * dropping stopwords: "  Café  du MONDE " -> "cafe du monde".
 * Autocomplete uses it: a prefix such as "the bea" must match titles
 * letter by letter ("The Beatles"), which stemming would break.
 */
export function foldText(text) {
  return foldCase(text ?? "").replace(/\s+/gu, " ").trim();
}

// Very common function words of other languages written in Latin letters
// (Spanish, Portuguese, French, German, Italian, Indonesian), in folded form.
// Only words that are RARE in English are listed: "die", "do", "a", "in",
// "no" or "also" are real English words, so they would make English pages
// look foreign. Used by languageProfile() below.
const FOREIGN_FUNCTION_WORDS = new Set([
  "de", "la", "que", "el", "en", "y", "los", "las", "del", "por", "una", "para", "es", "se", "lo", "como", "pero", "sus", "mas", "esta", "este", // es
  "nao", "uma", "um", "os", "das", "dos", "da", "com", "em", "ao", "voce", // pt
  "le", "les", "des", "et", "est", "du", "pour", "qui", "dans", "pas", "sur", "avec", "ce", "sont", "nous", "vous", // fr
  "der", "und", "ist", "nicht", "mit", "ein", "eine", "den", "dem", "auf", "sich", "von", "zu", "auch", "fur", // de
  "il", "di", "che", "della", "non", "sono", "gli", "nel", // it
  "yang", "dan", "ini", "itu", "dengan", "untuk", "tidak", "dari", "dalam", "akan", "ada", "juga", "saya", "kita", "atau", // id
]);

/**
 * Cheap language signals for a text, without a dictionary or a model.
 *
 * Function words ("the", "of", "and", "is"...) make up a big part of ANY
 * prose, whatever the topic, and every language has its own. So:
 *   "The cat sat on the mat"   -> english 3/6 = 0.5, foreign 0
 *   "El gato duerme en la casa" -> english 0,        foreign 3/6 = 0.5 (el, en, la)
 *   "Paris 2,102,650 Lyon ..." -> both near 0: a TABLE, not a language signal
 * The table case is why a caller should compare english against foreign
 * instead of demanding a minimum english share: Wikipedia lists have very few
 * function words but are still English.
 *
 * nonLatin = share of LETTERS from other scripts (Arabic, Devanagari, ...).
 * Counts every word, with the same folding and splitting as analyze().
 * @returns {{ words: number, english: number, foreign: number, nonLatin: number }}
 */
export function languageProfile(text) {
  const folded = foldCase(text ?? "");
  let words = 0;
  let english = 0;
  let foreign = 0;
  for (const match of folded.matchAll(WORD)) {
    words++;
    const word = cleanWord(match[0]);
    if (STOPWORDS.has(word)) english++;
    else if (FOREIGN_FUNCTION_WORDS.has(word)) foreign++;
  }
  const letters = (folded.match(/\p{L}/gu) ?? []).length;
  const latinLetters = (folded.match(/\p{Script=Latin}/gu) ?? []).length;
  return {
    words,
    english: words > 0 ? english / words : 0,
    foreign: words > 0 ? foreign / words : 0,
    nonLatin: letters > 0 ? 1 - latinLetters / letters : 0,
  };
}

/**
 * Lowercase, and strip accents from LATIN letters only: "Café" -> "cafe",
 * so a user who types "cafe" still finds it.
 *
 * NFKD splits "é" into "e" + a combining accent (and unpacks look-alikes
 * such as the "ﬁ" ligature into "fi"); we delete the accent only when it
 * follows a Latin letter. Other scripts keep their marks, because there they
 * are part of the spelling (Hindi "हिंदी" would be destroyed).
 * NFC then glues everything that is left back together.
 */
function foldCase(text) {
  return text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase();
}

// Porter stemming is the slowest step of analyze(), and text repeats the
// same words all the time, so remember each word's stem. Same output, just
// faster (snippets and index builds stem tens of thousands of words).
// Cleared when full, so memory stays bounded.
const STEM_CACHE_MAX = 100_000;
const stemCache = new Map();

function stem(word) {
  let result = stemCache.get(word);
  if (result === undefined) {
    result = stemmer(word);
    if (stemCache.size >= STEM_CACHE_MAX) stemCache.clear();
    stemCache.set(word, result);
  }
  return result;
}

/** "cats'" / "cat's" -> "cats" / "cat";  "don't" -> "dont". */
function cleanWord(word) {
  return word.replace(/['’]s$/u, "").replace(/['’]/gu, "");
}
