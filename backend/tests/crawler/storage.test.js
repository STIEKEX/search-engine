import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlobStore, sha256 } from "../../crawler/storage.js";

let dir;
let store;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "blobstore-test-"));
  store = createBlobStore(dir);
});

after(() => rm(dir, { recursive: true, force: true }));

test("putRawHtml names the file by the SHA-256 of its bytes", async () => {
  const html = Buffer.from("<html>hello</html>");
  const { hash, ref } = await store.putRawHtml(html);
  assert.equal(hash, sha256(html));
  assert.equal(ref, `raw/${hash.slice(0, 2)}/${hash}.html`);
  assert.deepEqual(await store.get(ref), html);
});

test("writing the same content twice is harmless: one file, same ref", async () => {
  const first = await store.putText("same words");
  const second = await store.putText("same words");
  assert.deepEqual(first, second);
  const files = await readdir(path.join(dir, "text", first.hash.slice(0, 2)));
  assert.deepEqual(files, [`${first.hash}.txt`]); // no leftover .tmp file either
});

test("different content gets a different file", async () => {
  const a = await store.putText("cats");
  const b = await store.putText("dogs");
  assert.notEqual(a.ref, b.ref);
});
