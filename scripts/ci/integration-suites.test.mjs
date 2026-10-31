import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  API_DIR,
  API_SOURCE_DIR,
  API_WORKSPACE,
  DEFAULT_GROUP_SIZE,
  ISOLATED_GROUPS,
  NOT_IN_CI,
  PACKAGES_DIR,
  PACKAGE_NOT_IN_CI,
  ROOT,
  WORKFLOW_FILE,
  databaseEnvNames,
  integrationFiles,
  nightlyGroups,
  nightlyGroupsFromRepo,
  packageDatabaseFiles,
  prChecksCoverage,
  repoEnvNames,
} from "./integration-suites.mjs";

const WORKFLOW = readFileSync(join(ROOT, WORKFLOW_FILE), "utf8");
const NIGHTLY_WORKFLOW_FILE = ".github/workflows/main-integration-suites.yml";
const FILES = integrationFiles();
const COVERAGE = prChecksCoverage(WORKFLOW, API_WORKSPACE, repoEnvNames(API_DIR));
const GROUPS = nightlyGroups({ files: FILES, coverage: COVERAGE });
const NIGHTLY = new Set(GROUPS.flatMap((group) => group.files));
const exists = (file) => existsSync(join(ROOT, API_SOURCE_DIR, file.slice("src/".length)));
const PACKAGE_FILES = packageDatabaseFiles();
const PACKAGE_DIRS = new Map(
  PACKAGE_FILES.map(({ workspace, path, file }) => [workspace, path.slice(0, -file.length)]),
);
const PACKAGE_COVERAGE = new Map(
  [...PACKAGE_DIRS].map(([workspace, dir]) => [
    workspace,
    prChecksCoverage(WORKFLOW, workspace, repoEnvNames(dir)),
  ]),
);

// A small pr-checks.yml: one unfiltered api command, one `-t` filtered command, a two-line
// continuation, a chained backend-migration command whose file could share an api file's name,
// and test database URLs from the job env, a step env, the command itself, or nowhere.
const FIXTURE = `
jobs:
  api_unit:
    steps:
      - name: No database
        run: npm --workspace vayada-api run test -- src/h.integration.test.ts src/i.test.ts
      - name: Migration database only
        env:
          TARGET_DATABASE_URL: postgresql://db/x_test
        run: npm --workspace vayada-api run test -- src/l.test.ts
      - name: Inline database
        run: TEST_DATABASE_URL=postgresql://db/x_test npm --workspace vayada-api run test -- src/j.test.ts
      - name: Other database env
        env:
          GROWTH_TEST_DATABASE_URL: postgresql://db/growth_test
        run: npm --workspace vayada-api run test -- src/k.integration.test.ts
  api_postgres:
    env:
      TEST_DATABASE_URL: postgresql://db/x_test
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

test("prChecksCoverage reads unfiltered, filtered and continued vayada-api commands with a database", () => {
  const coverage = prChecksCoverage(FIXTURE);
  assert.deepEqual([...coverage.full].sort(), [
    "src/a.integration.test.ts",
    "src/b.integration.test.ts",
    "src/d.integration.test.ts",
    "src/e.unit.test.ts",
    "src/g.integration.test.ts",
    "src/j.test.ts",
    "src/k.integration.test.ts",
  ]);
  assert.deepEqual([...coverage.filteredOnly], ["src/c.integration.test.ts"]);
});

// Package commands in both flag forms, `-t` and `--testNamePattern=` filters, a commented-out
// command, a fixture env name set inline, and a step without any test database.
const PACKAGE_FIXTURE = `
jobs:
  api_postgres:
    steps:
      - name: Package suites
        env:
          TEST_DATABASE_URL: postgresql://db/x_test
        run: |
          npm --workspace @vayada/backend-migration run test -- src/m.test.ts
          npm -w @vayada/backend-auth run test -- src/n.test.ts -t "one case"
          npm --workspace=@vayada/backend-auth run test -- src/o.test.ts
          # npm --workspace @vayada/backend-migration run test -- src/r.test.ts
          npm --workspace @vayada/backend-migration run test -- src/s.test.ts --testNamePattern="one case"
      - name: Fixture env name
        run: VAY2017_P_TEST_DATABASE_URL=postgresql://127.0.0.1/p_fixture npm --workspace @vayada/backend-migration run test -- src/p.integration.test.ts
      - name: No database
        run: npm --workspace @vayada/backend-migration run test -- src/q.test.ts
