// Only the AI action layer (apps/api/src/ai) may run routes as a user (VAY-2506). A route handler
// or job that could call these would be a second, unreviewed way to act as someone else.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const DELEGATION_API =
  /\b(injectAsDelegate|resolveDelegatedContext|resolveDelegatedChangeContext|narrowDelegatedContext|runDelegatedRead)\b|ai\/delegatedRead/;
/** A "change" delegation may also write (VAY-2522): only the one executor of AI changes mints one. */
const CHANGE_API = /\bresolveDelegatedChangeContext\b/;
const EXECUTOR_DIR = "apps/api/src/ai/executor/";

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

/** Source files outside the allowed folders that mention the API. */
async function usersOf(api: RegExp, allowed: readonly string[]): Promise<string[]> {
  const roots = [join(repoRoot, "apps"), join(repoRoot, "packages")];
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  expect(files.length).toBeGreaterThan(500);
  const users: string[] = [];
  for (const file of files) {
    const path = relative(repoRoot, file);
    if (allowed.some((prefix) => path.startsWith(prefix))) continue;
    if (api.test(await readFile(file, "utf8"))) users.push(path);
  }
  return users;
}

describe("delegation boundary (VAY-2506)", () => {
  it("is used only by apps/api/src/ai and defined only in backend-auth", async () => {
    expect(
      await usersOf(DELEGATION_API, ["apps/api/src/ai/", "packages/backend-auth/src/"]),
    ).toEqual([]);
  });

  it("lets only the executor of AI changes mint a change delegation (VAY-2522)", async () => {
    expect(await usersOf(CHANGE_API, [EXECUTOR_DIR, "packages/backend-auth/src/"])).toEqual([]);
  });
});
