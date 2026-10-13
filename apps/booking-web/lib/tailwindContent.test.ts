import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Folders without source: dependencies, build output, assets and translations.
const unstyledFolders = new Set(["node_modules", "out", "build", "coverage", "public", "messages"]);

describe("Booking Web Tailwind content", () => {
  // VAY-2153: contexts/ was not scanned, so classes that only appear there (the
  // hotel loading spinner's dark segment) were never generated.
  it("scans every source folder", () => {
    const { content } = createRequire(import.meta.url)("../tailwind.config.js") as {
      content: string[];
    };
    const appDir = fileURLToPath(new URL("..", import.meta.url));
    const unscanned = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((folder) => !unstyledFolders.has(folder))
      .filter((folder) => !content.some((glob) => glob.startsWith(`./${folder}/`)));

    expect(unscanned).toEqual([]);
  });
});