`;

test("prChecksCoverage reads one package workspace's commands (VAY-2427)", () => {
  const migration = prChecksCoverage(PACKAGE_FIXTURE, "@vayada/backend-migration");
  assert.deepEqual([...migration.full].sort(), ["src/m.test.ts", "src/p.integration.test.ts"]);
  assert.deepEqual([...migration.filteredOnly], ["src/s.test.ts"]);
  const auth = prChecksCoverage(PACKAGE_FIXTURE, "@vayada/backend-auth");
  assert.deepEqual([...auth.full], ["src/o.test.ts"]);
  assert.deepEqual([...auth.filteredOnly], ["src/n.test.ts"]);
  assert.equal(prChecksCoverage(PACKAGE_FIXTURE).full.size, 0, "no vayada-api command");
  // The api fixture's chained backend-migration command counts for that workspace only.
  assert.ok(
    prChecksCoverage(FIXTURE, "@vayada/backend-migration").full.has("src/f.integration.test.ts"),
  );
});

test("a command counts only for files that read a test database URL it sets (VAY-2427)", () => {
  // p reads another name than the one its step sets, so its PostgreSQL part would skip itself.
  const reads = (file) =>
    new Set(file === "src/p.integration.test.ts" ? ["VAY2017_OTHER_TEST_DATABASE_URL"] : []);
  const migration = prChecksCoverage(PACKAGE_FIXTURE, "@vayada/backend-migration", reads);
  assert.deepEqual([...migration.full], ["src/m.test.ts"]);
  assert.deepEqual(
    [
      ...databaseEnvNames(
        'process.env["VAY2017_A_TEST_DATABASE_URL"] ?? process.env.TEST_DATABASE_URL; TARGET_DATABASE_URL',
      ),
    ].sort(),
    ["TEST_DATABASE_URL", "VAY2017_A_TEST_DATABASE_URL"],
  );
});

test("packageDatabaseFiles finds every package's database test files under its npm name (VAY-2427)", () => {
  const root = mkdtempSync(join(tmpdir(), "integration-suites-"));
  try {
    const pkg = join(root, PACKAGES_DIR, "a");
    mkdirSync(join(pkg, "src", "jobs"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@x/a" }));
    writeFileSync(join(pkg, "src", "jobs", "b.integration.test.ts"), "");
    writeFileSync(join(pkg, "src", "c.test.ts"), 'process.env["VAY2017_C_TEST_DATABASE_URL"]');
    writeFileSync(join(pkg, "src", "d.test.ts"), 'it("needs no database")');
    mkdirSync(join(root, PACKAGES_DIR, "no-source"));
    writeFileSync(join(root, PACKAGES_DIR, "no-source", "package.json"), '{"name":"@x/none"}');
    writeFileSync(join(root, PACKAGES_DIR, "notes.txt"), "");
    mkdirSync(join(root, PACKAGES_DIR, "no-database", "src"), { recursive: true });
    writeFileSync(join(root, PACKAGES_DIR, "no-database", "src", "e.test.ts"), "");
    assert.deepEqual(packageDatabaseFiles(root), [
      { workspace: "@x/a", path: "packages/a/src/c.test.ts", file: "src/c.test.ts" },
      {
        workspace: "@x/a",
        path: "packages/a/src/jobs/b.integration.test.ts",
        file: "src/jobs/b.integration.test.ts",
      },
    ]);
    // A package with database tests must name its workspace, or no command can cover them.
    writeFileSync(join(root, PACKAGES_DIR, "no-source", "package.json"), "{}");
    mkdirSync(join(root, PACKAGES_DIR, "no-source", "src"));
    writeFileSync(join(root, PACKAGES_DIR, "no-source", "src", "f.integration.test.ts"), "");
    assert.throws(() => packageDatabaseFiles(root), /packages\/no-source has database test files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integrationFiles also tracks test files that read TEST_DATABASE_URL (VAY-2407)", () => {
  const root = mkdtempSync(join(tmpdir(), "integration-suites-"));
  try {
    const dir = join(root, API_SOURCE_DIR, "jobs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.integration.test.ts"), "");
    writeFileSync(join(dir, "b.test.ts"), 'describe.skipIf(!process.env["TEST_DATABASE_URL"])');
    writeFileSync(join(dir, "c.test.ts"), 'it("needs no database")');
    writeFileSync(join(dir, "b.ts"), "process.env.TEST_DATABASE_URL");
    assert.deepEqual(integrationFiles(root), [
      "src/jobs/a.integration.test.ts",
      "src/jobs/b.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.ok(FILES.includes("src/hotelSetupTrackCommand.test.ts"));
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

test("every nightly file reads the test database URL its group sets (VAY-2427)", () => {
  // A file reading another name would skip its PostgreSQL part there.
  const reads = repoEnvNames(API_DIR);
  for (const group of GROUPS) {
    const envName = group.envName ?? "TEST_DATABASE_URL";
    for (const file of group.files) {
      const names = reads(file);
      assert.ok(
        names.size === 0 || names.has(envName),
        `${file} reads ${[...names].join(", ")}, but the nightly group ${group.name} sets ${envName}`,
      );
    }
  }
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

test("the nightly workflow runs the groups this module prints, on the PR Checks PostgreSQL images", () => {
  const nightly = readFileSync(join(ROOT, NIGHTLY_WORKFLOW_FILE), "utf8");
  assert.match(nightly, /node scripts\/ci\/integration-suites\.mjs nightly/);
  assert.match(nightly, /schedule:\n\s+- cron:/);
  // The same mirrored service image, so both runs test the same PostgreSQL builds.
  const image = /image: (\S+ci-postgres:\$\{\{ matrix\.postgres \}\}-alpine)/;
  assert.equal(image.exec(nightly)?.[1], image.exec(WORKFLOW)?.[1]);
  assert.deepEqual(parse(nightly).jobs.integration.strategy.matrix.postgres, [16, 17]);
});

test("every package database test file runs in full in PR Checks or is listed with a reason (VAY-2427)", () => {
  // A walker regression would silently pass with nothing to check.
  assert.ok(PACKAGE_FILES.length >= 120, `only ${PACKAGE_FILES.length} package files found`);
  const uncovered = PACKAGE_FILES.filter(
    ({ workspace, path, file }) =>
      !PACKAGE_COVERAGE.get(workspace).full.has(file) && !(path in PACKAGE_NOT_IN_CI),
  ).map(({ path }) => path);
  assert.deepEqual(
    uncovered,
    [],
    "run the file in a pr-checks.yml step with a test database, or explain it in PACKAGE_NOT_IN_CI",
  );
});

test("the package not-in-CI list names database test files with a ticket and is not stale", () => {
  const byPath = new Map(PACKAGE_FILES.map((entry) => [entry.path, entry]));
  for (const [path, reason] of Object.entries(PACKAGE_NOT_IN_CI)) {
    const entry = byPath.get(path);
    assert.ok(entry, `${path} is not a package database test file`);
    assert.match(reason, /VAY-\d+/, `${path}: name the ticket that removes it from the list`);
    assert.ok(
      !PACKAGE_COVERAGE.get(entry.workspace).full.has(entry.file),
      `${path} runs in PR Checks: drop it from PACKAGE_NOT_IN_CI`,
    );
  }
});

test("pr-checks.yml names only existing package test files", () => {
  for (const [workspace, coverage] of PACKAGE_COVERAGE) {
    for (const file of [...coverage.full, ...coverage.filteredOnly]) {
      const path = `${PACKAGE_DIRS.get(workspace)}${file}`;
      assert.ok(existsSync(join(ROOT, path)), `${WORKFLOW_FILE} names a missing file: ${path}`);
    }
  }
});
