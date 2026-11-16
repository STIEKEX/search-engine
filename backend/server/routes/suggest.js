import { Router } from "express";
import { z } from "zod";
import { suggest } from "../lib/suggest.js";
import { validate } from "./validation.js";

const router = Router();

const suggestQuery = z
  .object({
    q: z.string().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(8).default(5),
  })
  .strict();

// GET /api/suggest?q=fre&limit=5 -> page titles for the search box dropdown.
router.get("/suggest", async (req, res) => {
  const query = validate(suggestQuery, req.query, res);
  if (!query) return;
  res.json(await suggest(query.q, query.limit, req.app.locals));
});

export default router;
