import { test } from "node:test";
import assert from "node:assert/strict";
import { findDoc, parsePhrases, phraseMatches } from "../../server/lib/phrase.js";
import { createSpellChecker, editDistance, maxEditsFor } from "../../server/lib/spell.js";

// ---------------------------------------------------------------- phrases

test("parsePhrases separates quoted phrases from loose words", () => {
  const { phrases, looseText } = parsePhrases('castle "Middle Ages" england');
  assert.deepEqual(phrases, [{ text: "Middle Ages", terms: [{ term: "middl", offset: 0 }, { term: "ag", offset: 1 }] }]);
  assert.match(looseText, /castle\s+england/);
});

test("stopwords inside a phrase keep their gap", () => {
  const { phrases } = parsePhrases('"united states of america"');
  assert.deepEqual(phrases[0].terms.map((t) => t.offset), [0, 1, 3]);
});

test("a one-word phrase is a normal word; an unclosed quote is ignored", () => {
  assert.deepEqual(parsePhrases('"castle" moat').phrases, []);
  assert.deepEqual(parsePhrases('"castle moat').phrases, []);
  assert.match(parsePhrases('"castle moat').looseText, /castle moat/);
});

test("phraseMatches: the words must be next to each other, in order", () => {
  // new at 41 and 87, york at 42: "new york" matches at 41.
  assert.equal(phraseMatches([[41, 87], [42]], [0, 1]), true);
  assert.equal(phraseMatches([[41, 87], [40]], [0, 1]), false, "york before new");
  assert.equal(phraseMatches([[10], [15]], [0, 1]), false, "both present, but apart");
  assert.equal(phraseMatches([[5], [6], [8]], [0, 1, 3]), true, "a stopword gap at +2");
});

test("findDoc: binary search in a sorted docId list", () => {
  const ids = [2, 5, 9, 14, 30];
  assert.equal(findDoc(ids, 9), 2);
  assert.equal(findDoc(ids, 2), 0);
  assert.equal(findDoc(ids, 30), 4);
  assert.equal(findDoc(ids, 10), -1);
  assert.equal(findDoc([], 1), -1);
});

// ---------------------------------------------------------------- spelling

test("editDistance counts insert, delete, replace and swap as one edit each", () => {
  assert.equal(editDistance("frnce", "france"), 1, "insert");
  assert.equal(editDistance("francee", "france"), 1, "delete");
  assert.equal(editDistance("cathedrel", "cathedral"), 1, "replace");
  assert.equal(editDistance("teh", "the"), 1, "swap neighbours");
  assert.equal(editDistance("kitten", "sitting"), 3, "the textbook example");
  assert.equal(editDistance("same", "same"), 0);
  assert.equal(editDistance("", "abc"), 3);
});

test("editDistance gives up early above max", () => {
  assert.equal(editDistance("abcdef", "uvwxyz", 2), 3, "returns max + 1");
  assert.equal(editDistance("a", "abcdefgh", 2), 3, "length difference alone exceeds max");
});

test("short words allow 1 typo, longer words 2", () => {
  assert.equal(maxEditsFor("cat"), 1);
  assert.equal(maxEditsFor("france"), 2);
});

const VOCAB = [
  { word: "france", term: "franc", df: 300 },
  { word: "french", term: "french", df: 350 },
  { word: "frank", term: "frank", df: 20 },
  { word: "cathedral", term: "cathedr", df: 40 },
  { word: "cat", term: "cat", df: 15 },
  { word: "car", term: "car", df: 60 },
  { word: "zebra", term: "zebra", df: 1 }, // too rare to be a correction
];

test("the spell checker picks the closest word", () => {
  const checker = createSpellChecker(VOCAB);
  assert.equal(checker.correct("frnce").word, "france");
  assert.equal(checker.correct("cathedrel").word, "cathedral");
});

test("between equally close words, the more common one wins", () => {
  // "cax" is 1 edit from both "cat" (df 15) and "car" (df 60).
  assert.equal(createSpellChecker(VOCAB).correct("cax").word, "car");
});

test("no correction when nothing is close enough, or the first letter differs", () => {
  const checker = createSpellChecker(VOCAB);
  assert.equal(checker.correct("qwertyuiop"), null);
  assert.equal(checker.correct("rance"), null, "first letters are not corrected");
  assert.equal(checker.correct("zebrs"), null, "rare words (df < 2) are not suggested");
});
