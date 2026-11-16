// The only place that talks to the backend.

/** GET /api/suggest: page titles that complete what the user is typing. */
export async function suggestApi(prefix, signal) {
  const params = new URLSearchParams({ q: prefix, limit: "6" });
  const res = await fetch(`/api/suggest?${params}`, { signal });
  if (!res.ok) return []; // suggestions are a nice-to-have: fail quietly
  return (await res.json()).suggestions;
}

/**
 * GET /api/search. Resolves with the JSON body; rejects with an Error whose
 * message is the API's own explanation (e.g. "has no searchable words").
 * `signal` lets the caller cancel a request that is no longer needed.
 * `sid` identifies this results page for analytics: the server logs each sid
 * once, so the same request sent twice (React dev mode) is one log.
 */
export async function searchApi({ q, page, rank, mode, exact, source, sid }, signal) {
  // exact = search what was typed, without typo correction
  const params = new URLSearchParams({ q, page: String(page), rank, mode, source, limit: "10", correct: String(!exact), sid });
  const res = await fetch(`/api/search?${params}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.issues?.map((i) => i.message).join("; ");
    throw new Error(detail || body.error || `Search failed (HTTP ${res.status})`);
  }
  return body;
}

/**
 * POST /api/click. sendBeacon, not fetch: the browser delivers a beacon even
 * when the click is navigating away from this page, where a fetch could be
 * cancelled. Fire and forget: analytics must never break a click.
 */
export function logClick(searchId, position, url) {
  if (!searchId) return;
  const body = new Blob([JSON.stringify({ searchId, position, url })], { type: "application/json" });
  try {
    if (navigator.sendBeacon?.("/api/click", body)) return;
  } catch {
    // fall through to fetch
  }
  fetch("/api/click", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
}

/** GET /api/trends: trending and most searched queries, popular reads. */
export async function trendsApi(signal) {
  const res = await fetch("/api/trends", { signal });
  if (!res.ok) throw new Error(`Could not load trends (HTTP ${res.status})`);
  return res.json();
}

/** GET /api/index/stats: how many pages are searchable (null if unknown). */
export async function corpusSizeApi(signal) {
  try {
    const res = await fetch("/api/index/stats", { signal });
    return res.ok ? (await res.json()).stats.N : null;
  } catch {
    return null;
  }
}

/** A fresh id for one results page view (see searchApi). */
export function newViewId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
