// Fetch stage: one message = one URL to download.
//
//   lease ─► job paused? release ─► job cancelled? skip
//         ─► URL not "queued"? (repeat delivery) make sure parse is queued, ack
//         ─► timeout / robots checks ─► site busy for long? put back for later
//         ─► budget check ─► fetch (politeness per hop)
//         ─► store raw HTML ─► content seen before? "duplicate" : "fetched" + parse msg
//         ─► ack
// Every write before the ack is safe to repeat, so a crash anywhere just means
// the message is delivered again and the steps run again harmlessly.

import Content from "../../server/models/Content.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { give, hostKey, pagesKey, take } from "../jobs/budgets.js";
import { admitLinks, isExcluded, maybeCompleteJob, onPageBudgetExhausted } from "../jobs/jobService.js";
import { hostOf } from "../normalizeUrl.js";
import { transition } from "../urlStates.js";
import { DEFERRED, finish, loadWork, PAUSE_RELEASE_DELAY_MS } from "./common.js";

// Waiting a moment in place is cheaper than a release + a new lease (two
// database round trips); beyond this, the worker's time is better spent on
// another site.
export const DEFAULT_MAX_INLINE_WAIT_MS = 3000;

// A deliberate "no": record it, never retry.
const SKIP_CODES = new Set(["blocked", "not_html", "ssrf_blocked"]);

/** Worth retrying later: the problem is probably temporary. */
export function isRetryable(res) {
  if (res.errorCode === "network" || res.errorCode === "timeout") return true;
  return res.errorCode === "http_error" && (res.httpStatus >= 500 || res.httpStatus === 429);
}

