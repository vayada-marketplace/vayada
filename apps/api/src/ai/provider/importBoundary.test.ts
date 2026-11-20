import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const API_SRC = fileURLToPath(new URL("../..", import.meta.url));
const PROVIDER_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The AI SDK and Mastra may only be imported here, so swapping them touches one folder (plan 3.11). */
const SDK_IMPORT =
  /\bfrom\s+["'](ai|ai\/[^"']+|@ai-sdk\/[^"']+|@mastra\/[^"']+)["']|\bimport\(\s*["'](ai["'/]|@ai-sdk\/|@mastra\/)/;
/** Never anywhere: Mastra's own HTTP routes have no auth, and `ee/` code has another licence (research 09 §7). */
const FORBIDDEN_IMPORT =
  /["'](@mastra\/fastify|@mastra\/server|@mastra\/[^"']*\/ee(\/[^"']*)?|@mastra\/[^"']*\/dist\/[^"']*)["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("AI SDK import boundary", () => {
  const files = sourceFiles(API_SRC);

  it("scans the API source", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("keeps AI SDK and Mastra imports inside ai/provider", () => {
    const outside = files.filter(
      (file) => !file.startsWith(PROVIDER_DIR) && SDK_IMPORT.test(readFileSync(file, "utf8")),
    );
    expect(outside.map((file) => relative(API_SRC, file).split(sep).join("/"))).toEqual([]);
  });

  it("never imports Mastra's HTTP server or its separately licensed code", () => {
    const offending = files.filter((file) => FORBIDDEN_IMPORT.test(readFileSync(file, "utf8")));
    expect(offending.map((file) => relative(API_SRC, file))).toEqual([]);
  });
});
