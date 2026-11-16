import { Router } from "express";
import { z } from "zod";
import CorpusStats, { CORPUS_STATS_ID } from "../models/CorpusStats.js";
import IndexedDocument from "../models/IndexedDocument.js";
import Term from "../models/Term.js";
import { tokenize } from "../../shared/tokenize.js";
import { validate } from "./validation.js";

// Read-only views of the inverted index, to SEE what the indexer built.
// This is not search yet: GET /api/search (M4) will combine several terms,
// and BM25 (M5) will rank the results.

const router = Router();

const NOT_BUILT = "Index not built yet. Run: npm run index:build";

const lookupQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

// GET /api/index/stats: N, average length, vocabulary size, last build time.
router.get("/index/stats", async (req, res) => {
  const stats = await CorpusStats.findById(CORPUS_STATS_ID).lean();
  if (!stats) return res.status(404).json({ error: NOT_BUILT });
  const { _id, ...rest } = stats;
  res.json({ stats: rest });
});

// GET /api/index/terms/:word?limit=20
// "Running" -> looks up "run": its df, and which pages contain it how often.
// The word goes through the SAME tokenizer as the indexer used; that's the
// whole point of shared/tokenize.js.
router.get("/index/terms/:word", async (req, res) => {
  const query = validate(lookupQuery, req.query, res);
  if (!query) return;
  const word = req.params.word;
  if (word.length > 100) return res.status(400).json({ error: "Word is too long (max 100 characters)" });

  const terms = [...new Set(tokenize(word))]; // "cats cat" -> one lookup for "cat"
  if (terms.length === 0) {
    return res.status(400).json({
      error: `"${word}" has no searchable words (stopwords such as "the" are not indexed)`,
      terms: [],
    });
  }
  if (!(await CorpusStats.exists({ _id: CORPUS_STATS_ID }))) return res.status(404).json({ error: NOT_BUILT });

  const results = [];
  for (const term of terms) results.push(await lookupTerm(term, query.limit));
  res.json({ input: word, terms, results });
});

/** One term's postings, joined with page URL and title. */
async function lookupTerm(term, limit) {
  // All chunks of the term, in order; concatenated they are the full list.
  const chunks = await Term.find({ term }).sort({ chunk: 1 }).lean();
  if (chunks.length === 0) return { term, df: 0, pages: [] };
  const postings = chunks.flatMap((c) => c.postings);

  // Most occurrences first, so the list is easy to read. This is NOT
  // ranking: a long page repeating a word beats a short, focused page.
  // Fixing exactly that is BM25's job (M5).
  const top = [...postings].sort((a, b) => b.tf - a.tf || a.docId - b.docId).slice(0, limit);
  const docs = await IndexedDocument.find({ _id: { $in: top.map((p) => p.docId) } }).lean();
  const docById = new Map(docs.map((d) => [d._id, d]));

  return {
    term,
    df: chunks[0].df,
    pages: top.map((p) => ({
      docId: p.docId,
      url: docById.get(p.docId)?.url ?? null,
      title: docById.get(p.docId)?.title ?? null,
      tf: p.tf,
      positions: p.positions.slice(0, 20), // first 20 only; a page can have hundreds
    })),
  };
}

export default router;