/** @param deps { fetchQueue, parseQueue, fetcher, robots, politeness, blobStore, log } */
export function createFetchHandler(deps) {
  // maxInlineWaitMs: a politeness wait up to this long is done in place;
  // longer ones put the message back in the queue (see defer()).
  const { fetchQueue, parseQueue, log = () => {}, maxInlineWaitMs = DEFAULT_MAX_INLINE_WAIT_MS } = deps;
  const queues = { fetchQueue, parseQueue };
  const done = (msg, job) => finish(fetchQueue, msg, job, queues);

  return async function handleFetch(msg) {
    const { url, job } = await loadWork(msg);
    if (!url || !job) return done(msg, null); // orphan message
    if (job.status === "paused") return fetchQueue.release(msg, PAUSE_RELEASE_DELAY_MS);
    if (job.status === "cancelled" || job.status === "completed") return skip(msg, job, url, `job_${job.status}`);
    if (url.state !== "queued") return resumeAfterFetch(msg, job, url._id);

    const stopReason = await preFetchCheck(job, url);
    if (stopReason) return skip(msg, job, url, stopReason);

    // The site's next polite slot is far away: put the message back for then
    // and let this worker do other work, instead of sleeping while holding it.
    // Checked BEFORE the budget, so a postponed URL does not hold budget.
    const waitMs = deps.politeness.peek ? await deps.politeness.peek(url.host) : 0;
    if (waitMs > maxInlineWaitMs) return defer(msg, url, waitMs);

    const budgetReason = await takeBudget(job, url);
    if (budgetReason) return skip(msg, job, url, budgetReason);

    const res = await fetchPage(job, url);
    if (!res.ok) return handleFailure(msg, job, url, res);
    return handleFetched(msg, job, url, res);
  };

  async function preFetchCheck(job, url) {
    if (Date.now() > job.deadline.getTime()) return "job_timeout";
    // robots BEFORE the budget, so disallowed URLs do not use up maxPages.
    const verdict = await deps.robots.check(url.normalizedUrl);
    return verdict.allowed ? null : verdict.reason;
  }

  /**
   * Release without counting an attempt, due when the slot opens. A little
   * random jitter keeps all postponed messages of one site from becoming due
   * in the same millisecond and stampeding the queue together.
   */
  async function defer(msg, url, waitMs) {
    await fetchQueue.release(msg, waitMs + Math.floor(Math.random() * 250));
    log(`[later] ${url.normalizedUrl} (site busy for ${waitMs} ms)`);
    return DEFERRED;
  }

  /** Count this URL against maxPages and maxPagesPerHost, once per URL. */
  async function takeBudget(job, url) {
    if (url.fetch.budgeted) return null; // a retry: already counted
    if (!(await take(pagesKey(job._id), job.limits.maxPages))) {
      const dropped = await onPageBudgetExhausted(job._id, queues);
      if (dropped > 0) log(`[budget] maxPages reached: ${dropped} waiting URLs dropped in bulk`);
      return "max_pages";
    }
    if (!(await take(hostKey(job._id, url.host), job.limits.maxPagesPerHost))) {
      await give(pagesKey(job._id)); // the first budget said yes; undo it
      return "max_pages_per_host";
    }
    await CrawlUrl.updateOne({ _id: url._id }, { $set: { "fetch.budgeted": true } });
    return null;
  }

  async function fetchPage(job, url) {
    await CrawlUrl.updateOne({ _id: url._id }, { $inc: { "fetch.attempts": 1 } });
    return deps.fetcher.fetchUrl(url.normalizedUrl, {
      maxRedirects: job.limits.maxRedirects,
      maxBytes: job.limits.maxResponseBytes,
      totalTimeoutMs: job.limits.requestTimeoutMs,
      headers: conditionalHeaders(url),
      beforeRequest: (hopUrl, hop) => beforeEachRequest(job, url, hopUrl, hop),
    });
  }

  /**
   * On a re-crawl, send back what the server told us last time. If the page
   * has not changed, it answers "304 Not Modified" with an empty body: almost
   * no bandwidth for the site or for us.
   */
  function conditionalHeaders(url) {
    if (!url.fetch.previousState) return {}; // first crawl of this URL
    return {
      ...(url.fetch.etag && { "if-none-match": url.fetch.etag }),
      ...(url.fetch.lastModified && { "if-modified-since": url.fetch.lastModified }),
    };
  }

  /** Re-crawl found no change: back to the state it had, without parsing again. */
  async function keepUnchanged(msg, job, url, res) {
    await transition(CrawlUrl, url._id, "queued", url.fetch.previousState, {
      "fetch.httpStatus": res.httpStatus,
      "fetch.fetchedAt": res.finishedAt,
      "fetch.previousState": null,
      "fetch.lastError": null,
      // A 304 may omit the validators: keep the ones we have.
      ...(res.etag && { "fetch.etag": res.etag }),
      ...(res.lastModified && { "fetch.lastModified": res.lastModified }),
    });
    log(`[same] ${url.normalizedUrl} (unchanged, HTTP ${res.httpStatus})`);
    return done(msg, job);
  }

  /** Runs before every HTTP request, redirects included. null = go ahead. */
  async function beforeEachRequest(job, url, hopUrl, hop) {
    if (hop > 0) {
      if (job.limits.sameHostOnly && hostOf(hopUrl) !== hostOf(url.seedUrl)) return "redirect_off_host";
      if (isExcluded(job, hopUrl)) return "redirect_excluded";
      if (await CrawlUrl.exists({ jobId: job._id, normalizedUrl: hopUrl })) return "redirect_to_known_url";
    }
    const verdict = await deps.robots.check(hopUrl);
    if (!verdict.allowed) return verdict.reason;
    await deps.politeness.waitTurn(hostOf(hopUrl), verdict.crawlDelayMs);
    return null;
  }

  async function handleFetched(msg, job, url, res) {
    if (res.notModified) return keepUnchanged(msg, job, url, res);
    const raw = await deps.blobStore.putRawHtml(res.body); // content-addressed: safe to repeat
    // A server without 304 support can still send the very same bytes.
    if (url.fetch.previousState && raw.hash === url.contentHash) return keepUnchanged(msg, job, url, res);
    const fields = { ...fetchFields(res), contentHash: raw.hash, rawRef: raw.ref, "fetch.lastError": null, "fetch.previousState": null };

    const content = await Content.findById(raw.hash).lean();
    if (content) {
      // Content-level dedup: these exact bytes were parsed before. Re-use the
      // result instead of parsing again. Its links go in BEFORE the state
      // change, so a crash in between cannot lose them.
      await admitLinks(job, url, content.outlinks.map((u) => ({ url: u, href: u })), queues);
      await transition(CrawlUrl, url._id, "queued", "duplicate", {
        ...fields,
        textRef: content.textRef,
        title: content.title,
        canonicalUrl: content.canonicalUrl,
      });
      log(`[dup ] ${url.normalizedUrl} (same content as an earlier page)`);
      return done(msg, job);
    }

    const moved = await transition(CrawlUrl, url._id, "queued", "fetched", fields);
    if (!moved) return resumeAfterFetch(msg, job, url._id); // another delivery got here first
    await deps.parseQueue.enqueue({ jobId: job._id, urlId: url._id });
    log(`[${res.httpStatus}] depth=${url.depth} ${url.normalizedUrl}`);
    return done(msg, job);
  }

  /** Repeat delivery: the fetch already happened. Make sure parsing is queued, then ack. */
  async function resumeAfterFetch(msg, job, urlId) {
    const current = await CrawlUrl.findById(urlId, { state: 1 }).lean();
    if (current?.state === "fetched") await deps.parseQueue.enqueue({ jobId: job._id, urlId });
    return done(msg, job);
  }

  async function handleFailure(msg, job, url, res) {
    const fields = { ...fetchFields(res), "fetch.lastError": res.error };
    if (isRetryable(res)) {
      await CrawlUrl.updateOne({ _id: url._id }, { $set: fields });
      const { dead, delayMs } = await fetchQueue.nack(msg, res.error);
      log(`[retry] ${url.normalizedUrl} (${res.error}) ${dead ? "-> dead letter" : `in ${delayMs} ms`}`);
      if (dead) {
        await transition(CrawlUrl, url._id, "queued", "failed", fields);
        await maybeCompleteJob(job._id, queues);
      }
      return;
    }
    const to = SKIP_CODES.has(res.errorCode) ? "skipped" : "failed";
    const reason = res.errorCode === "blocked" ? res.error : res.errorCode;
    await transition(CrawlUrl, url._id, "queued", to, { ...fields, skipReason: to === "skipped" ? reason : null });
    log(`[${to}] ${url.normalizedUrl} (${reason})`);
    return done(msg, job);
  }

  async function skip(msg, job, url, reason) {
    if (url.state === "queued") await transition(CrawlUrl, url._id, "queued", "skipped", { skipReason: reason });
    log(`[skip] ${url.normalizedUrl} (${reason})`);
    return done(msg, job);
  }
}

/** Fetch result -> dotted field paths for $set (so other fetch.* fields survive). */
function fetchFields(res) {
  return {
    "fetch.httpStatus": res.httpStatus,
    "fetch.finalUrl": res.finalUrl,
    "fetch.contentType": res.contentType,
    "fetch.charset": res.charset,
    "fetch.sizeBytes": res.ok ? res.sizeBytes : null,
    "fetch.fetchedAt": res.finishedAt,
    "fetch.etag": res.etag ?? null,
    "fetch.lastModified": res.lastModified ?? null,
  };
}
