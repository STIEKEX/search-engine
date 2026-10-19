// The URL state machine. Every state change in Stage 2 goes through
// transition(), never through a plain update, for two reasons:
//
// 1. Illegal moves are bugs, so we fail loudly (e.g. parsed -> queued).
// 2. The database update is CONDITIONAL: "set state=parsed WHERE state=fetched".
//    Queues deliver "at least once", so the same message can be processed
//    twice (e.g. a worker was slow, its lease expired, another worker took
//    over). The second attempt finds the URL already moved, its update
//    matches nothing, and it returns false instead of overwriting good data.
//
//                 ┌──────────────► duplicate   (content already parsed elsewhere)
//                 │
//   queued ───────┼──────────────► skipped     (robots, limits, not HTML, SSRF, cancelled)
//     ▲  │        │
//     │  │        └──► fetched ──► parsed      (happy path)
//     │  │                │ ▲
//     │  └──► failed ◄────┘ │                  (permanent error or retries exhausted)
//     │         │           │
//     └─────────┴───────────┘                  (manual retry: POST /failures/retry)

export const URL_STATES = ["queued", "fetched", "parsed", "duplicate", "skipped", "failed"];

export const TRANSITIONS = {
  queued: ["fetched", "duplicate", "skipped", "failed"],
  fetched: ["parsed", "failed"],
  failed: ["queued", "fetched"], // retry of a dead fetch / dead parse message
  parsed: [],
  duplicate: [],
  skipped: [],
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Move one URL from `from` to `to`, setting `fields` in the same write.
 * @returns {Promise<boolean>} true if this call made the move; false if the
 *   URL was not in state `from` any more (someone else already moved it).
 */
export async function transition(UrlModel, urlId, from, to, fields = {}) {
  if (!canTransition(from, to)) throw new Error(`Illegal URL transition: ${from} -> ${to}`);
  const result = await UrlModel.updateOne({ _id: urlId, state: from }, { $set: { ...fields, state: to } });
  return result.modifiedCount === 1;
}
