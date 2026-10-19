// The contract for page-content storage ("blobs" = big opaque byte strings).
//
// Workers only ever talk to this interface, never to the disk directly. So
// moving from local files to Amazon S3 later means writing an S3BlobStore
// with these same four methods; fetch and parse workers do not change.
//
// Every implementation must be CONTENT-ADDRESSED: the key is derived from the
// SHA-256 of the bytes. That makes writes idempotent (writing the same bytes
// twice is harmless), which the retry logic in Stage 2 relies on.

import { createHash } from "node:crypto";

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export class BlobStore {
  /** Store raw HTML bytes. @returns {Promise<{hash: string, ref: string}>} */
  async putRawHtml(bytes) {
    throw new Error(`${this.constructor.name}.putRawHtml is not implemented`);
  }

  /** Store extracted text. @returns {Promise<{hash: string, ref: string}>} */
  async putText(text) {
    throw new Error(`${this.constructor.name}.putText is not implemented`);
  }

  /** Read back what put* stored. @returns {Promise<Buffer>} */
  async get(ref) {
    throw new Error(`${this.constructor.name}.get is not implemented`);
  }

  /** Health check for GET /api/health. @returns {Promise<{ok: boolean, detail?: string}>} */
  async check() {
    throw new Error(`${this.constructor.name}.check is not implemented`);
  }
}
