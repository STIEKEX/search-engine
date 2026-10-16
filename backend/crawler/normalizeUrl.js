// URL normalization: turn the many spellings of one address into ONE string,
// so the visited set and the unique index in MongoDB can recognise duplicates.
//
//   "HTTPS://Books.ToScrape.com:443/a/../index.html#top"
//   -> "https://books.toscrape.com/index.html"
//
// Most of the work is done by the WHATWG URL parser (new URL), which already:
//   - lowercases the scheme and host (they are case-insensitive by spec),
//   - drops the default port (:80 for http, :443 for https),
//   - resolves "." and ".." path segments,
//   - percent-encodes characters that are not allowed in a URL.
// We add the rules it does not apply on its own (see below).

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Normalize `href` (absolute or relative) against an optional `base` URL.
 * Returns the normalized absolute URL string, or null if the input is not a
 * crawlable http(s) URL.
 *
 * Trailing-slash policy (documented on purpose, because it is a judgement call):
 *   - an EMPTY path becomes "/":   "http://a.com"  -> "http://a.com/"
 *     (the URL parser does this; both forms are the same request on the wire)
 *   - any other path is left alone: "/books" and "/books/" stay DIFFERENT.
 *     A server is allowed to return different pages for them, so merging
 *     them could silently lose content. Duplicates that slip through are
 *     cheap; wrongly merged pages are invisible.
 *
 * Query strings are kept exactly as written (no reordering, nothing dropped),
 * because "?page=2" and "?page=1" are different pages.
 */
export function normalizeUrl(href, base) {
  if (typeof href !== "string" || href.trim() === "") return null;

  let url;
  try {
    // With a base, relative links like "../a.html" or "?page=2" are resolved
    // the same way a browser resolves them.
    url = base ? new URL(href, base) : new URL(href);
  } catch {
    return null; // malformed: "http://", "ht!tp://x", a relative link with no base...
  }

  // mailto:, javascript:, ftp:, data: ... are not web pages we can fetch.
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;

  // The fragment (#section) is never sent to the server: /a and /a#top are
  // the same document, so keep only one.
  url.hash = "";

  // A lone "?" with no parameters is the same request as no "?" at all.
  // Assigning "" removes it; non-empty queries are left untouched.
  if (url.search === "") url.search = "";

  return url.href;
}

/** Host (hostname plus non-default port) of an already normalized URL. */
export function hostOf(normalizedUrl) {
  return new URL(normalizedUrl).host;
}
