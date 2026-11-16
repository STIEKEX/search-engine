// Autocomplete with a trie (prefix tree).
//
// A trie stores strings letter by letter; strings with the same beginning
// share the same path:
//
//   (root) ─ f ─ r ─ a ─ n ─ c ─ e          "france"
//                  └ e ─ n ─ c ─ h ...      "french revolution"
//
// Typing "fre" means walking f → r → e: three steps, however many titles
// exist. The trick that makes suggestions instant: every node remembers
// its own TOP K completions (best weight first), computed once when the trie
// is built. Answering is "walk the prefix, read the node's list".
//
// Trade-off (memory vs speed): each node stores up to K entries, so memory is
// about (letters in all keys) × K. For ~2,000 titles that is a few MB, and in
// exchange no query ever has to search the subtree below the prefix.

import { foldText } from "../../shared/tokenize.js";

export const DEFAULT_TOP_K = 8;

export class SuggestTrie {
  constructor({ topK = DEFAULT_TOP_K } = {}) {
    this.topK = topK;
    this.root = newNode();
    this.size = 0; // distinct keys inserted
  }

  /**
   * Make `entry.text` suggestible when the user types any prefix of `key`.
   * @param {string} key    what the typed text is matched against
   * @param {{ text: string, weight: number }} entry  what to suggest, and how good it is
   */
  insert(key, entry) {
    const folded = foldText(key);
    if (folded === "") return;
    let node = this.root;
    for (const letter of folded) {
      if (!node.children.has(letter)) node.children.set(letter, newNode());
      node = node.children.get(letter);
      addToTop(node.top, entry, this.topK);
    }
    this.size++;
  }

  /** Up to `limit` best entries for a typed prefix (case/accent-insensitive). */
  suggest(prefix, limit = 5) {
    const folded = foldText(prefix);
    if (folded === "") return [];
    let node = this.root;
    for (const letter of folded) {
      node = node.children.get(letter);
      if (!node) return []; // no key starts like this
    }
    return node.top.slice(0, limit);
  }
}

function newNode() {
  return { children: new Map(), top: [] };
}

/**
 * Keep `top` as the best K entries, best first (higher weight, then A-Z).
 * The same text can arrive more than once (two keys for one title, or two
 * pages with the same title): it is kept once, with its best weight.
 */
function addToTop(top, entry, k) {
  const existing = top.findIndex((e) => e.text === entry.text);
  if (existing !== -1) {
    if (top[existing].weight >= entry.weight) return;
    top.splice(existing, 1);
  }
  top.push(entry);
  top.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  if (top.length > k) top.length = k;
}
