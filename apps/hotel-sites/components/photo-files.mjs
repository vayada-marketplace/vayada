// The site has no image server: every photo is converted at build time into one file per width,
// quality and format. The page names those files (Photo.tsx) and the build writes them
// (scripts/export-sites.mjs), both with this function.

/** AVIF, then WebP, then the photo's own format: the order Next's image server chose them in. */
export const PHOTO_FORMATS = ["avif", "webp", "original"];

/**
 * `/_next/static/media/hero.1a2b3c4d.jpg` at 640px wide, quality 75, as AVIF:
 * `/_next/static/media/hero.1a2b3c4d.640w.q75.avif`. Quality 75 is next/image's default.
 * @param {{ src: string; width: number; quality?: number }} photo
 * @param {"avif" | "webp" | "original"} format
 * @returns {string}
 */
export function photoFileUrl({ src, width, quality = 75 }, format) {
  const dot = src.lastIndexOf(".");
  const extension = format === "original" ? src.slice(dot + 1) : format;
  return `${src.slice(0, dot)}.${width}w.q${quality}.${extension}`;
}
