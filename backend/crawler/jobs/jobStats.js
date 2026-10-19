// Read-only reporting for the API: progress, stats and failures of one job.

import CrawlUrl from "../../server/models/CrawlUrl.js";
import { URL_STATES } from "../urlStates.js";
import { pagesKey, used } from "./budgets.js";

/** { queued: n, fetched: n, ... } with every state present (0 if none). */
export async function countByState(jobId) {
  const groups = await CrawlUrl.aggregate([{ $match: { jobId } }, { $group: { _id: "$state", n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(URL_STATES.map((s) => [s, 0]));
  for (const g of groups) counts[g._id] = g.n;
  return counts;
}

export async function jobStats(job, { fetchQueue, parseQueue }) {
  const [byState, [facets], fetchQ, parseQ, pagesUsed] = await Promise.all([
    countByState(job._id),
    CrawlUrl.aggregate([
      { $match: { jobId: job._id } },
      {
        $facet: {
          http: [{ $match: { "fetch.httpStatus": { $ne: null } } }, { $group: { _id: "$fetch.httpStatus", n: { $sum: 1 } } }],
          // retries = attempts beyond the first one
          retries: [
            {
              $group: {
                _id: null,
                fetch: { $sum: { $max: [{ $subtract: ["$fetch.attempts", 1] }, 0] } },
                parse: { $sum: { $max: [{ $subtract: ["$parse.attempts", 1] }, 0] } },
              },
            },
          ],
          skipReasons: [{ $match: { state: "skipped" } }, { $group: { _id: "$skipReason", n: { $sum: 1 } } }],
        },
      },
    ]),
    fetchQueue.stats({ jobId: job._id }),
    parseQueue.stats({ jobId: job._id }),
    used(pagesKey(job._id)),
  ]);

  return {
    byState,
    httpStatus: Object.fromEntries(facets.http.map((g) => [g._id, g.n])),
    retries: { fetch: facets.retries[0]?.fetch ?? 0, parse: facets.retries[0]?.parse ?? 0 },
    deadLetters: { fetch: fetchQ.dead, parse: parseQ.dead },
    queues: { fetch: fetchQ, parse: parseQ },
    skipReasons: Object.fromEntries(facets.skipReasons.map((g) => [g._id ?? "unknown", g.n])),
    duplicates: { urls: job.counters.duplicateUrls, content: byState.duplicate },
    excludedUrls: job.counters.excludedUrls,
    pagesBudget: { used: pagesUsed, max: job.limits.maxPages },
  };
}

/** Dead-lettered messages of both queues, joined with their URL. */
export async function listFailures(jobId, { fetchQueue, parseQueue }) {
  const [deadFetch, deadParse] = await Promise.all([fetchQueue.listDead(jobId), parseQueue.listDead(jobId)]);
  const messages = [...deadFetch.map((m) => ({ ...m, stage: "fetch" })), ...deadParse.map((m) => ({ ...m, stage: "parse" }))];
  const urls = await CrawlUrl.find({ _id: { $in: messages.map((m) => m.urlId) } }, { normalizedUrl: 1, state: 1 }).lean();
  const urlById = new Map(urls.map((u) => [String(u._id), u]));
  return messages.map((m) => ({
    stage: m.stage,
    urlId: m.urlId,
    url: urlById.get(String(m.urlId))?.normalizedUrl ?? null,
    urlState: urlById.get(String(m.urlId))?.state ?? null,
    attempts: m.attempts,
    lastError: m.lastError,
    deadAt: m.deadAt,
  }));
}
