import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import app from "../server/app.js";

let server;
let baseUrl;

before(() => {
  // Port 0 asks the OS for any free port, so tests never clash with `npm run dev`.
  server = app.listen(0);
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => server.close());

test("GET / returns a running message", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.message, "Mini Search API is running");
});

test("GET /api/health returns ok", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("unknown route returns 404 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
});
