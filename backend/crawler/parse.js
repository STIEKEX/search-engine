// Turn one HTML page into the four things the rest of the engine needs:
//   title         -> shown in results, and a strong relevance signal
//   canonicalUrl  -> the URL the site says is the "real" one for this content
//   text          -> readable words only, later fed to the tokenizer/indexer
//   links         -> outgoing links: the crawl frontier now, the PageRank graph later

import * as cheerio from "cheerio";
import { normalizeUrl } from "./normalizeUrl.js";

// Elements whose text is not part of the page's main content.
// script/style/noscript/template/svg are not readable text at all;
// nav/header/footer/aside are repeated on every page of a site, and indexing
// them would make every page match words like "Home" or "Contact".
const BOILERPLATE = "script, style, noscript, template, svg, nav, header, footer, aside";

// Block elements start a new line visually. When we read text out of the DOM
// we put a space around them, otherwise "<p>cat</p><p>dog</p>" becomes "catdog".
const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p",
  "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * @param {string} html     page source
 * @param {string} pageUrl  normalized final URL of the page (base for relative links)
 * @returns {{ title: string, canonicalUrl: string|null, text: string,
 *             links: Array<{ url: string, href: string }> }}
 */
export function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  // <base href="..."> changes what relative links are relative to.
  const baseUrl = normalizeUrl($("base[href]").first().attr("href"), pageUrl) ?? pageUrl;

  // Order matters: collect links BEFORE removing nav/header/footer, because
  // navigation links are real links between pages (they matter for PageRank).
  const links = extractLinks($, baseUrl);
  const title = cleanSpaces($("title").first().text());
  const canonicalUrl = normalizeUrl($('link[rel~="canonical"]').first().attr("href"), baseUrl);
  const text = extractText($);

  return { title, canonicalUrl, text, links };
}

/** All crawlable <a href> links, normalized, first occurrence wins. */
function extractLinks($, baseUrl) {
  const byUrl = new Map();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href").trim();
    const url = normalizeUrl(href, baseUrl); // null for mailto:, javascript:, garbage
    if (url && !byUrl.has(url)) byUrl.set(url, { url, href });
  });
  return [...byUrl.values()];
}

/** Readable text of <main> if the page has one, otherwise of <body>. */
function extractText($) {
  $(BOILERPLATE).remove();
  const root = $("main").get(0) ?? $("body").get(0) ?? $.root().get(0);
  const parts = [];
  collectText(root, parts);
  return cleanSpaces(parts.join(""));
}

function collectText(node, parts) {
  if (node.type === "text") {
    parts.push(node.data);
    return;
  }
  // Only descend into elements and the document root; this skips comments
  // and any <script>/<style> nodes (cheerio types those separately).
  if (node.type !== "tag" && node.type !== "root") return;
  const isBlock = BLOCK_TAGS.has(node.name);
  if (isBlock) parts.push(" ");
  for (const child of node.children) collectText(child, parts);
  if (isBlock) parts.push(" ");
}

function cleanSpaces(s) {
  return s.replace(/\s+/g, " ").trim();
}
