import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createFetcher } from "../../crawler/fetcher.js";
import { startMockServer } from "../helpers/mockServer.js";

const USER_AGENT = "MiniSearchBot/0.1 (+mailto:test@example.com)";
let server;
let fetcher;

before(async () => {
  server = await startMockServer();
  // Short timeouts so the timeout test finishes quickly.
  fetcher = createFetcher({ userAgent: USER_AGENT, totalTimeoutMs: 500, headersTimeoutMs: 500, bodyTimeoutMs: 500 });
});

after(async () => {
  await fetcher.close();
  await server.close();
});

test("fetches an HTML page and records status, type, size and body", async () => {
  const res = await fetcher.fetchUrl(server.url("/about.html"));
  assert.equal(res.ok, true);
  assert.equal(res.httpStatus, 200);
  assert.equal(res.contentType, "text/html");
  assert.equal(res.sizeBytes, res.body.length);
  assert.match(res.text, /About Us/);
  assert.ok(res.finishedAt >= res.startedAt);
});

test("sends our User-Agent", async () => {
  await fetcher.fetchUrl(server.url("/about.html"));
  assert.equal(server.requests.at(-1).userAgent, USER_AGENT);
});

test("404 is a failure with the status recorded", async () => {
  const res = await fetcher.fetchUrl(server.url("/status/404"));
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "http_error");
  assert.equal(res.httpStatus, 404);
});

test("500 is a failure with the status recorded", async () => {
  const res = await fetcher.fetchUrl(server.url("/status/500"));
  assert.equal(res.errorCode, "http_error");
  assert.equal(res.httpStatus, 500);
});

test("a server that stops sending times out instead of hanging", async () => {
  const started = Date.now();
  const res = await fetcher.fetchUrl(server.url("/slow"));
  assert.equal(res.errorCode, "timeout");
  assert.ok(Date.now() - started < 3000, "should give up quickly");
});

test("connection refused is a network error, not a crash", async () => {
  const closed = await startMockServer();
  const url = closed.url("/");
  await closed.close();
  const res = await fetcher.fetchUrl(url);
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, "network");
});

test("follows a redirect and records the final URL", async () => {
  const res = await fetcher.fetchUrl(server.url("/moved"));
  assert.equal(res.ok, true);
  assert.equal(res.finalUrl, server.url("/about.html"));
  assert.deepEqual(res.redirects, [server.url("/about.html")]);
});

test("detects a redirect loop", async () => {
  const res = await fetcher.fetchUrl(server.url("/loop-a"));
  assert.equal(res.errorCode, "redirect_loop");
});

test("allows exactly 5 redirects", async () => {
  const res = await fetcher.fetchUrl(server.url("/chain/5"));
  assert.equal(res.ok, true);
  assert.equal(res.redirects.length, 5);
});

test("stops after more than 5 redirects", async () => {
  const res = await fetcher.fetchUrl(server.url("/chain/6"));
  assert.equal(res.errorCode, "too_many_redirects");
});

test("rejects a redirect to a non-http URL", async () => {
  const res = await fetcher.fetchUrl(server.url("/bad-redirect"));
  assert.equal(res.errorCode, "bad_redirect");
});

test("aborts a streamed body that grows past maxBytes", async () => {
  const res = await fetcher.fetchUrl(server.url("/big"), { maxBytes: 1024 * 1024 });
  assert.equal(res.errorCode, "too_large");
  assert.equal(res.body, null);
});

test("refuses early when Content-Length is over maxBytes", async () => {
  const res = await fetcher.fetchUrl(server.url("/big-declared"), { maxBytes: 1024 * 1024 });
  assert.equal(res.errorCode, "too_large");
});

test("skips non-HTML content types without parsing them", async () => {
  const res = await fetcher.fetchUrl(server.url("/image.png"));
  assert.equal(res.errorCode, "not_html");
  assert.equal(res.contentType, "image/png");
});

test("beforeRequest runs for every hop and can stop the fetch", async () => {
  const seen = [];
  const res = await fetcher.fetchUrl(server.url("/chain/2"), {
    beforeRequest: async (url, hop) => {
      seen.push(hop);
      return hop === 2 ? "not allowed" : null;
    },
  });
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal(res.errorCode, "blocked");
  assert.equal(res.error, "not allowed");
});
