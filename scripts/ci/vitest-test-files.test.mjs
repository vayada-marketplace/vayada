// Every tracked test file in an app or package is one its `npm test` runs (VAY-2356). pms-web's
// include list left two files unrun for weeks, and locale-constants had no test script at all;
// nothing failed. vitest itself lists the files (`vitest list --filesOnly`, with the script's own
// arguments), so include and exclude patterns are read exactly as `npm test` reads them.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VITEST = join(ROOT, "node_modules/.bin/vitest");
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const run = promisify(execFile);

// Each app and package with tracked test files: its folder, those files and its `test` script.
function testedWorkspaces() {
  const byDir = new Map();
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  for (const file of tracked.split("\0").filter((path) => TEST_FILE.test(path))) {
    const dir = file.split("/").slice(0, 2).join("/");
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  return [...byDir].map(([dir, tests]) => {
    const pkg = join(ROOT, dir, "package.json");
    const script = existsSync(pkg)
      ? (JSON.parse(readFileSync(pkg, "utf8")).scripts?.test ?? "")
      : "";
    return { dir, tests, script: script.trim() };
  });
}

// `vitest run` and its own arguments only: a chained `&& …` would reach vitest as arguments.
const VITEST_RUN = /^vitest run(?:\s+([^&|;]*))?$/;

async function filesVitestRuns({ dir, script }, out) {
  const args = VITEST_RUN.exec(script)[1]?.split(/\s+/) ?? [];
  const json = join(out, `${dir.replace("/", "-")}.json`);
  await run(VITEST, ["list", ...args, "--filesOnly", `--json=${json}`], {
    cwd: join(ROOT, dir),
    maxBuffer: 16 * 1024 * 1024,
  });
  return new Set(JSON.parse(readFileSync(json, "utf8")).map(({ file }) => relative(ROOT, file)));
}

test("every app and package with test files runs them with `vitest run` (VAY-2356)", () => {
  const without = testedWorkspaces().filter(({ script }) => !VITEST_RUN.test(script));
  assert.deepEqual(
    without.map(({ dir, script }) => `${dir}: "test": ${JSON.stringify(script)}`),
    [],
    'These have test files but no "test": "vitest run" script, so nothing runs them.',
  );
});

test("every tracked test file of a vitest app or package runs in its npm test (VAY-2356)", async (t) => {
  assert.ok(existsSync(VITEST), "run `npm ci` first: this guard asks vitest which files run");
  const out = mkdtempSync(join(tmpdir(), "vitest-files-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const workspaces = testedWorkspaces().filter(({ script }) => VITEST_RUN.test(script));
  assert.ok(workspaces.some(({ dir }) => dir === "apps/pms-web"));
  const missed = [];
  // A few at a time: each list starts its own vitest.
  for (let index = 0; index < workspaces.length; index += 4) {
    await Promise.all(
      workspaces.slice(index, index + 4).map(async (workspace) => {
        const runs = await filesVitestRuns(workspace, out);
        missed.push(...workspace.tests.filter((file) => !runs.has(file)));
      }),
    );
  }
  assert.deepEqual(
    missed.sort(),
    [],
    "These test files never run: widen `include` in their workspace's vitest config.",
  );
});
