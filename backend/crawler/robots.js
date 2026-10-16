// robots.txt: a site's instructions to crawlers, e.g.
//
//   User-agent: *
//   Disallow: /private/
//   Crawl-delay: 2
//
// means "every bot: stay out of /private/ and wait 2 s between requests".
// We download it once per origin, cache it (memory + Domain collection, 24 h),
// and check every URL against it BEFORE fetching that URL.

import robotsParser from "robots-parser";
import Domain from "../server/models/Domain.js";

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
// A host whose robots.txt failed is retried sooner: the outage may be brief,
// and until then we simply skip that host.
const UNREACHABLE_TTL_MS = 10 * 60 * 1000;
// RFC 9309 lets crawlers stop reading robots.txt after 500 KiB.
const ROBOTS_MAX_BYTES = 500 * 1024;

/**
 * @param {object} deps
 * @param {object} deps.fetcher     from createFetcher()
 * @param {object} deps.politeness  from createPoliteness(): robots.txt is a request too
 * @param {string} deps.userAgent   full User-Agent header value
 */
export function createRobots({ fetcher, politeness, userAgent, ttlMs = ROBOTS_TTL_MS, DomainModel = Domain, now = () => new Date() }) {
  // robots.txt groups are matched by the bot's name only ("minisearchbot"),
  // not the whole header with version and contact details.
  const botName = userAgent.split(/[\s/]/)[0];
  const memory = new Map(); // origin -> { status, robot, crawlDelayMs, expiresAt }

  /** Is `url` allowed? Returns { allowed, reason, crawlDelayMs }. */
  async function check(url) {
    const rules = await getRules(new URL(url).origin);
    if (rules.status === "unreachable") {
      return { allowed: false, reason: "robots_unreachable", crawlDelayMs: 0 };
    }
    // isAllowed returns undefined for a URL from another origin; treat
    // anything other than an explicit true as "not allowed".
    const allowed = rules.robot.isAllowed(url, botName) === true;
    return { allowed, reason: allowed ? null : "robots_disallowed", crawlDelayMs: rules.crawlDelayMs };
  }

  async function getRules(origin) {
    const cached = memory.get(origin);
    if (cached && cached.expiresAt > now()) return cached;

    let doc = await DomainModel.findOne({ origin }).lean();
    if (!doc || doc.expiresAt <= now()) doc = await refresh(origin);

    const rules = {
      status: doc.robotsStatus,
      robot: robotsParser(`${origin}/robots.txt`, doc.robotsTxt ?? ""),
      crawlDelayMs: (doc.crawlDelaySec ?? 0) * 1000,
      expiresAt: doc.expiresAt,
    };
    memory.set(origin, rules);
    return rules;
  }

  /** Download robots.txt, classify the outcome and save it to the Domain cache. */
  async function refresh(origin) {
    const res = await fetcher.fetchUrl(`${origin}/robots.txt`, {
      allowedTypes: null, // servers label robots.txt inconsistently; accept any type
      maxBytes: ROBOTS_MAX_BYTES,
      accept: "text/plain,*/*;q=0.1",
      beforeRequest: async (hopUrl) => {
        await politeness.waitTurn(new URL(hopUrl).host);
        return null;
      },
    });
    const outcome = classify(res);
    const crawlDelay = Number(robotsParser(`${origin}/robots.txt`, outcome.robotsTxt).getCrawlDelay(botName));
    const fetchedAt = now();
    const ttl = outcome.robotsStatus === "unreachable" ? UNREACHABLE_TTL_MS : ttlMs;
    const doc = {
      origin,
      host: new URL(origin).host,
      ...outcome,
      crawlDelaySec: Number.isFinite(crawlDelay) && crawlDelay > 0 ? crawlDelay : null,
      fetchedAt,
      expiresAt: new Date(fetchedAt.getTime() + ttl),
    };
    await DomainModel.updateOne({ origin }, { $set: doc }, { upsert: true });
    return doc;
  }

  return { check };
}

/** Map a fetch result to a robots status, following RFC 9309 section 2.3.1. */
function classify(res) {
  const base = { robotsHttpStatus: res.httpStatus, robotsTxt: "", error: null };
  if (res.ok) return { ...base, robotsStatus: "ok", robotsTxt: res.text };

  const status = res.httpStatus;
  // 4xx (404 Not Found, 403, 410...) means "no robots.txt here": allow all.
  // 429 Too Many Requests is the exception: the server is overloaded.
  if (res.errorCode === "http_error" && status >= 400 && status < 500 && status !== 429) {
    return { ...base, robotsStatus: "allow-all" };
  }
  // 5xx, 429, timeouts, DNS/network errors, oversized file: rules unknown.
  return { ...base, robotsStatus: "unreachable", error: res.error };
}
