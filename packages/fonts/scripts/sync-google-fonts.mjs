#!/usr/bin/env node
// Copies the Google Fonts files the apps use into this package and writes the next/font/local
// modules that load them (VAY-2243, VAY-2225). Builds and browsers then never contact Google.
//
//   node packages/fonts/scripts/sync-google-fonts.mjs   (needs the repo's node_modules)
//
// Only run it on purpose, to add a family or pick up a new upstream version: it is the one step
// that talks to Google. It asks for the same CSS next/font/google used to (same query, same
// browser string), so the files and @font-face rules match what the apps served before.
//
// next/font/local writes one unicode-range for all files of a call, while Google splits every
// family into character subsets (latin, latin-ext, cyrillic, ...). So each subset gets its own
// localFont call, and fontStack() chains them in the order the browser tried Google's faces.
// next/font/local would measure its fallback font from the file, which sizes it differently from
// next/font/google, so fallbacks.css holds next/font/google's own fallback faces instead.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// next/font/google's request header: it decides the file format (woff2) Google returns.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/104.0.0.0 Safari/537.36";

// name: export name; query: Google's css2 family parameter, as next/font/google built it;
// generic: appended after the fallback (the UI font had none).
const MODULES = {
  "brand.generated.ts": {
    title: "Design Studio font pairings (booking-web, staff previews)",
    preloadLatin: false,
    fonts: [
      {
        name: "playfairDisplay",
        query: "Playfair+Display:ital,wght@0,400;0,700;1,400;1,700",
        generic: "serif",
      },
      { name: "sourceSans3", query: "Source+Sans+3:wght@300;400;600;700", generic: "sans-serif" },
      { name: "inter", query: "Inter:wght@300;400;500;600;700", generic: "sans-serif" },
      { name: "lora", query: "Lora:ital,wght@0,400;0,700;1,400;1,700", generic: "serif" },
      { name: "cinzel", query: "Cinzel:wght@400;600;700", generic: "serif" },
      { name: "italiana", query: "Italiana:wght@400", generic: "serif" },
    ],
  },
  "ui.generated.ts": {
    title: "App UI font: Inter({ subsets: ['latin'] }), which preloaded only the latin file",
    preloadLatin: true,
    fonts: [{ name: "interUi", query: "Inter:wght@100..900", generic: null }],
  },
};

// Each family's licence, from the google/fonts repository at a fixed commit.
const LICENCE_COMMIT = "47d54ca1ebb14fd864695f1d39dc734f39017c33";
const LICENCES = {
  "playfair-display": "ofl/playfairdisplay/OFL.txt",
  "source-sans-3": "ofl/sourcesans3/OFL.txt",
  inter: "ofl/inter/OFL.txt",
  lora: "ofl/lora/OFL.txt",
  cinzel: "ofl/cinzel/OFL.txt",
  italiana: "ofl/italiana/OFL.txt",
};

async function fetchOk(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

const slug = (family) => family.toLowerCase().replace(/\s+/g, "-");
const camel = (text) => text.replace(/-(\w)/g, (_, c) => c.toUpperCase());
const pascal = (text) => camel(text).replace(/^\w/, (c) => c.toUpperCase());

// next/font/google's fallback face for a family (next/dist/server/font-utils.js
// calculateSizeAdjustValues): local Arial or Times New Roman, scaled with Next's metrics table.
const capsize = require("next/dist/server/capsize-font-metrics.json");
const capsizeKey = (name) =>
  name
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase(),
    )
    .replace(/\s+/g, "");
function fallbackFace(family) {
  const metrics = capsize[capsizeKey(family)];
  if (!metrics) throw new Error(`${family}: not in Next's font metrics`);
  const local = metrics.category === "serif" ? "Times New Roman" : "Arial";
  const base = capsize[capsizeKey(local)];
  const sizeAdjust = metrics.xWidthAvg
    ? metrics.xWidthAvg / metrics.unitsPerEm / (base.xWidthAvg / base.unitsPerEm)
    : 1;
  const percent = (value) => `${Math.abs(value * 100).toFixed(2)}%`;
  const scaled = (value) => percent(value / (metrics.unitsPerEm * sizeAdjust));
  return [
    "@font-face {",
    `  font-family: "${family} Fallback";`,
    `  src: local("${local}");`,
    `  ascent-override: ${scaled(metrics.ascent)};`,
    `  descent-override: ${scaled(metrics.descent)};`,
    `  line-gap-override: ${scaled(metrics.lineGap)};`,
    `  size-adjust: ${percent(sizeAdjust)};`,
    "}",
  ].join("\n");
}

/** The @font-face rules of a Google css2 response, with the subset named in its comment. */
function parseFaces(css) {
  const faces = [];
  for (const [, subset, body] of css.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face \{([^}]*)\}/g)) {
    const field = (prop) => new RegExp(`${prop}: ([^;]+);`).exec(body)?.[1].trim();
    faces.push({
      subset,
      family: field("font-family").replace(/'/g, ""),
      style: field("font-style"),
      weight: field("font-weight"),
      display: field("font-display"),
      url: /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(body)?.[1],
      unicodeRange: field("unicode-range"),
    });
  }
  if (faces.length !== (css.match(/@font-face/g) ?? []).length || faces.some((f) => !f.url))
    throw new Error("Unexpected Google Fonts CSS");
  return faces;
}

const files = new Map(); // file name -> Google URL
const families = new Map(); // family -> fallback @font-face

