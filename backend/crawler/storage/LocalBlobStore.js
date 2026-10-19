// BlobStore implementation that keeps files on the local disk:
//   data/raw/3f/3fa9...c1.html     raw HTML exactly as downloaded
//   data/text/9b/9b02...7e.txt     extracted readable text
//
// Why the 2-character subfolder? Thousands of files in one folder get slow to
// list on some filesystems; 256 buckets keep each folder small.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BlobStore, sha256 } from "./BlobStore.js";

export const DEFAULT_DATA_DIR = fileURLToPath(new URL("../../data/", import.meta.url));

export class LocalBlobStore extends BlobStore {
  /** @param {string} rootDir  folder that holds raw/ and text/ (default: backend/data) */
  constructor(rootDir = DEFAULT_DATA_DIR) {
    super();
    this.rootDir = rootDir;
  }

  putRawHtml(bytes) {
    return this.#put("raw", bytes, "html");
  }

  putText(text) {
    return this.#put("text", text, "txt");
  }

  get(ref) {
    return readFile(this.#fullPath(ref));
  }

  /** Can we write and read back a file? Used by GET /api/health. */
  async check() {
    const probe = path.join(this.rootDir, `.health-${process.pid}`);
    try {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(probe, "ok");
      const ok = (await readFile(probe, "utf8")) === "ok";
      await rm(probe, { force: true });
      return { ok };
    } catch (err) {
      return { ok: false, detail: err.code ?? err.message };
    }
  }

  /** Save content under kind ("raw" | "text") and return { hash, ref }. */
  async #put(kind, content, ext) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const hash = sha256(bytes);
    const ref = path.posix.join(kind, hash.slice(0, 2), `${hash}.${ext}`);
    const fullPath = this.#fullPath(ref);

    if (await exists(fullPath)) return { hash, ref }; // same bytes already stored

    await mkdir(path.dirname(fullPath), { recursive: true });
    // Write to a temp name, then rename. Rename is atomic on one disk, so a
    // crash mid-write never leaves a half-written file under the final name.
    // The random part keeps two workers writing the same blob from colliding.
    const tmpPath = `${fullPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, fullPath);
    return { hash, ref };
  }

  #fullPath(ref) {
    const full = path.resolve(this.rootDir, ref);
    // A ref comes from our own database, but never let one escape the folder.
    if (!full.startsWith(path.resolve(this.rootDir) + path.sep)) throw new Error(`Invalid blob ref: ${ref}`);
    return full;
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
