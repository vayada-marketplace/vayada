import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  API_SOURCE_DIR,
  DEFAULT_GROUP_SIZE,
  ISOLATED_GROUPS,
  NOT_IN_CI,
  ROOT,
  WORKFLOW_FILE,
  integrationFiles,
  nightlyGroups,
  nightlyGroupsFromRepo,
  prChecksCoverage,
} from "./integration-suites.mjs";

const WORKFLOW = readFileSync(join(ROOT, WORKFLOW_FILE), "utf8");
const FILES = integrationFiles();
const COVERAGE = prChecksCoverage(WORKFLOW);
const GROUPS = nightlyGroups({ files: FILES, coverage: COVERAGE });
const NIGHTLY = new Set(GROUPS.flatMap((group) => group.files));
const exists = (file) => existsSync(join(ROOT, API_SOURCE_DIR, file.slice("src/".length)));

// A small pr-checks.yml: one unfiltered api command, one `-t` filtered command, a two-line
// continuation, and a chained backend-migration command whose file could share an api file's name.
const FIXTURE = `
jobs:
  api_postgres:
    steps:
      - name: Batch
        run: >-
          npm --workspace vayada-api run test --
          --no-file-parallelism
          src/a.integration.test.ts
          src/b.integration.test.ts
      - name: Filtered
        run: >-
          npm --workspace vayada-api run test -- --no-file-parallelism
          src/c.integration.test.ts
          -t "one case"
      - name: Both
        run: |
          npm --workspace vayada-api run test -- src/c.integration.test.ts -t "restricted"
          npm --workspace vayada-api run test -- --no-file-parallelism \\
            src/d.integration.test.ts \\
            src/e.unit.test.ts
          npm --workspace @vayada/backend-migration run test -- src/f.integration.test.ts && npm --workspace vayada-api run test -- src/g.integration.test.ts
`;

test("prChecksCoverage reads unfiltered, filtered and continued vayada-api commands", () => {
  const coverage = prChecksCoverage(FIXTURE);
  assert.deepEqual([...coverage.full].sort(), [
    "src/a.integration.test.ts",
    "src/b.integration.test.ts",
    "src/d.integration.test.ts",
    "src/g.integration.test.ts",
  ]);
  assert.deepEqual([...coverage.filteredOnly], ["src/c.integration.test.ts"]);
});

test("nightlyGroups keeps the isolated groups and chunks the rest alphabetically", () => {
  const isolated = ISOLATED_GROUPS[0];
  const files = [
    ...isolated.files,
    ...Object.keys(NOT_IN_CI),
    ...Array.from({ length: DEFAULT_GROUP_SIZE + 1 }, (_, i) => `src/z${i}.integration.test.ts`),
    "src/covered.integration.test.ts",
  ].sort();
  const groups = nightlyGroups({
    files,
    coverage: { full: new Set(["src/covered.integration.test.ts"]), filteredOnly: new Set() },
  });
  const names = groups.map((group) => group.name);
  assert.ok(names.includes(isolated.name));
  assert.deepEqual(names.slice(-2), ["default-1", "default-2"]);
  const all = groups.flatMap((group) => group.files);
  assert.equal(new Set(all).size, all.length, "a file runs in one group");
  assert.ok(!all.includes("src/covered.integration.test.ts"));
  for (const file of Object.keys(NOT_IN_CI)) assert.ok(!all.includes(file));
  for (const group of groups.filter((g) => g.name.startsWith("default-"))) {
    assert.ok(group.files.length <= DEFAULT_GROUP_SIZE);
    assert.deepEqual(group.files, [...group.files].sort());
  }
});

test("the real pr-checks.yml names most integration files without filters", () => {
  // A parser regression would silently move every file to the nightly run.
  assert.ok(
    COVERAGE.full.size >= 100,
    `only ${COVERAGE.full.size} files found in ${WORKFLOW_FILE}`,
  );
  for (const file of [...COVERAGE.full, ...COVERAGE.filteredOnly]) {
    assert.ok(exists(file), `${WORKFLOW_FILE} names a missing file: ${file}`);
  }
});

test("every integration file runs in PR Checks, in the nightly run, or is listed with a reason", () => {
  assert.ok(FILES.length >= 150, `only ${FILES.length} integration files found`);
  const uncovered = FILES.filter(
    (file) => !COVERAGE.full.has(file) && !NIGHTLY.has(file) && !(file in NOT_IN_CI),
  );
  assert.deepEqual(
    uncovered,
    [],
    "add the file to a pr-checks.yml step or explain it in NOT_IN_CI",
  );
});

test("files PR Checks runs only with -t filters run in full somewhere else", () => {
  for (const file of COVERAGE.filteredOnly) {
    assert.ok(NIGHTLY.has(file) || file in NOT_IN_CI, `${file} runs only under -t filters`);
  }
});

test("the not-in-CI list names existing files with a ticket and is not stale", () => {
  for (const [file, reason] of Object.entries(NOT_IN_CI)) {
    assert.ok(exists(file), `${file} no longer exists`);
    assert.match(reason, /VAY-\d+/, `${file}: name the ticket that removes it from the list`);
    assert.ok(!COVERAGE.full.has(file), `${file} runs in PR Checks: drop it from NOT_IN_CI`);
  }
});

test("isolated groups name existing files once each, with a reason", () => {
  const seen = new Set();
  for (const group of ISOLATED_GROUPS) {
    assert.match(group.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(group.reason, `${group.name} needs a reason`);
    assert.ok(group.files.length > 0);
    for (const file of group.files) {
      assert.ok(exists(file), `${group.name}: ${file} does not exist`);
      assert.ok(!seen.has(file), `${file} is in two isolated groups`);
      assert.ok(!(file in NOT_IN_CI), `${file} is both isolated and not in CI`);
      seen.add(file);
    }
  }
  assert.equal(new Set(GROUPS.map((group) => group.name)).size, GROUPS.length);
});

test("the nightly CLI prints the same groups as the module", () => {
  const result = spawnSync(process.execPath, ["scripts/ci/integration-suites.mjs", "nightly"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), nightlyGroupsFromRepo());
  const usage = spawnSync(process.execPath, ["scripts/ci/integration-suites.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(usage.status, 2);
});
