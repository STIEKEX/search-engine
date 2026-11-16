// Typo tolerance: "frnce" -> "france".
//
// Edit distance (Damerau-Levenshtein, "optimal string alignment" variant):
// the smallest number of single-letter edits that turn one word into another.
// One edit is: insert a letter, delete a letter, replace a letter, or swap
// two neighbouring letters (the most common typing mistake).
//
//   frnce  -> france   1 (insert "a")
//   teh    -> the      1 (swap "e" and "h")
//   cathedrel -> cathedral  1 (replace "e" with "a")
//
// Dynamic programming: d[i][j] = distance between the first i letters of a
// and the first j letters of b. Each cell looks at its three (or four)
// neighbours, so the whole table costs O(len(a) × len(b)).

/**
 * @param {string} a
 * @param {string} b
 * @param {number} max  stop early and return max + 1 once the answer must exceed max
 */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1; // needs that many inserts at least
  let twoBack = null; // row i - 2, for the swap rule
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j); // row 0: "" -> b[0..j] = j inserts
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost); // delete, insert, replace
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, twoBack[j - 2] + 1); // swap
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    // Every later row is at least this row's minimum: give up early.
    if (rowMin > max) return max + 1;
    twoBack = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Typos allowed: short words would match too many other words with 2 edits. */
export function maxEditsFor(word) {
  return word.length <= 4 ? 1 : 2;
}

/**
 * A spell checker over the index vocabulary.
 * @param {Array<{ word: string, term: string, df: number }>} vocabulary
 *        word = the readable spelling, df = pages containing it
 * @param {{ minDf?: number }} [opts]  ignore words on fewer pages: rare
 *        words are often typos themselves, and make poor corrections
 */
export function createSpellChecker(vocabulary, { minDf = 2 } = {}) {
  // Bucket by first letter: people rarely mistype the first letter, and it
  // cuts the candidates to ~1/26 of the vocabulary.
  const byFirstLetter = new Map();
  for (const entry of vocabulary) {
    if (entry.df < minDf || !entry.word) continue;
    const key = entry.word[0];
    if (!byFirstLetter.has(key)) byFirstLetter.set(key, []);
    byFirstLetter.get(key).push(entry);
  }

  /** Best correction for a word that is NOT in the index, or null. */
  function correct(word) {
    const max = maxEditsFor(word);
    let best = null;
    for (const entry of byFirstLetter.get(word[0]) ?? []) {
      const distance = editDistance(word, entry.word, best ? Math.min(max, best.distance) : max);
      if (distance > max) continue;
      // Closest first; then the more common word; then A-Z (stable answers).
      if (!best || distance < best.distance || (distance === best.distance && (entry.df > best.df || (entry.df === best.df && entry.word < best.word)))) {
        best = { ...entry, distance };
      }
    }
    return best;
  }

  return { correct };
}
