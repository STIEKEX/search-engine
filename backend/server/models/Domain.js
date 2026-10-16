import mongoose from "mongoose";

// One document per origin ("https://books.toscrape.com"), caching what we
// learned from its robots.txt so we do not download it before every page.
//
// Why origin and not host? The robots.txt standard (RFC 9309) says the rules
// at https://a.com/robots.txt apply only to https://a.com, not http://a.com
// or https://a.com:8443, so scheme and port are part of the key.
//
// robotsStatus:
//   "ok"          robots.txt fetched (2xx); rules in robotsTxt apply
//   "allow-all"   robots.txt missing (4xx): the convention is "no rules"
//   "unreachable" network error, 5xx or 429: we cannot know the rules, so we
//                 must not crawl this host (being unsure is not permission)
export const ROBOTS_STATUSES = ["ok", "allow-all", "unreachable"];

const domainSchema = new mongoose.Schema(
  {
    origin: { type: String, required: true, unique: true },
    host: { type: String, required: true, index: true },
    robotsStatus: { type: String, enum: ROBOTS_STATUSES, required: true },
    robotsHttpStatus: { type: Number, default: null },
    robotsTxt: { type: String, default: "" },
    crawlDelaySec: { type: Number, default: null }, // from "Crawl-delay:", if any
    error: { type: String, default: null },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, // after this, fetch robots.txt again
  },
  { versionKey: false },
);

export default mongoose.model("Domain", domainSchema);
