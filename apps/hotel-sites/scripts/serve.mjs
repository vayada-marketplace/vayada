// Serves build/ the way the static host will, for previews and the browser tests. Each address
// gets its own folder (`<slug>.site.localhost` stands in for `<slug>.site.vayada.com`), "/" is its
// index.html, a path with no file gets its 404.html, and an address with no folder gets a 404.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const build = fileURLToPath(new URL("../build", import.meta.url));
const port = Number(process.env.PORT || 3007);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

createServer(async (request, response) => {
  const host = (request.headers.host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.localhost$/, ".vayada.com");
  const folder = path.join(build, host);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !(await isFile(`${folder}/index.html`))) {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  let file = "";
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    file = path.join(folder, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  } catch {
    // A malformed path names no file.
  }
  if (file.startsWith(folder + path.sep) && (await isFile(file))) {
    send(request, response, 200, file);
  } else {
    send(request, response, 404, path.join(folder, "404.html"));
  }
}).listen(port, () => console.log(`Hotel sites: http://<slug>.site.localhost:${port}/`));

function send(request, response, status, file) {
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  // Like the host: hashed build files are kept for good, pages are checked on every visit.
  const immutable = file.includes(`${path.sep}_next${path.sep}static${path.sep}`);
  const gzip = /^text\//.test(type) && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
  response.writeHead(status, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0",
    vary: "accept-encoding",
    ...(gzip ? { "content-encoding": "gzip" } : {}),
  });
  if (request.method === "HEAD") return response.end();
  // A file removed mid-request (a rebuild) ends this response, not the server.
  const body = createReadStream(file).on("error", () => response.destroy());
  (gzip ? body.pipe(createGzip()) : body).pipe(response);
}

async function isFile(file) {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}
