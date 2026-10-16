// Fetch ONE URL safely. "Safely" means the remote server cannot make us:
//   - hang forever          -> connect, headers, body-idle and total timeouts
//   - bounce us around      -> redirects followed by hand, max 5, loops detected
//   - fill our memory/disk  -> body streamed and cut off at maxBytes (2 MB)
//   - parse junk            -> only allowed content types (text/html by default)
// The function never throws for network problems: it always returns a result
// object with `ok`, `errorCode` and `error`, so the crawler can record WHY a
// page failed instead of crashing.

import { Agent, request } from "undici";
import { normalizeUrl } from "./normalizeUrl.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const HTML_TYPES = ["text/html", "application/xhtml+xml"];

export const DEFAULT_FETCH_OPTIONS = {
  userAgent: undefined,
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  connectTimeoutMs: 5_000, // TCP + TLS handshake
  headersTimeoutMs: 10_000, // waiting for the status line and headers
  bodyTimeoutMs: 10_000, // max silence between two body chunks
  totalTimeoutMs: 20_000, // whole request, so a server dripping 1 byte/s still stops
  maxRedirects: 5,
  maxBytes: 2 * 1024 * 1024,
  allowedTypes: HTML_TYPES, // null = accept any content type (used for robots.txt)
  beforeRequest: null, // async (url, hop) => null to go on, or a reason string to stop
};

/**
 * Create a fetcher that shares one connection pool (undici Agent).
 * Call close() when done so open keep-alive sockets do not keep Node running.
 */
export function createFetcher(options = {}) {
  const base = { ...DEFAULT_FETCH_OPTIONS, ...options };
  if (!base.userAgent) throw new Error("createFetcher: userAgent is required");
  const agent = new Agent({ connect: { timeout: base.connectTimeoutMs } });

  async function fetchUrl(url, overrides = {}) {
    const opts = { ...base, ...overrides };
    const result = newResult(url);
    try {
      await followChain(result, opts, agent);
    } catch (err) {
      const timedOut = isTimeout(err);
      fail(result, timedOut ? "timeout" : "network", timedOut ? `Timed out: ${err.message}` : err.message);
    }
    result.finishedAt = new Date();
    return result;
  }

  return { fetchUrl, close: () => agent.close() };
}

function newResult(url) {
  return {
    ok: false,
    requestedUrl: url,
    finalUrl: url,
    redirects: [], // every URL we were redirected to, in order
    httpStatus: null,
    contentType: null,
    sizeBytes: 0,
    body: null, // Buffer: the exact bytes, used for the content hash
    text: null, // body decoded to a string, used for parsing
    errorCode: null,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
  };
}

function fail(result, errorCode, error) {
  result.ok = false;
  result.errorCode = errorCode;
  result.error = error;
  return result;
}

/**
 * Follow redirects by hand (instead of letting the HTTP client do it) so every
 * hop can be validated: is it http(s)? have we seen it? is it allowed by
 * robots.txt? is it polite to request it now? (the last two via beforeRequest)
 */
async function followChain(result, opts, agent) {
  const seen = new Set();
  let current = result.requestedUrl;

  for (let hop = 0; ; hop++) {
    seen.add(current);
    const stopReason = opts.beforeRequest ? await opts.beforeRequest(current, hop) : null;
    if (stopReason) return fail(result, "blocked", stopReason);

    const res = await send(current, opts, agent);
    result.finalUrl = current;
    result.httpStatus = res.statusCode;

    const location = firstHeader(res.headers.location);
    if (!REDIRECT_STATUSES.has(res.statusCode) || !location) {
      return readResponse(result, res, opts);
    }
    await res.body.dump(); // we ignore redirect bodies, but must release the socket

    const next = normalizeUrl(location, current);
    if (!next) return fail(result, "bad_redirect", `Invalid redirect target: ${location}`);
    if (seen.has(next)) return fail(result, "redirect_loop", `Redirect loop at ${next}`);
    if (hop + 1 > opts.maxRedirects) {
      return fail(result, "too_many_redirects", `More than ${opts.maxRedirects} redirects`);
    }
    result.redirects.push(next);
    current = next;
  }
}

function send(url, opts, agent) {
  return request(url, {
    method: "GET",
    dispatcher: agent,
    // A fresh total-timeout per hop, started AFTER beforeRequest. Otherwise a
    // long politeness wait (e.g. robots.txt Crawl-delay: 20) would eat the budget.
    signal: AbortSignal.timeout(opts.totalTimeoutMs),
    headersTimeout: opts.headersTimeoutMs,
    bodyTimeout: opts.bodyTimeoutMs,
    // No accept-encoding header: undici does not decompress, so we ask for
    // plain bytes. That also makes maxBytes measure the real page size.
    headers: { "user-agent": opts.userAgent, accept: opts.accept },
  });
}

async function readResponse(result, res, opts) {
  const contentTypeHeader = firstHeader(res.headers["content-type"]) ?? "";
  result.contentType = contentTypeHeader.split(";")[0].trim().toLowerCase() || null;

  if (res.statusCode < 200 || res.statusCode >= 300) {
    await res.body.dump();
    return fail(result, "http_error", `HTTP ${res.statusCode}`);
  }
  if (opts.allowedTypes && !opts.allowedTypes.includes(result.contentType)) {
    await res.body.dump();
    return fail(result, "not_html", `Unsupported content type: ${result.contentType ?? "none"}`);
  }
  // Cheap early exit when the server tells us the size up front...
  if (Number(firstHeader(res.headers["content-length"])) > opts.maxBytes) {
    res.body.destroy();
    return fail(result, "too_large", `Content-Length over ${opts.maxBytes} bytes`);
  }
  // ...but the header can be missing or lie, so we also count while streaming.
  const body = await readCapped(res.body, opts.maxBytes);
  if (!body) return fail(result, "too_large", `Body over ${opts.maxBytes} bytes`);

  result.ok = true;
  result.body = body;
  result.sizeBytes = body.length;
  result.text = decode(body, contentTypeHeader);
  return result;
}

/** Read a stream into one Buffer, or return null (and abort) past maxBytes. */
async function readCapped(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy(); // stop downloading now; do not read the rest
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Decode bytes using the charset from Content-Type, falling back to UTF-8. */
function decode(buffer, contentTypeHeader) {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentTypeHeader)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer); // unknown charset label
  }
}

function isTimeout(err) {
  // AbortSignal.timeout rejects with a "TimeoutError"; undici's own timers use
  // codes like UND_ERR_CONNECT_TIMEOUT / UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT.
  return err?.name === "TimeoutError" || /TIMEOUT/.test(err?.code ?? "");
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}
