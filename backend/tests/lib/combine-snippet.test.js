import { test } from "node:test";
import assert from "node:assert/strict";
import { combineScores, minMaxNormalize } from "../../server/lib/combine.js";
import { bestWindow, makeSnippet } from "../../server/lib/snippet.js";
import { tokenize } from "../../shared/tokenize.js";

// ---------------------------------------------------------------- combine

test("minMaxNormalize maps the range onto 0..1", () => {
  assert.deepEqual(minMaxNormalize([2, 4, 6]), [0, 0.5, 1]);
  assert.deepEqual(minMaxNormalize([5, 5]), [0, 0], "all equal: no information");
  assert.deepEqual(minMaxNormalize([]), []);
});

test("combineScores: alpha 1 = pure BM25 order, alpha 0 = pure PageRank order", () => {
  const bm25 = [10, 5, 1];
  const pagerank = [0.001, 0.002, 0.03];
  const order = (scores) => scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  assert.deepEqual(order(combineScores(bm25, pagerank, 1)), [0, 1, 2]);
  assert.deepEqual(order(combineScores(bm25, pagerank, 0)), [2, 1, 0]);
});

test("combineScores: log keeps PageRank differences between ordinary pages", () => {
  // One hub (0.5) and two ordinary pages, one with 3x the rank of the other.
  const [, ordinaryLow, ordinaryHigh] = combineScores([0, 0, 0], [0.5, 0.001, 0.003], 0);
  assert.ok(ordinaryHigh - ordinaryLow > 0.1, "without the log both would sit at ~0");
});

// ---------------------------------------------------------------- snippet

const text = (s) => s.fragments.map((f) => (f.highlight ? `[${f.text}]` : f.text)).join("");

test("makeSnippet highlights the query words in the original text", () => {
  const s = makeSnippet("The Solar System has eight planets.", tokenize("solar planets"));
  assert.equal(text(s), "The [Solar] System has eight [planets].");
  assert.equal(s.truncatedStart, false);
  assert.equal(s.truncatedEnd, false);
});

test("makeSnippet picks the window with the most DIFFERENT query words", () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `filler${i}`).join(" ");
  const page = `system system system ${filler(60)} the solar system and its planets ${filler(60)}`;
  const s = makeSnippet(page, tokenize("solar system planets"));
  assert.match(text(s), /\[solar\] \[system\] and its \[planets\]/);
  assert.equal(s.truncatedStart, true);
  assert.equal(s.truncatedEnd, true);
});

test("bestWindow: two pointers over the matches", () => {
  const m = (term, position) => ({ term, position });
  // positions 0,1 have "a" twice; positions 100,101 have "a" and "b".
  const matches = [m("a", 0), m("a", 1), m("a", 100), m("b", 101)];
  assert.deepEqual(bestWindow(matches, 30), { first: 2, distinct: 2, total: 2 });
});

test("makeSnippet without any match shows the start of the page", () => {
  const s = makeSnippet("Plain text about nothing in particular.", ["zebra"]);
  assert.equal(text(s), "Plain text about nothing in particular.");
  assert.equal(s.fragments.some((f) => f.highlight), false);
});

test("page text is never treated as markup", () => {
  const s = makeSnippet("<script>alert(1)</script> cats", ["cat"]);
  assert.ok(s.fragments.some((f) => f.text.includes("<script>")), "kept as plain text; the UI escapes it");
});

test("empty text gives an empty snippet", () => {
  assert.deepEqual(makeSnippet("", ["cat"]), { fragments: [], truncatedStart: false, truncatedEnd: false });
});

test("only the start of a very long page is searched (bounded cost)", () => {
  const filler = "word ".repeat(10_000); // 50,000 characters, longer than the limit
  const s = makeSnippet(`${filler} zebra`, ["zebra"]);
  assert.equal(s.fragments.some((f) => f.highlight), false, "a match past the limit is not looked for");
  assert.equal(s.truncatedEnd, true);
});
