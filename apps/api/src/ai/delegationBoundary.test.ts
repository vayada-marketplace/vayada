// Only the AI action layer (apps/api/src/ai) may run routes as a user (VAY-2506). A route handler
// or job that could call these would be a second, unreviewed way to act as someone else.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const DELEGATION_API =
  /\b(injectAsDelegate|resolveDelegatedContext|narrowDelegatedContext|runDelegatedRead)\b|ai\/delegatedRead/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")
          ? []
          : sourceFiles(path);
      }
      return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

describe("delegation boundary (VAY-2506)", () => {
  it("is used only by apps/api/src/ai and defined only in backend-auth", async () => {
    const roots = [join(repoRoot, "apps"), join(repoRoot, "packages")];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const users: string[] = [];
    for (const file of files) {
      const path = relative(repoRoot, file);
      if (path.startsWith("apps/api/src/ai/") || path.startsWith("packages/backend-auth/src/")) {
        continue;
      }
      if (DELEGATION_API.test(await readFile(file, "utf8"))) users.push(path);
    }
    expect(files.length).toBeGreaterThan(500);
    expect(users).toEqual([]);
  });
});
