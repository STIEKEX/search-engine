import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { foldText } from "../../shared/tokenize.js";
import { DEFAULT_ALPHA, DEFAULT_RANK, MODES, RANKINGS, SOURCES, search } from "../lib/search.js";
import SearchLog from "../models/SearchLog.js";
import { validate } from "./validation.js";

const router = Router();

// The browser's id for one results page it shows (see recordSearch below).
export const searchIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, "Must be 8-64 letters, digits or dashes");

const searchQuery = z
  .object({
    q: z.string().trim().min(1, "Type something to search").max(200),
    // Query strings are always text; coerce turns "2" into 2.
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    mode: z.enum(MODES).default("all"), // all = AND, any = OR
    rank: z.enum(RANKINGS).default(DEFAULT_RANK), // bm25: the winner of the M7 evaluation
    alpha: z.coerce.number().min(0).max(1).default(DEFAULT_ALPHA), // BM25 weight in "combined"
    // correct=false: search exactly what was typed ("Search instead for ...").
    correct: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    source: z.enum(SOURCES).default("all"), // the All / Wikipedia / Medium tabs
    sid: searchIdSchema.optional(), // analytics: the browser's id for this view
  })
  .strict();

// GET /api/search?q=solar+system&rank=bm25&mode=all&page=1&limit=10&source=all&sid=...
//   q may contain "quoted phrases"; misspelled words are corrected unless correct=false.
// Errors (stopword-only query, index not built) carry a 4xx status and are
// turned into JSON by the error handler in app.js.
router.get("/search", async (req, res) => {
  const query = validate(searchQuery, req.query, res);
  if (!query) return;
  const { q, sid, ...opts } = query;
  const result = await search(q, opts, req.app.locals);
  const searchId = sid ?? randomUUID();
  res.json({ ...result, searchId });

  // Logged AFTER the answer is sent: writing to Atlas costs a ~100 ms round
  // trip, and the user should not wait for analytics. A failed log is a lost
  // data point, not a failed search, so it is only reported.
  recordSearch(searchId, q, opts, result).catch((err) => console.warn(`search log not written: ${err.message}`));
});

/**
 * Store one results page view. The id comes from the browser and is used as
 * an IDEMPOTENCY KEY: upsert + $setOnInsert means the same view sent twice
 * (React runs effects twice in development; a network retry) is logged ONCE.
 * Same idea as the crawler's idempotent queue handlers.
 */
export function recordSearch(searchId, q, opts, result) {
  return SearchLog.updateOne(
    { _id: searchId },
    {
      $setOnInsert: {
        query: q,
        key: foldText(q),
        page: opts.page,
        limit: opts.limit,
        rank: opts.rank,
        mode: opts.mode,
        source: opts.source,
        total: result.total,
        shown: result.results.length,
        tookMs: result.tookMs,
        corrected: result.correction?.corrected ?? null,
        clicks: [],
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export default router;
