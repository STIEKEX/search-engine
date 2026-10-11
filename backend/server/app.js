import express from "express";
import healthRouter from "./routes/health.js";

const app = express();

app.use(express.json());

// GET /: a friendly landing response so opening the base URL doesn't look like an error.
app.get("/", (req, res) => {
  res.json({ message: "Mini Search API is running", health: "/api/health" });
});

app.use("/api", healthRouter);

// No route matched. Must stay after all routes.
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler: Express recognises it by the 4 arguments.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
