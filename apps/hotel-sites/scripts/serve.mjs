// Serves build/ the way Cloudflare Pages will, for previews and the browser tests. Each address
// gets its own folder (`<slug>.site.localhost` stands in for `<slug>.site.vayada.com`), "/" is its
// index.html, a path with no file gets its 404.html, the folder's _headers rules apply (the file
// itself isn't served), and an address with no folder gets a 404.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
  let pathname = "";
  let file = "";
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    file = path.join(folder, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  } catch {
    // A malformed path names no file.
  }
  const headers = await headerRules(folder, pathname);
  const served = file.startsWith(folder + path.sep) && path.basename(file) !== "_headers";
  if (served && (await isFile(file))) {
    send(request, response, 200, file, headers);
  } else {
    send(request, response, 404, path.join(folder, "404.html"), headers);
  }
}).listen(port, () => console.log(`Hotel sites: http://<slug>.site.localhost:${port}/`));

function send(request, response, status, file, headers) {
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  const gzip = /^text\//.test(type) && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
  response.writeHead(status, {
    "content-type": type,
    // Pages' default: checked on every visit, unless _headers says otherwise.
    "cache-control": "public, max-age=0, must-revalidate",
    vary: "accept-encoding",
    ...headers,
    ...(gzip ? { "content-encoding": "gzip" } : {}),
  });
  if (request.method === "HEAD") return response.end();
  // A file removed mid-request (a rebuild) ends this response, not the server.
  const body = createReadStream(file).on("error", () => response.destroy());
  (gzip ? body.pipe(createGzip()) : body).pipe(response);
}

/** The folder's _headers rules for this path; ones for an https:// address (pages.dev) don't apply. */
async function headerRules(folder, pathname) {
  const rules = await readFile(path.join(folder, "_headers"), "utf8").catch(() => "");
  const headers = {};
  let applies = false;
  for (const line of rules.split("\n")) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      const pattern = line
        .trim()
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
      applies = line.startsWith("/") && new RegExp(`^${pattern.join(".*")}$`).test(pathname);
    } else if (applies) {
      const colon = line.indexOf(":");
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  return headers;
}

async function isFile(file) {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}
