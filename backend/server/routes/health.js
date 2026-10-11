import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

// mongoose.connection.readyState is a number; this maps it to a readable name.
const DB_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

// GET /api/health: is the server up, and is it connected to MongoDB?
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    db: DB_STATES[mongoose.connection.readyState] ?? "unknown",
  });
});

export default router;
