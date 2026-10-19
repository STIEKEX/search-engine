import express from "express";
import { createQueues, readConfig } from "../crawler/config.js";
import { LocalBlobStore } from "../crawler/storage/LocalBlobStore.js";
import healthRouter from "./routes/health.js";
import jobsRouter from "./routes/jobs.js";
import pagesRouter from "./routes/pages.js";

const app = express();

app.use(express.json());

// Shared collaborators live on app.locals so routes reach them through
// req.app.locals, and tests can swap them (e.g. a temp blob folder).
const config = readConfig();
app.locals.queues = createQueues(config);
app.locals.blobStore = new LocalBlobStore(config.dataDir);

// GET /: a friendly landing response so opening the base URL doesn't look like an error.
app.get("/", (req, res) => {
  res.json({ message: "Mini Search API is running", health: "/api/health" });
});

app.use("/api", healthRouter);
app.use("/api", jobsRouter);
app.use("/api", pagesRouter);

// No route matched. Must stay after all routes.
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler: Express recognises it by the 4 arguments.
// Errors that carry a 4xx status (our job errors, or invalid JSON from
// express.json()) are the client's fault: send their message. Anything else
// is a bug: log it and hide the details.
app.use((err, req, res, next) => {
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
