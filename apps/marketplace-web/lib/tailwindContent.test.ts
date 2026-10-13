import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Folders without class names: dependencies, build output, assets, styles, docs,
// config, and services/ (API clients, no markup).
const unstyledFolders = new Set([
  "node_modules",
  "out",
  "build",
  "coverage",
  "public",
  "styles",
  "docs",
  "config",
  "services",
]);

describe("Marketplace Web Tailwind content", () => {
  // VAY-2153: lib/ was not scanned, so the collaboration status badge colours
  // in lib/constants/colors.ts were never generated.
  it("scans every source folder", () => {
    const { content } = createRequire(import.meta.url)(
      path.join(process.cwd(), "tailwind.config.js"),
    ) as { content: string[] };
    const unscanned = readdirSync(process.cwd(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((folder) => !unstyledFolders.has(folder))
      .filter((folder) => !content.some((glob) => glob.startsWith(`./${folder}/`)));

    expect(unscanned).toEqual([]);
  });
});
