// Entry point: npm run worker:parse
// Parsing needs no network, so it scales separately from fetching: run more
// parse workers if the parse queue grows, more fetch workers if fetch does.

import { runWorkerProcess } from "./bootstrap.js";
import { createParseHandler } from "./parseHandler.js";

runWorkerProcess("parse", createParseHandler).catch((err) => {
  console.error(`Parse worker failed to start: ${err.message}`);
  process.exit(1);
});
