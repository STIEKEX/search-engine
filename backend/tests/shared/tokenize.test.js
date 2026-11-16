import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, analyzeWithOffsets, MAX_TOKEN_LENGTH, STOPWORDS, tokenize } from "../../shared/tokenize.js";

// Shorthand: "term@position" strings are easy to compare and to read.
const show = (text) => analyze(text).map((t) => `${t.term}@${t.position}`);

test("lowercases and splits on spaces and punctuation", () => {
  assert.deepEqual(tokenize("Hello, WORLD! Search-engine."), ["hello", "world", "search", "engin"]);
});

test('"Running RUNS ran!" -> run, run, ran (Porter strips suffixes; it cannot know "ran" is "run")', () => {
  assert.deepEqual(tokenize("Running RUNS ran!"), ["run", "run", "ran"]);
});

test("stopwords are dropped, but still use up their positions", () => {
  // the=0 cat=1 sat=2 on=3 the=4 mat=5
  assert.deepEqual(show("the cat sat on the mat"), ["cat@1", "sat@2", "mat@5"]);
});

test("a phrase made only of stopwords disappears completely (a known trade-off)", () => {
  assert.deepEqual(tokenize("to be or not to be"), []);
});

test("stopwords are matched before stemming, case-insensitively", () => {
  assert.ok(STOPWORDS.has("was"));
  assert.deepEqual(tokenize("It WAS The Best"), ["best"]);
});

test("possessives and contractions: cat's -> cat, don't -> dont, O'Brien -> obrien", () => {
  assert.deepEqual(tokenize("the cat's toy, don't, O'Brien, cats'"), ["cat", "toi", "dont", "obrien", "cat"]);
});

test("curly apostrophes behave like straight ones", () => {
  assert.deepEqual(tokenize("cat’s don’t"), tokenize("cat's don't"));
});

test("accents are stripped from Latin letters, so 'cafe' finds 'Café'", () => {
  assert.deepEqual(tokenize("Café NAÏVE résumé"), tokenize("cafe naive resume"));
});

test("non-Latin scripts keep their combining marks (Hindi vowel signs are part of the word)", () => {
  assert.deepEqual(tokenize("हिंदी भाषा"), ["हिंदी", "भाषा"]);
});

test("compatibility characters are unpacked: the 'ﬁ' ligature becomes 'fi'", () => {
  assert.deepEqual(tokenize("ﬁnance"), tokenize("finance"));
});

test("numbers are kept; a decimal point splits them", () => {
  assert.deepEqual(tokenize("£51.77 in 1990s"), ["51", "77", "1990"]);
});

test("over-long tokens are dropped but still count as a position", () => {
  const junk = "x".repeat(MAX_TOKEN_LENGTH + 1);
  const ok = "k".repeat(MAX_TOKEN_LENGTH); // not "y": Porter stems a final y to i
  assert.deepEqual(show(`${junk} ${ok} word`), [`${ok}@1`, "word@2"]);
});

test("empty, missing and punctuation-only input give no tokens", () => {
  for (const input of ["", null, undefined, "   ", "!!! --- ..."]) assert.deepEqual(analyze(input), []);
});

test("tokenize() is exactly analyze() without positions", () => {
  const text = "The quick brown foxes JUMPED over 2 lazy dogs' kennels";
  assert.deepEqual(tokenize(text), analyze(text).map((t) => t.term));
});

test("a query and a page that use different forms of a word meet at the same term", () => {
  // This is why the indexer and the API must share this one file.
  const [indexed] = tokenize("connections");
  const [queried] = tokenize("Connected");
  assert.equal(indexed, queried);
});

test("analyzeWithOffsets points each term at its word in the ORIGINAL text", () => {
  const text = "The Café's cats, RUNNING!";
  const tokens = analyzeWithOffsets(text);
  assert.deepEqual(tokens.map((t) => t.term), analyze(text).map((t) => t.term), "same terms as analyze()");
  assert.deepEqual(tokens.map((t) => text.slice(t.start, t.end)), ["Café's", "cats", "RUNNING"]);
});

test("analyzeWithOffsets leaves offsets out rather than guess when folding changes the word count", () => {
  // "½" is one word in the original but becomes "1⁄2" (two words) after folding.
  const tokens = analyzeWithOffsets("½ cup sugar");
  assert.ok(tokens.length > 0);
  assert.ok(tokens.every((t) => t.start === null && t.end === null));
});
