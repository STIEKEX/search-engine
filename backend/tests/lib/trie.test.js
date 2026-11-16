import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestTrie, cleanTitle } from "../../server/lib/suggest.js";
import { SuggestTrie } from "../../server/lib/trie.js";

const texts = (entries) => entries.map((e) => e.text);

function trieOf(items, opts) {
  const trie = new SuggestTrie(opts);
  for (const [text, weight] of items) trie.insert(text, { text, weight });
  return trie;
}

test("suggest returns entries whose key starts with the prefix, best weight first", () => {
  const trie = trieOf([["France", 5], ["French Revolution", 3], ["Freedom", 1], ["Germany", 9]]);
  assert.deepEqual(texts(trie.suggest("fr")), ["France", "French Revolution", "Freedom"]);
  assert.deepEqual(texts(trie.suggest("fre")), ["French Revolution", "Freedom"]);
  assert.deepEqual(texts(trie.suggest("french r")), ["French Revolution"]);
});

test("case and accents do not matter", () => {
  const trie = trieOf([["Café culture", 1]]);
  assert.deepEqual(texts(trie.suggest("CAFE")), ["Café culture"]);
  assert.deepEqual(texts(trie.suggest("café c")), ["Café culture"]);
});

test("unknown or empty prefix gives no suggestions", () => {
  const trie = trieOf([["France", 1]]);
  assert.deepEqual(trie.suggest("xyz"), []);
  assert.deepEqual(trie.suggest("   "), []);
});

test("each node keeps only the top K, and limit cuts further", () => {
  const trie = trieOf(Array.from({ length: 20 }, (_, i) => [`apple ${i}`, i]), { topK: 3 });
  assert.deepEqual(texts(trie.suggest("apple")), ["apple 19", "apple 18", "apple 17"]);
  assert.deepEqual(texts(trie.suggest("apple", 2)), ["apple 19", "apple 18"]);
});

test("equal weights are ordered alphabetically, so results are stable", () => {
  const trie = trieOf([["ab", 1], ["ac", 1], ["aa", 1]]);
  assert.deepEqual(texts(trie.suggest("a")), ["aa", "ab", "ac"]);
});

test("the same text is suggested once, with its best weight", () => {
  const trie = new SuggestTrie();
  trie.insert("catholic church", { text: "Catholic Church", weight: 1 });
  trie.insert("catholic church", { text: "Catholic Church", weight: 4 });
  assert.deepEqual(trie.suggest("cath"), [{ text: "Catholic Church", weight: 4 }]);
});

test("buildSuggestTrie: titles by PageRank, reachable from any word, site name removed", () => {
  const docs = [
    { title: "French Revolution - Simple English Wikipedia, the free encyclopedia", url: "u1", pagerank: 0.002 },
    { title: "France - Simple English Wikipedia, the free encyclopedia", url: "u2", pagerank: 0.004 },
    { title: "Revolution - Simple English Wikipedia, the free encyclopedia", url: "u3", pagerank: 0.001 },
  ];
  const trie = buildSuggestTrie(docs);
  assert.deepEqual(texts(trie.suggest("fr")), ["France", "French Revolution"], "more important page first");
  // "French Revolution" starts with "re" only mid-title: half weight (0.001) ties "Revolution" (0.001).
  assert.deepEqual(texts(trie.suggest("revol")), ["French Revolution", "Revolution"]);
  assert.equal(trie.suggest("fra")[0].url, "u2");
});

test("cleanTitle strips known site names", () => {
  assert.equal(cleanTitle("Earth - Simple English Wikipedia, the free encyclopedia"), "Earth");
  assert.equal(cleanTitle("Travel | Books to Scrape - Sandbox"), "Travel");
  assert.equal(cleanTitle("Plain title"), "Plain title");
});
