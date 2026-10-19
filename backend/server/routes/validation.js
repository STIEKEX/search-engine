import { z } from "zod";

// A 24-hex-character MongoDB ObjectId. Checked up front so a bad id gives a
// clear 400 instead of a confusing cast error deep inside a query.
export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Must be a 24-character hex id");

/**
 * Validate `data` against `schema`. On failure, send 400 with every problem
 * listed and return null; on success return the parsed (typed) data.
 */
export function validate(schema, data, res) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  res.status(400).json({
    error: "Validation failed",
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return null;
}

/** Router.param handler: reject malformed :id values with 400. */
export function checkIdParam(req, res, next, id) {
  if (!objectId.safeParse(id).success) return res.status(400).json({ error: `Invalid id: ${id}` });
  next();
}

/** Escape user text so it matches literally inside a RegExp. */
export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
