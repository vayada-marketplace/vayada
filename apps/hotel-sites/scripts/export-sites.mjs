// Runs after `next build`. Next's static export (out/) has each hotel's page at /<slug>.html, the
// photos as they were uploaded, and no image server. This writes what the static host serves: one
// folder per hotel address, the host of the page's canonical URL (the site's `url`).
//
//   build/<host>/index.html  the hotel's page, at "/"
//   build/<host>/404.html    any other path
//   build/<host>/_next/      scripts, styles, the font, and every photo converted to AVIF, WebP and
//                            its own format at each width and quality next/image asks for
//   build/<host>/_headers    Cloudflare Pages' header rules (caching, noindex)
//   build/sites.json         each hotel's slug and host, for scripts/deploy-pages.mjs
//
// The conversion is the one Next's image server made on request (same sharp, same settings), so
// guests get the same files as from the server. A second address for a site (the hotel's own
// domain) is set up at the host, on the same folder.

import { existsSync } from "node:fs";
import { copyFile, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { PHOTO_FORMATS, photoFileUrl } from "../components/photo-files.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(app, "out");
const build = path.join(app, "build");
const media = "/_next/static/media/";

// The widths and qualities next/image makes srcsets from, as this build resolved them.
const { images } = JSON.parse(await readFile(path.join(app, ".next/images-manifest.json"), "utf8"));
const widths = [...images.imageSizes, ...images.deviceSizes];

let photoFiles = 0;
for (const name of await readdir(path.join(out, media))) {
  if (!/\.(jpe?g|png)$/i.test(name) || /\.\d+w\.q\d+\.\w+$/.test(name)) continue; // fonts, our files
  // srcset and the file check split on spaces, commas and brackets.
  if (!/^[\w.~-]+$/.test(name)) throw new Error(`Rename ${name}: letters, digits, - and _ only`);
  const original = await readFile(path.join(out, media, name));
  for (const quality of images.qualities) {
    for (const format of PHOTO_FORMATS) {
      for (const width of widths) {
        const url = photoFileUrl({ src: media + name, width, quality }, format);
        await writeFile(path.join(out, url), await convert(original, name, width, quality, format));
        photoFiles += 1;
      }
    }
  }
}
console.log(`${photoFiles} photo files`);

await rm(build, { recursive: true, force: true });
const sites = [];
for (const name of await readdir(out)) {
  if (!name.endsWith(".html")) continue;
  const page = await readFile(path.join(out, name), "utf8");
  const canonical = page.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  if (!canonical) {
    if (/^(_|\d)/.test(name)) continue; // Next's own pages: 404.html, _not-found.html
    throw new Error(`out/${name} has no canonical URL, so no address to publish it at`);
  }
  const host = new URL(canonical).host;
  if (sites.some((site) => site.host === host)) throw new Error(`Two pages claim ${host}`);
  const folder = path.join(build, host);
  await cp(path.join(out, "_next"), path.join(folder, "_next"), { recursive: true });
  await writeFile(path.join(folder, "index.html"), page);
  await copyFile(path.join(out, "404.html"), path.join(folder, "404.html"));
  const noindex = /<meta name="robots" content="[^"]*noindex/.test(page);
  await writeFile(path.join(folder, "_headers"), headerRules(noindex));
  // Every file the page names, each srcset width included, has to be in its folder.
  const missing = [...new Set(page.match(/\/_next\/[^"'\s,)\\]+/g))].filter(
    (url) => !existsSync(path.join(folder, url)),
  );
  if (missing.length) throw new Error(`build/${host} lacks ${missing.join(", ")}`);
  sites.push({ slug: name.replace(/\.html$/, ""), host });
  console.log(`build/${host}/ ← out/${name}${noindex ? " (noindex)" : ""}`);
}
if (!sites.length) throw new Error("out/ has no hotel page");
await writeFile(path.join(build, "sites.json"), `${JSON.stringify(sites, null, 2)}\n`);

/**
 * Cloudflare Pages' `_headers` (a path pattern, then its headers indented; not served itself):
 * build files are kept for good; while the page says noindex, no file of the site is indexed
 * (photos included); and the project's own pages.dev address never is.
 */
function headerRules(noindex) {
  return [
    "/_next/static/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    ...(noindex ? ["/*", "  X-Robots-Tag: noindex"] : []),
    "https://:project.pages.dev/*",
    "  X-Robots-Tag: noindex",
    "",
  ].join("\n");
}

/** Next's optimizeImage(): turn upright, shrink (never enlarge), encode. */
function convert(original, name, width, quality, format) {
  const photo = sharp(original).rotate().resize(width, undefined, { withoutEnlargement: true });
  if (format === "avif") {
    return photo.avif({ quality: Math.max(quality - 20, 1), effort: 3 }).toBuffer();
  }
  if (format === "webp") return photo.webp({ quality }).toBuffer();
  if (/\.png$/i.test(name)) return photo.png({ quality }).toBuffer();
  return photo.jpeg({ quality, mozjpeg: true }).toBuffer();
}
