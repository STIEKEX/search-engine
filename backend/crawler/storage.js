// Local "blob" storage for page content, outside MongoDB.
//
// Every file is named after the SHA-256 hash of its own bytes:
//   data/raw/3f/3fa9...c1.html     raw HTML exactly as downloaded
//   data/text/9b/9b02...7e.txt     extracted readable text
//
// Why name files by content hash ("content addressing")?
//   - Writing the same content twice produces the same name, so a repeat
//     write is a no-op instead of a duplicate (safe to retry).
//   - Two URLs serving identical HTML share one file automatically.
//   - The hash doubles as a fingerprint for spotting duplicate content later.
// Why the 2-character subfolder? Thousands of files in one folder get slow to
// list on some filesystems; 256 buckets keep each folder small.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * @param {string} rootDir  folder that holds raw/ and text/ (default: backend/data)
 */
export function createBlobStore(rootDir = DEFAULT_DATA_DIR) {
  /**
   * Save content under kind ("raw" | "text") and return { hash, ref }.
   * `ref` is a path relative to rootDir; it is what the Page document stores.
   */
  async function put(kind, content, ext) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const hash = sha256(bytes);
    const ref = path.posix.join(kind, hash.slice(0, 2), `${hash}.${ext}`);
    const fullPath = path.join(rootDir, ref);

    if (await exists(fullPath)) return { hash, ref }; // same bytes already stored

    await mkdir(path.dirname(fullPath), { recursive: true });
    // Write to a temp name, then rename. Rename is atomic on one disk, so a
    // crash mid-write never leaves a half-written file under the final name.
    const tmpPath = `${fullPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, fullPath);
    return { hash, ref };
  }

  async function get(ref) {
    return readFile(path.join(rootDir, ref));
  }

  return {
    putRawHtml: (bytes) => put("raw", bytes, "html"),
    putText: (text) => put("text", text, "txt"),
    get,
    rootDir,
  };
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
