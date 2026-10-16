import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage } from "../../crawler/parse.js";

const PAGE_URL = "https://shop.example.com/catalogue/item/index.html";

const HTML = `<!doctype html>
<html>
<head>
  <title>
    A Light in the Attic
  </title>
  <link rel="canonical" href="/catalogue/a-light-in-the-attic/">
  <style>.price { color: red }</style>
  <script>var tracking = "do not index me";</script>
</head>
<body>
  <header>Site Header Text</header>
  <nav><a href="/">Home</a> <a href="../../index.html#top">Home again</a></nav>
  <div><p>First paragraph.</p><p>Second paragraph.</p></div>
  <p>Price: <b>£51.77</b></p>
  <a href="../page-2.html">Next</a>
  <a href="mailto:shop@example.com">Mail us</a>
  <a href="javascript:void(0)">Do something</a>
  <a href="https://other.example.org/x">Other site</a>
  <a href="">Empty link</a>
  <aside>Sidebar text</aside>
  <footer>Footer text</footer>
  <script>console.log("also not text")</script>
  <!-- a comment -->
</body>
</html>`;

test("parsePage extracts and trims the title", () => {
  assert.equal(parsePage(HTML, PAGE_URL).title, "A Light in the Attic");
});

test("parsePage removes scripts, styles, nav, header, footer, aside and comments", () => {
  const { text } = parsePage(HTML, PAGE_URL);
  for (const unwanted of ["tracking", "color", "Site Header", "Home", "Sidebar", "Footer", "also not text", "a comment"]) {
    assert.ok(!text.includes(unwanted), `text should not contain "${unwanted}": ${text}`);
  }
  assert.ok(text.includes("Price: £51.77"), text);
});

test("parsePage keeps words from separate blocks apart", () => {
  const { text } = parsePage(HTML, PAGE_URL);
  assert.ok(text.includes("First paragraph. Second paragraph."), text);
});

test("parsePage resolves relative links, drops non-http links and duplicates", () => {
  const urls = parsePage(HTML, PAGE_URL).links.map((l) => l.url);
  assert.deepEqual(urls, [
    "https://shop.example.com/", // from the nav: links are taken before nav is removed
    "https://shop.example.com/index.html",
    "https://shop.example.com/catalogue/page-2.html",
    "https://other.example.org/x",
    // href="" (a link to this same page) is dropped: it adds nothing to crawl.
  ]);
});

test("parsePage keeps the original href next to the normalized url", () => {
  const next = parsePage(HTML, PAGE_URL).links.find((l) => l.href === "../page-2.html");
  assert.equal(next.url, "https://shop.example.com/catalogue/page-2.html");
});

test("parsePage resolves the canonical URL", () => {
  assert.equal(parsePage(HTML, PAGE_URL).canonicalUrl, "https://shop.example.com/catalogue/a-light-in-the-attic/");
});

test("parsePage returns null canonical and empty title when missing", () => {
  const result = parsePage("<p>hi</p>", PAGE_URL);
  assert.equal(result.canonicalUrl, null);
  assert.equal(result.title, "");
  assert.equal(result.text, "hi");
});

test("parsePage resolves links against <base href>", () => {
  const html = `<head><base href="https://cdn.example.com/docs/"></head><body><a href="intro.html">x</a></body>`;
  assert.equal(parsePage(html, PAGE_URL).links[0].url, "https://cdn.example.com/docs/intro.html");
});

test("parsePage prefers <main> text when the page has one", () => {
  const html = `<body><div>Cookie banner</div><main><p>The article.</p></main></body>`;
  assert.equal(parsePage(html, PAGE_URL).text, "The article.");
});
