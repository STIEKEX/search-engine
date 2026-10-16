// A tiny local web server for tests, so no test ever touches the internet.
// It serves files from tests/fixtures/site plus a few special routes that
// misbehave on purpose (redirect loops, slow responses, huge bodies...).
// Every request is logged so tests can assert what the crawler fetched, and when.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = fileURLToPath(new URL("../fixtures/site/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".txt": "text/plain", ".png": "image/png" };

function redirect(res, location, status = 302) {
  res.writeHead(status, { location });
  res.end();
}

function html(res, body, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

// path -> handler(req, res). Tests can add or override routes.
const BUILTIN_ROUTES = {
  "/moved": (req, res) => redirect(res, "/about.html", 301),
  "/loop-a": (req, res) => redirect(res, "/loop-b"),
  "/loop-b": (req, res) => redirect(res, "/loop-a"),
  "/bad-redirect": (req, res) => redirect(res, "mailto:someone@example.com"),
  "/status/404": (req, res) => html(res, "<h1>Not found</h1>", 404),
  "/status/500": (req, res) => html(res, "<h1>Server error</h1>", 500),
  // Sends headers, then never finishes the body.
  "/slow": (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html>");
  },
  // 3 MB, streamed in chunks with NO content-length: the fetcher must count bytes itself.
  "/big": (req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 48; i++) res.write(chunk);
    res.end();
  },
  // Same size, but announced up front: the fetcher can refuse before reading.
  "/big-declared": (req, res) => {
    const body = "x".repeat(3 * 1024 * 1024);
    res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(body) });
    res.end(body);
  },
};

// /chain/3 -> /chain/2 -> /chain/1 -> /chain/0 (a normal page): N redirects.
function chainRoute(req, res, pathname) {
  const n = Number(pathname.split("/")[2]);
  if (n > 0) return redirect(res, `/chain/${n - 1}`);
  return html(res, "<title>End of chain</title>");
}

async function serveFile(req, res, pathname) {
  const file = path.join(SITE_DIR, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(SITE_DIR)) return html(res, "Forbidden", 403);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    html(res, "<h1>Not found</h1>", 404);
  }
}

/**
 * Start the server on a random free port.
 * @param {object} routes  extra/overriding routes, e.g. { "/robots.txt": handler }
 */
export async function startMockServer(routes = {}) {
  const allRoutes = { ...BUILTIN_ROUTES, ...routes };
  const requests = []; // { path, at, userAgent }

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    requests.push({ path: pathname, at: Date.now(), userAgent: req.headers["user-agent"] });
    if (allRoutes[pathname]) return allRoutes[pathname](req, res);
    if (pathname.startsWith("/chain/")) return chainRoute(req, res, pathname);
    return serveFile(req, res, pathname);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    requests,
    url: (p) => `${origin}${p}`,
    pathsRequested: () => requests.map((r) => r.path),
    async close() {
      server.closeAllConnections(); // drop hanging requests such as /slow
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
