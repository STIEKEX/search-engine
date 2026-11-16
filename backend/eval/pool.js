// Step 1 of the evaluation: build the pool of pages to label.
//
// Pooling (as in TREC): for every query, take the top 10 of EVERY method and
// label the union. Then each method's top 10 is fully judged, and no method
// is favoured by being the only one whose results were looked at.
// The pool is sorted by title, with no rank or method shown, so labeling
// cannot be biased toward one method.
//
// Run: npm run eval:pool   -> writes eval/pool.json
// Then fill eval/judgments.json (2 = very relevant, 1 = somewhat, 0 = not).

import dns from "node:dns";
import { readFile, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import connectDb from "../server/config/db.js";
import { createIndexCache } from "../server/lib/indexCache.js";
import { METHODS, topUrls } from "./methods.js";

const here = (file) => new URL(file, import.meta.url);

async function main() {
  dns.setServers(["8.8.8.8", "1.1.1.1"]); // same reason as server/server.js
  await connectDb(process.env.MONGODB_URI);
  const queries = JSON.parse(await readFile(here("./queries.json"), "utf8"));
  const deps = { indexCache: createIndexCache(), blobStore: null };

  const pool = [];
  for (const q of queries) {
    const byUrl = new Map();
    for (const method of METHODS) {
      for (const r of await topUrls(q.query, method, deps)) byUrl.set(r.url, r.title);
    }
    const pages = [...byUrl].map(([url, title]) => ({ url, title })).sort((a, b) => a.title.localeCompare(b.title));
    pool.push({ ...q, pages });
    console.log(`${q.id}. ${q.query}: ${pages.length} pages to label`);
  }
  await writeFile(here("./pool.json"), `${JSON.stringify(pool, null, 2)}\n`);
  console.log(`\nWrote eval/pool.json (${pool.reduce((n, q) => n + q.pages.length, 0)} pages in total)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
