import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

// mongoose.connection.readyState is a number; this maps it to a readable name.
const DB_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

async function checkDb() {
  if (mongoose.connection.readyState !== 1) return { ok: false, detail: DB_STATES[mongoose.connection.readyState] };
  try {
    await mongoose.connection.db.admin().ping(); // "connected" can be stale; ping proves it
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

// GET /api/health
// `status: "ok"` means the process is up and answering (liveness).
// `ready` says whether it can do real work: DB reachable AND storage writable.
// A deploy tool would restart on failed liveness but only route traffic on ready.
router.get("/health", async (req, res) => {
  const blobStore = req.app.locals.blobStore;
  const [db, storage] = await Promise.all([checkDb(), blobStore ? blobStore.check() : { ok: false, detail: "not configured" }]);
  res.json({
    status: "ok",
    db: DB_STATES[mongoose.connection.readyState] ?? "unknown",
    ready: db.ok && storage.ok,
    checks: { db, storage },
  });
});

export default router;
