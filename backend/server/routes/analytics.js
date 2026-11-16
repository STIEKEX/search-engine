import { Router } from "express";
import { z } from "zod";
import { sourceOf } from "../lib/search.js";
import { BASELINE_DAYS, TOP_N, trends } from "../lib/trends.js";
import SearchLog, { MAX_CLICKS_PER_SEARCH } from "../models/SearchLog.js";
import { searchIdSchema } from "./search.js";
import { validate } from "./validation.js";

const router = Router();

const clickBody = z
  .object({
    searchId: searchIdSchema,
    position: z.number().int().min(1).max(1000), // 1 = first result of page 1
    url: z.string().url().max(2048),
  })
  .strict();

// POST /api/click {searchId, position, url}: the user opened a result.
// The browser sends it with navigator.sendBeacon, which still delivers when
// the page is being left, so clicks are not lost to navigation.
router.post("/click", async (req, res) => {
  const body = validate(clickBody, req.body, res);
  if (!body) return;
  const { matchedCount } = await SearchLog.updateOne(
    { _id: body.searchId },
    // $slice keeps only the last N clicks: one page view can't grow forever.
    { $push: { clicks: { $each: [{ position: body.position, url: body.url, at: new Date() }], $slice: -MAX_CLICKS_PER_SEARCH } } },
  );
  if (matchedCount === 0) return res.status(404).json({ error: "Unknown searchId" });
  res.status(204).end();
});

// GET /api/trends: the public Trending page. Only what is fit to show any
// visitor (see server/lib/trends.js for the privacy rules). Site-health
// numbers (CTR, zero-result rate, latency) are deliberately NOT served here.
router.get("/trends", async (req, res) => {
  const since = new Date(Date.now() - (BASELINE_DAYS + 1) * 86_400_000);
  const logs = await SearchLog.find({ createdAt: { $gte: since } }, { key: 1, query: 1, page: 1, total: 1, createdAt: 1, "clicks.url": 1 }).lean();
  const { popular, trending, reads } = trends(logs);
  res.json({ popular, trending, reads: await describeReads(reads, req.app.locals.indexCache) });
});

/**
 * Keep only clicked URLs that are pages of OUR index, and give them their
 * title and source. Click URLs come from the browser, so anyone could POST
 * a made-up or offensive URL; it must never reach the public page.
 */
async function describeReads(reads, indexCache) {
  let snapshot;
  try {
    snapshot = await indexCache.get();
  } catch {
    return []; // no index built: nothing can be described
  }
  const byUrl = new Map(snapshot.docs.filter(Boolean).map((d) => [d.url, d]));
  return reads
    .filter((r) => byUrl.has(r.url))
    .slice(0, TOP_N)
    .map((r) => ({ ...r, title: byUrl.get(r.url).title, source: sourceOf(r.url) }));
}

export default router;