async function fontCalls(font, preloadLatin) {
  const css = await (
    await fetchOk(`https://fonts.googleapis.com/css2?family=${font.query}&display=swap`, {
      "User-Agent": USER_AGENT,
    })
  ).text();
  const faces = parseFaces(css);
  const family = faces[0].family;
  if (!LICENCES[slug(family)]) throw new Error(`${family}: add its licence to LICENCES`);
  families.set(family, fallbackFace(family));
  // The browser tries a family's faces in reverse order (CSS Fonts 4, unicode-range), so the
  // subset Google lists last (latin) goes first in the stack.
  const subsets = [...new Set(faces.map((f) => f.subset))].reverse();
  const variants = [...new Set(faces.map((f) => `${f.style} ${f.weight}`))];
  const calls = [];
  for (const subset of subsets) {
    const ofSubset = faces.filter((f) => f.subset === subset);
    const ranges = new Set(ofSubset.map((f) => f.unicodeRange));
    if (ranges.size !== 1 || ofSubset.length !== variants.length)
      throw new Error(`${family} ${subset}: subsets differ between styles or weights`);
    const src = [];
    for (const face of ofSubset) {
      if (face.family !== family || face.display !== "swap")
        throw new Error(`${family} ${subset}: unexpected face ${JSON.stringify(face)}`);
      const file = `${slug(family)}-${subset}${face.style === "italic" ? "-italic" : ""}.woff2`;
      if (files.has(file) && files.get(file) !== face.url) throw new Error(`${file}: two sources`);
      files.set(file, face.url);
      src.push({ path: `../files/${file}`, weight: face.weight, style: face.style });
    }
    calls.push({
      name: `${font.name}${pascal(subset)}`,
      src,
      unicodeRange: [...ranges][0],
      preload: preloadLatin && subset === "latin",
    });
  }
  if (subsets[0] !== "latin") throw new Error(`${family}: latin is not the first subset`);
  return { family, query: font.query, name: font.name, generic: font.generic, calls };
}

function moduleSource(title, fonts) {
  const q = JSON.stringify;
  const lines = [
    "// Generated by packages/fonts/scripts/sync-google-fonts.mjs: edit the script, not this file.",
    `// ${title}.`,
    'import localFont from "next/font/local";',
    "",
    'import "./fallbacks.css";',
    'import { fontStack } from "./fontStack";',
  ];
  for (const font of fonts) {
    lines.push("", `// ${font.family} (Google Fonts css2?family=${font.query})`);
    for (const call of font.calls) {
      lines.push(
        `const ${call.name} = localFont({`,
        "  src: [",
        ...call.src.map(
          (s) => `    { path: ${q(s.path)}, weight: ${q(s.weight)}, style: ${q(s.style)} },`,
        ),
        "  ],",
        `  declarations: [{ prop: "unicode-range", value: ${q(call.unicodeRange)} }],`,
        '  display: "swap",',
        `  preload: ${call.preload},`,
        "  adjustFontFallback: false,",
        "});",
      );
    }
    lines.push(
      `export const ${font.name} = fontStack(`,
      `  [${font.calls.map((c) => c.name).join(", ")}],`,
      `  ${q(`${font.family} Fallback`)},`,
      `  ${font.generic === null ? "null" : q(font.generic)},`,
      ");",
    );
  }
  return `${lines.join("\n")}\n`;
}

const generated = {};
for (const [fileName, { title, preloadLatin, fonts }] of Object.entries(MODULES)) {
  const results = [];
  for (const font of fonts) results.push(await fontCalls(font, preloadLatin));
  generated[fileName] = moduleSource(title, results);
}
generated["fallbacks.css"] = [
  "/* Generated by packages/fonts/scripts/sync-google-fonts.mjs: edit the script, not this file.",
  "   next/font/google's metric-adjusted fallback faces, shown until a font file arrives and for",
  "   characters that no subset of the family covers. */",
  ...families.values(),
].join("\n");

// Download into a temporary folder first, so a failed run leaves the committed files alone.
const staging = mkdtempSync(path.join(root, ".sync-"));
try {
  mkdirSync(path.join(staging, "files"));
  const sources = [];
  for (const [file, url] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
    writeFileSync(path.join(staging, "files", file), bytes);
    sources.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}  ${url}`);
  }
  writeFileSync(path.join(staging, "files", "SOURCES.txt"), `${sources.join("\n")}\n`);
  mkdirSync(path.join(staging, "licences"));
  for (const family of families.keys()) {
    const url = `https://raw.githubusercontent.com/google/fonts/${LICENCE_COMMIT}/${LICENCES[slug(family)]}`;
    writeFileSync(
      path.join(staging, "licences", `${slug(family)}-OFL.txt`),
      await (await fetchOk(url)).text(),
    );
  }
  for (const dir of ["files", "licences"]) {
    rmSync(path.join(root, dir), { recursive: true, force: true });
    renameSync(path.join(staging, dir), path.join(root, dir));
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
const outputs = Object.keys(generated).map((fileName) => path.join(root, "src", fileName));
for (const file of outputs) writeFileSync(file, `${generated[path.basename(file)]}\n`);
// The repo's own Prettier (lockfile version), so the output matches lint-staged.
execFileSync("npx", ["--no-install", "prettier", "--write", ...outputs], { stdio: "inherit" });
console.log(
  `${files.size} font files, ${readdirSync(path.join(root, "licences")).length} licences`,
);
