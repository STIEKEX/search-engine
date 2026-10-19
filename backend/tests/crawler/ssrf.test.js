import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createFetcher } from "../../crawler/fetcher.js";
import { isBlockedAddress } from "../../crawler/ssrf.js";
import { startMockServer } from "../helpers/mockServer.js";

const USER_AGENT = "MiniSearchBot/0.1 (+mailto:test@example.com)";
let server;
let fetcher; // SSRF protection ON, as in production

before(async () => {
  server = await startMockServer({
    // A "public" page that redirects into the private network.
    "/to-private": (req, res) => res.writeHead(302, { location: "http://10.0.0.1/admin" }).end(),
  });
  fetcher = createFetcher({ userAgent: USER_AGENT, totalTimeoutMs: 2000 });
});
after(async () => {
  await fetcher.close();
  await server.close();
});

const BLOCKED = [
  "127.0.0.1", "127.5.5.5", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
  "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:10.0.0.1", "[::1]", "not-an-ip",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"];

for (const ip of BLOCKED) test(`isBlockedAddress blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
for (const ip of ALLOWED) test(`isBlockedAddress allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));

test("an IP-literal URL to a private address is refused before any request", async () => {
  for (const url of ["http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
    const res = await fetcher.fetchUrl(url);
    assert.equal(res.errorCode, "ssrf_blocked", url);
  }
});

test("the local mock server (127.0.0.1) is refused, and receives no request", async () => {
  const before = server.requests.length;
  const res = await fetcher.fetchUrl(server.url("/about.html"));
  assert.equal(res.errorCode, "ssrf_blocked");
  assert.equal(server.requests.length, before);
});

test("'localhost' is refused because it RESOLVES to a loopback address", async () => {
  const port = new URL(server.origin).port;
  const res = await fetcher.fetchUrl(`http://localhost:${port}/about.html`);
  assert.equal(res.errorCode, "ssrf_blocked", res.error);
});

test("a hostname whose DNS answer is private is refused", async () => {
  const evilDns = createFetcher({
    userAgent: USER_AGENT,
    ssrf: { lookup: (host, opts, cb) => cb(null, [{ address: "10.0.0.7", family: 4 }]) },
  });
  const res = await evilDns.fetchUrl("http://innocent-looking.example/");
  await evilDns.close();
  assert.equal(res.errorCode, "ssrf_blocked");
  assert.match(res.error, /10\.0\.0\.7/);
});

test("a DNS answer mixing public and private addresses is refused", async () => {
  const mixed = createFetcher({
    userAgent: USER_AGENT,
    ssrf: { lookup: (host, opts, cb) => cb(null, [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) },
  });
  const res = await mixed.fetchUrl("http://mixed.example/");
  await mixed.close();
  assert.equal(res.errorCode, "ssrf_blocked");
});

test("the socket connects to exactly the address our lookup validated", async () => {
  // Policy for this test: only 10.x is "private". Our lookup answers
  // 127.0.0.1 for a made-up name, so reaching the mock server proves the
  // connection used the checked answer (no second, unchecked DNS query).
  const port = new URL(server.origin).port;
  const pinned = createFetcher({
    userAgent: USER_AGENT,
    ssrf: { isBlocked: (ip) => ip.startsWith("10."), lookup: (host, opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]) },
  });
  const res = await pinned.fetchUrl(`http://made-up-name.test:${port}/about.html`);
  await pinned.close();
  assert.equal(res.ok, true, res.error);
});

test("a redirect into a private address is re-validated and refused", async () => {
  const hopChecked = createFetcher({ userAgent: USER_AGENT, ssrf: { isBlocked: (ip) => ip.startsWith("10.") } });
  const res = await hopChecked.fetchUrl(server.url("/to-private"));
  await hopChecked.close();
  assert.equal(res.errorCode, "ssrf_blocked");
  assert.deepEqual(res.redirects, ["http://10.0.0.1/admin"]);
});

test("allowPrivateNetworks: true (tests only) lets the mock server through", async () => {
  const open = createFetcher({ userAgent: USER_AGENT, allowPrivateNetworks: true });
  const res = await open.fetchUrl(server.url("/about.html"));
  await open.close();
  assert.equal(res.ok, true);
});
