// Entry point: npm run worker:fetch
// Run as many of these processes as you like; MongoDB leases keep them from
// taking the same message, and HostSlot keeps them polite together.

import { runWorkerProcess } from "./bootstrap.js";
import { createFetchHandler } from "./fetchHandler.js";

runWorkerProcess("fetch", createFetchHandler).catch((err) => {
  console.error(`Fetch worker failed to start: ${err.message}`);
  process.exit(1);
});
