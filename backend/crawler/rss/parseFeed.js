// Read an RSS feed (XML) into plain items.
//
// Why RSS for Medium: its article pages answer bots with "403 Forbidden",
// but its RSS feeds are public and made for automated readers. An AUTHOR
// feed (medium.com/feed/@someone) carries each recent article's full HTML in
// <content:encoded>; a TAG feed (medium.com/feed/tag/x) carries titles and
// links only, which is enough to discover authors.
//
//   <item>
//     <title><![CDATA[Software 2.0]]></title>
//     <link>https://medium.com/@karpathy/software-2-0-a64152b37c35?source=rss...</link>
//     <dc:creator><![CDATA[Andrej Karpathy]]></dc:creator>
//     <content:encoded><![CDATA[<p>I sometimes see people...</p>]]></content:encoded>
//   </item>

import * as cheerio from "cheerio";

/**
 * @param {string} xml
 * @returns {Array<{ title: string, link: string, author: string, published: Date|null,
 *                   categories: string[], contentHtml: string }>}
 */
export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xml: true });
  return $("item")
    .map((_, el) => {
      const item = $(el);
      const published = new Date(childText($, item, "pubDate"));
      return {
        title: childText($, item, "title").trim(),
        link: childText($, item, "link").trim(),
        author: childText($, item, "dc:creator").trim(),
        published: Number.isNaN(published.getTime()) ? null : published,
        categories: childrenNamed(item, "category").map((c) => $(c).text().trim()),
        contentHtml: childText($, item, "content:encoded"), // "" when the feed has no full text
      };
    })
    .get();
}

// Namespaced tags such as dc:creator cannot be written as CSS selectors
// ("dc:creator" would mean an element "dc" with a pseudo-class), so match
// child elements by their exact name instead.
function childrenNamed(item, name) {
  return item.children().filter((_, child) => child.name === name).get();
}

function childText($, item, name) {
  const [first] = childrenNamed(item, name);
  return first ? $(first).text() : ""; // .text() includes CDATA content
}

/**
 * The feed that lists an article's author or publication, from the article's link:
 *   https://medium.com/@alice/post-abc123  -> https://medium.com/feed/@alice
 *   https://medium.com/better-programming/post-abc -> https://medium.com/feed/better-programming
 * Returns null for links that are neither (e.g. the home page).
 */
export function sourceFeedOf(articleLink, baseUrl = "https://medium.com") {
  let url;
  try {
    url = new URL(articleLink);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin) return null; // custom domains: not handled
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (!first || !second) return null; // an article link has /<owner>/<slug>
  return `${baseUrl}/feed/${first}`;
}

/** Article URL without Medium's tracking query (?source=rss-...): one URL per article. */
export function cleanArticleUrl(link) {
  const url = new URL(link);
  url.search = "";
  url.hash = "";
  return url.href;
}
