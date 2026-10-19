import { Router } from "express";
import { z } from "zod";
import { URL_STATES } from "../../crawler/urlStates.js";
import CrawlUrl from "../models/CrawlUrl.js";
import { checkIdParam, escapeRegex, objectId, validate } from "./validation.js";

const router = Router();
router.param("id", checkIdParam);

const listQuery = z
  .object({
    jobId: objectId.optional(),
    q: z.string().max(200).optional(),
    state: z.enum(URL_STATES).optional(),
    // Query strings are always text; coerce turns "2" into 2.
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const LIST_FIELDS = { normalizedUrl: 1, title: 1, state: 1, depth: 1, jobId: 1, "fetch.httpStatus": 1, skipReason: 1 };

function serializeListItem(u) {
  return { id: u._id, jobId: u.jobId, url: u.normalizedUrl, title: u.title, state: u.state, depth: u.depth, httpStatus: u.fetch?.httpStatus ?? null, skipReason: u.skipReason };
}

// GET /api/pages?jobId=&q=&state=&page=&limit=
// A simple admin filter on title/URL to browse what was crawled. This is NOT
// the search engine: real search (inverted index + BM25) comes in M3-M5.
router.get("/pages", async (req, res) => {
  const query = validate(listQuery, req.query, res);
  if (!query) return;
  const { jobId, q, state, page, limit } = query;

  const filter = { ...(jobId && { jobId }), ...(state && { state }) };
  if (q) {
    // Escaped: user text must match literally, never run as a regex pattern.
    const re = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ title: re }, { normalizedUrl: re }];
  }
  const [items, total] = await Promise.all([
    CrawlUrl.find(filter, LIST_FIELDS).sort({ discoveredAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    CrawlUrl.countDocuments(filter),
  ]);
  res.json({ page, limit, total, items: items.map(serializeListItem) });
});

// GET /api/pages/:id: full metadata plus the extracted text.
router.get("/pages/:id", async (req, res) => {
  const page = await CrawlUrl.findById(req.params.id).lean();
  if (!page) return res.status(404).json({ error: "Page not found" });
  const text = page.textRef ? (await req.app.locals.blobStore.get(page.textRef)).toString("utf8") : null;
  res.json({ page: { ...page, id: page._id, _id: undefined }, text });
});

export default router;
