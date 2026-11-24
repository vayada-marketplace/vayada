// Only the AI action layer (apps/api/src/ai) may run routes as a user (VAY-2506). A route handler
// or job that could call these would be a second, unreviewed way to act as someone else.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const DELEGATION_API =
  /\b(injectAsDelegate|resolveDelegatedContext|resolveDelegatedChangeContext|narrowDelegatedContext|runDelegatedRead)\b|ai\/(delegatedRead|executor)/;
/** A "change" delegation may also write (VAY-2522): only the one executor of AI changes mints one. */
const CHANGE_API = /\bresolveDelegatedChangeContext\b/;
const EXECUTOR_DIR = "apps/api/src/ai/executor/";
/** Handing the change resolver on under another name: a named re-export or a star re-export. */
const RE_EXPORT = new RegExp(
  [
    /export\s*\{[^}]*\bresolveDelegatedChangeContext\b/.source,
    /export\s*\*\s*(as\s+\w+\s*)?from\s*["']@vayada\/backend-auth/.source,
    /export\s+(default\s+|(const|let|var)\s+\w+\s*=\s*)resolveDelegatedChangeContext\b/.source,
  ].join("|"),
);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);

/** Every source file in the repository, tests excluded (they may build any context). */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".") ? [] : sourceFiles(path);
      }
      return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
        ? [path]
        : [];
    }),
  );
  return files.flat();
}

/** Source files outside the allowed folders that mention the API. */
async function usersOf(api: RegExp, allowed: readonly string[]): Promise<string[]> {
  const files = await sourceFiles(repoRoot);
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

  it("never hands the change resolver on under another name (VAY-2522)", async () => {
    expect(await usersOf(RE_EXPORT, ["packages/backend-auth/src/"])).toEqual([]);
  });
});
