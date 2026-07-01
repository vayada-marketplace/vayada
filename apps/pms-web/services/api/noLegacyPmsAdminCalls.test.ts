import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const runtimeRoots = ["app", "components", "services"];
const forbiddenPatterns = [
  /["'`]\/admin(?:\/|\?|["'`])/,
  /\bX-Hotel-Id\b/,
  /\bpmsClient\b/,
  /\bNEXT_PUBLIC_PMS_API_URL\b/,
  /api\.pms\.localhost/,
  /pms-api\.vayada\.com/,
  /upload\/images\/listing/,
];

describe("PMS Web runtime legacy admin calls", () => {
  it("does not call legacy PMS admin routes from runtime source", () => {
    const offenders = runtimeRoots.flatMap((root) =>
      sourceFiles(path.join(process.cwd(), root)).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const relative = path.relative(process.cwd(), file);
        return forbiddenPatterns.flatMap((pattern) =>
          pattern.test(source) ? [`${relative}: ${pattern.source}`] : [],
        );
      }),
    );

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return sourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") ? [fullPath] : [];
  });
}
