// SSRF (Server-Side Request Forgery) protection.
//
// The danger: our crawler follows URLs that strangers write. A page could link
// to http://127.0.0.1:27017/ (our own MongoDB), http://192.168.1.1/ (the
// router) or http://169.254.169.254/ (the cloud metadata service, which hands
// out credentials). The crawler would then attack our own network for them.
//
// The defence has two parts:
//   1. IP-literal URLs (http://10.0.0.1/) are checked before any connection.
//   2. Hostnames are checked INSIDE the DNS lookup that the socket itself
//      uses. Checking with a separate dns.lookup() first is not enough: the
//      attacker's DNS server can answer "1.2.3.4" to our check and
//      "127.0.0.1" a moment later to the real connection (DNS rebinding).
//      Because we validate the exact answer the socket connects to, there is
//      no gap between "checked" and "used".
// Every redirect hop goes through the same two checks.

import dns from "node:dns";
import net from "node:net";

// [network, prefix length, why it is blocked]
const BLOCKED_IPV4 = [
  ["0.0.0.0", 8, "unspecified / 'this network'"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT (CGNAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local, incl. cloud metadata 169.254.169.254"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved, incl. broadcast 255.255.255.255"],
];
const BLOCKED_IPV6 = [
  ["::", 96, "unspecified, loopback ::1 and deprecated IPv4-compatible"],
  ["fc00::", 7, "unique local, incl. AWS metadata fd00:ec2::254"],
  ["fe80::", 10, "link-local"],
  ["ff00::", 8, "multicast"],
];

const blockList = new net.BlockList();
for (const [network, prefix] of BLOCKED_IPV4) blockList.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_IPV6) blockList.addSubnet(network, prefix, "ipv6");

/**
 * True if `ip` is an address the crawler must never connect to.
 * IPv4-mapped IPv6 (::ffff:127.0.0.1) is matched against the IPv4 rules by
 * net.BlockList itself, so that disguise does not work.
 */
export function isBlockedAddress(ip) {
  const bare = ip.replace(/^\[|\]$/g, ""); // URL hostnames wrap IPv6 in [ ]
  const family = net.isIP(bare);
  if (family === 0) return true; // not an IP at all: refuse rather than guess
  return blockList.check(bare, family === 6 ? "ipv6" : "ipv4");
}

export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.code = "ERR_SSRF_BLOCKED";
  }
}

/**
 * @param {object}   opts
 * @param {boolean}  opts.allowPrivateNetworks  true ONLY in tests that crawl a local mock server
 * @param {Function} opts.isBlocked             address policy (injectable for tests)
 * @param {Function} opts.lookup                DNS resolver with dns.lookup's signature (injectable)
 */
export function createSsrfGuard({ allowPrivateNetworks = false, isBlocked = isBlockedAddress, lookup = dns.lookup } = {}) {
  /** Reason string if this URL must not be requested, else null. */
  function checkUrl(url) {
    if (allowPrivateNetworks) return null;
    const { hostname } = new URL(url);
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bare) && isBlocked(bare)) return `Blocked address ${bare}`;
    return null; // hostnames are checked at connect time by guardedLookup
  }

  /** Drop-in replacement for dns.lookup, given to the HTTP client's sockets. */
  function guardedLookup(hostname, options, callback) {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      // Refuse if ANY answer is blocked: mixing a public and a private answer
      // is a known trick, and the socket may try either of them.
      const bad = addresses.find((a) => isBlocked(a.address));
      if (bad) return callback(new SsrfError(`${hostname} resolves to blocked address ${bad.address}`));
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  }

  return { checkUrl, lookup: allowPrivateNetworks ? null : guardedLookup };
}
