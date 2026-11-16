// Relevance labels are about PAGES, but judgments.json stores them under the
// URL a result showed when it was labeled. When the indexer later shows that
// page under another URL (its canonical URL: /wiki/Vault -> /wiki/Vault_(architecture)),
// the label must follow the page, or a correct result looks "unjudged" and
// counts as irrelevant. This file moves each label to the URL the page has now.

import CrawlUrl from "../server/models/CrawlUrl.js";
import Content from "../server/models/Content.js";
import { pageUrl } from "../indexer/buildIndex.js";

/**
 * Move labels to current page URLs.
 * When several labeled URLs are now ONE page, the label given to the page's
 * own (canonical) URL wins; otherwise the highest label. (Aliases show the
 * same title as the article, so their labels normally agree anyway.)
 *
 * @param {Map<string, number>} labels  labeled URL -> 0 | 1 | 2
 * @param {Map<string, string>} pageUrlOf  labeled URL -> the page's URL now
 *   (URLs missing from the map are kept as they are)
 * @returns {Map<string, number>} page URL -> label
 */
export function resolveLabels(labels, pageUrlOf) {
  const resolved = new Map();
  const direct = new Set(); // page URLs that were labeled under their own URL
  for (const [url, label] of labels) {
    const page = pageUrlOf.get(url) ?? url;
    const isDirect = page === url;
    if (direct.has(page) && !isDirect) continue; // the page's own label wins
    if (isDirect || !resolved.has(page)) {
      resolved.set(page, label);
    } else {
      resolved.set(page, Math.max(resolved.get(page), label));
    }
    if (isDirect) direct.add(page);
  }
  return resolved;
}

/**
 * For each URL: the URL its page is shown under now, using the indexer's own
 * rule (pageUrl), so evaluation and index can't disagree.
 * @param {string[]} urls
 * @returns {Promise<Map<string, string>>}
 */
export async function loadPageUrls(urls) {
  const records = await CrawlUrl.find(
    { $or: [{ normalizedUrl: { $in: urls } }, { "fetch.finalUrl": { $in: urls } }], contentHash: { $ne: null } },
    { normalizedUrl: 1, "fetch.finalUrl": 1, contentHash: 1 },
  ).lean();
  const contents = new Map((await Content.find({ _id: { $in: records.map((r) => r.contentHash) } }, { canonicalUrl: 1 }).lean()).map((c) => [c._id, c]));
  const wanted = new Set(urls);
  const result = new Map();
  for (const r of records) {
    const page = pageUrl(contents.get(r.contentHash) ?? {}, r.fetch?.finalUrl ?? r.normalizedUrl);
    for (const u of [r.normalizedUrl, r.fetch?.finalUrl]) if (u && wanted.has(u) && page) result.set(u, page);
  }
  return result;
}
