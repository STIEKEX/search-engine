// M9: autocomplete suggestions for the search box.
//
// Source: the titles of the indexed pages (already in memory in the index
// cache). Index terms are not used: they are stems ("revolut"), which nobody
// wants to see as a suggestion.
//
// Order: PageRank. For RANKING search results it lost the evaluation (M7),
// but for suggestions it is the right signal: while someone has typed only
// "un", the best guess is the most important page starting with "un"
// ("United States"), not the best text match.
//
// Every word of a title is a starting point, so "revo" also suggests
// "French Revolution", at half the weight of titles that START with it.

import { SuggestTrie } from "./trie.js";

// Site names that crawled <title>s carry; not part of what a user types.
const SITE_SUFFIXES = [" - Simple English Wikipedia, the free encyclopedia", " | Books to Scrape - Sandbox"];
const MID_TITLE_WEIGHT = 0.5;

export function cleanTitle(title) {
  let t = (title ?? "").trim();
  for (const suffix of SITE_SUFFIXES) if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
  return t;
}

/** Build a trie from index documents: [{ title, url, pagerank }] indexed by docId. */
export function buildSuggestTrie(docs) {
  const trie = new SuggestTrie();
  docs.forEach((doc) => {
    const text = cleanTitle(doc?.title);
    if (!text) return;
    const weight = doc.pagerank || 0;
    const entry = { text, url: doc.url, weight };
    trie.insert(text, entry);
    // "French Revolution" -> also reachable from "revolution".
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      trie.insert(words.slice(i).join(" "), { ...entry, weight: weight * MID_TITLE_WEIGHT });
    }
  });
  return trie;
}

// One trie per index snapshot. A new `index:build` gives the cache a new
// snapshot object, so the next request builds a fresh trie; the old one is
// garbage-collected together with its snapshot (WeakMap).
const trieBySnapshot = new WeakMap();

/** Suggestions for a typed prefix. Throws IndexNotBuiltError if there is no index. */
export async function suggest(prefix, limit, { indexCache }) {
  const startedAt = performance.now();
  const snapshot = await indexCache.get();
  if (!trieBySnapshot.has(snapshot)) trieBySnapshot.set(snapshot, buildSuggestTrie(snapshot.docs));
  const suggestions = trieBySnapshot.get(snapshot).suggest(prefix, limit).map(({ text, url }) => ({ text, url }));
  return { query: prefix, suggestions, tookMs: Math.round((performance.now() - startedAt) * 100) / 100 };
}
