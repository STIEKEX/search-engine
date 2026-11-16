// Parse stage: one message = one fetched page to turn into text + links.
//
//   lease ─► job paused? release ─► cancelled / not "fetched"? ack
//         ─► read raw HTML from the blob store (NEVER download again)
//         ─► parse ─► store text ─► save Content ─► admit links ─► fetched -> parsed
//         ─► ack
// On an error: nack -> retry with backoff -> after max attempts, dead letter
// and the URL becomes "failed". Parse failures have their own counter
// (parse.attempts), separate from fetch.attempts.

import Content from "../../server/models/Content.js";
import CrawlUrl from "../../server/models/CrawlUrl.js";
import { decode } from "../fetcher.js";
import { admitLinks, maybeCompleteJob } from "../jobs/jobService.js";
import { parsePage } from "../parse.js";
import { transition } from "../urlStates.js";
import { finish, loadWork, PAUSE_RELEASE_DELAY_MS } from "./common.js";

/** @param deps { fetchQueue, parseQueue, blobStore, parse?, log? } */
export function createParseHandler(deps) {
  const { fetchQueue, parseQueue, parse = parsePage, log = () => {} } = deps;
  const queues = { fetchQueue, parseQueue };
  const done = (msg, job) => finish(parseQueue, msg, job, queues);

  return async function handleParse(msg) {
    const { url, job } = await loadWork(msg);
    if (!url || !job) return done(msg, null);
    if (job.status === "paused") return parseQueue.release(msg, PAUSE_RELEASE_DELAY_MS);
    // Cancelled: stop here; the raw HTML stays stored. Not "fetched": an
    // earlier delivery already parsed it (repeat delivery), nothing to do.
    if (job.status === "cancelled" || url.state !== "fetched") return done(msg, job);

    try {
      await parseAndAdmit(job, url);
    } catch (err) {
      return handleError(msg, job, url, err);
    }
    log(`[parsed] ${url.normalizedUrl}`);
    return done(msg, job);
  };

  async function parseAndAdmit(job, url) {
    await CrawlUrl.updateOne({ _id: url._id }, { $inc: { "parse.attempts": 1 } });
    const html = decode(await deps.blobStore.get(url.rawRef), url.fetch.charset);
    // Relative links resolve against the FINAL url (after redirects).
    const parsed = parse(html, url.fetch.finalUrl ?? url.normalizedUrl);
    const text = await deps.blobStore.putText(parsed.text);
    const outlinks = parsed.links.map((l) => l.url);

    await saveContent(url, text.ref, parsed, outlinks);
    // Links BEFORE the state change. If we crash after this line, the message
    // is redelivered, parsing runs again and admission finds nothing new. In
    // the opposite order, a crash would leave the URL "parsed" with its links
    // never admitted, and no message left to fix it.
    await admitLinks(job, url, parsed.links, queues);
    await transition(CrawlUrl, url._id, "fetched", "parsed", {
      textRef: text.ref,
      title: parsed.title,
      canonicalUrl: parsed.canonicalUrl,
      // No outlinks here: they are stored once, on the Content document
      // (saveContent above), which is what PageRank reads.
      "parse.parsedAt": new Date(),
      "parse.lastError": null,
    });
  }

  async function handleError(msg, job, url, err) {
    await CrawlUrl.updateOne({ _id: url._id }, { $set: { "parse.lastError": err.message } });
    const { dead, delayMs } = await parseQueue.nack(msg, err.message);
    log(`[parse retry] ${url.normalizedUrl} (${err.message}) ${dead ? "-> dead letter" : `in ${delayMs} ms`}`);
    if (dead) {
      await transition(CrawlUrl, url._id, "fetched", "failed");
      await maybeCompleteJob(job._id, queues);
    }
  }
}

/** Remember the parse result under the content hash, for content dedup. */
async function saveContent(url, textRef, parsed, outlinks) {
  try {
    await Content.updateOne(
      { _id: url.contentHash },
      { $setOnInsert: { rawRef: url.rawRef, textRef, title: parsed.title, canonicalUrl: parsed.canonicalUrl, outlinks, firstUrlId: url._id, parsedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err; // two workers parsed identical content at once: fine
  }
}
