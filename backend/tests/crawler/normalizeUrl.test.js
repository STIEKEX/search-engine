import { test } from "node:test";
import assert from "node:assert/strict";
import { hostOf, normalizeUrl } from "../../crawler/normalizeUrl.js";

const BASE = "https://books.toscrape.com/catalogue/page-1.html";

// [description, input href, base, expected]
const CASES = [
  ["lowercases scheme and host", "HTTPS://Books.ToScrape.COM/Index.html", undefined, "https://books.toscrape.com/Index.html"],
  ["keeps path case (paths are case-sensitive)", "https://a.com/About", undefined, "https://a.com/About"],
  ["removes the fragment", "https://a.com/page#section-2", undefined, "https://a.com/page"],
  ["removes default https port", "https://a.com:443/x", undefined, "https://a.com/x"],
  ["removes default http port", "http://a.com:80/x", undefined, "http://a.com/x"],
  ["keeps non-default port", "http://a.com:8080/x", undefined, "http://a.com:8080/x"],
  ["adds / to an empty path", "https://a.com", undefined, "https://a.com/"],
  ["keeps trailing slash difference", "https://a.com/books/", undefined, "https://a.com/books/"],
  ["keeps no-trailing-slash difference", "https://a.com/books", undefined, "https://a.com/books"],
  ["resolves a sibling relative link", "page-2.html", BASE, "https://books.toscrape.com/catalogue/page-2.html"],
  ["resolves ../ against the base", "../index.html", BASE, "https://books.toscrape.com/index.html"],
  ["resolves a root-relative link", "/static/x.html", BASE, "https://books.toscrape.com/static/x.html"],
  ["resolves a protocol-relative link", "//cdn.example.com/a", BASE, "https://cdn.example.com/a"],
  ["resolves a fragment-only link to the base page", "#top", BASE, BASE],
  ["keeps query parameter order", "https://a.com/s?b=2&a=1", undefined, "https://a.com/s?b=2&a=1"],
  ["drops a lone '?'", "https://a.com/s?", undefined, "https://a.com/s"],
  ["resolves dot segments", "https://a.com/a/./b/../c", undefined, "https://a.com/a/c"],
  ["trims surrounding whitespace", "  https://a.com/x  ", undefined, "https://a.com/x"],
];

for (const [description, href, base, expected] of CASES) {
  test(`normalizeUrl ${description}`, () => {
    assert.equal(normalizeUrl(href, base), expected);
  });
}

const REJECTED = [
  ["mailto:", "mailto:someone@example.com"],
  ["javascript:", "javascript:void(0)"],
  ["ftp:", "ftp://files.example.com/a.txt"],
  ["data:", "data:text/html,<h1>hi</h1>"],
  ["a missing host", "http://"],
  ["garbage", "ht!tp://%%%"],
  ["a relative link without a base", "page-2.html"],
  ["an empty string", ""],
  ["non-string input", undefined],
];

for (const [description, href] of REJECTED) {
  test(`normalizeUrl rejects ${description}`, () => {
    assert.equal(normalizeUrl(href), null);
  });
}

test("normalizeUrl is idempotent: normalizing twice changes nothing", () => {
  const once = normalizeUrl("HTTP://A.com:80/x/../y?q=1#f");
  assert.equal(normalizeUrl(once), once);
});

test("hostOf includes a non-default port", () => {
  assert.equal(hostOf("http://127.0.0.1:5000/a"), "127.0.0.1:5000");
  assert.equal(hostOf("https://a.com/"), "a.com");
});
