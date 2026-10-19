import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LineCounter, isAlias, parse, parseDocument, visit } from "yaml";
import {
  BROWSER_E2E_JOBS,
  FRONTEND_ONLY_PACKAGES,
  FULL_CI_LABEL,
  HOLD_LABEL,
  RULES,
  SELECTABLE_JOBS,
  STACKED_PR_JOBS,
  WORKFLOW_FILE,
  YAML_ANCHOR,
  openHolds,
  selectJobs,
  stackedSelection,
  verifyRequiredChecks,
  waitWhileHeld,
  workflowChangeJobs,
  workflowLineJobs,
} from "./pr-checks.mjs";

const ALL = [...SELECTABLE_JOBS];
const FRONTEND = ["frontend", "frontend_build"];
const TYPESCRIPT = [
  ...FRONTEND,
  "first_party_auth",
  "api_unit",
  "api_postgres",
  "setup_draft_reset_postgres",
];

test("docs-only changes select no jobs", () => {
  const files = [
    "README.md",
    "apps/api/README.md",
    "engineering/evidence/vay-794/pms-runtime-health-2026-06-15.json",
    "engineering/code-quality-gates.md",
    ".agents/skills/work-on-linear-ticket/SKILL.md",
    ".coderabbit.yaml",
  ];
  assert.deepEqual(selectJobs(files).jobs, []);
});

test("TypeScript API, backend packages and migrations run the unit suites and full PostgreSQL coverage", () => {
  for (const file of [
    "apps/api/src/server.ts",
    "packages/backend-migration/migrations/0400_new.sql",
    "packages/backend-auth/src/index.ts",
  ]) {
    assert.deepEqual(selectJobs([file]).jobs, TYPESCRIPT, file);
  }
});

const BROWSER_E2E = ["pms_web_e2e", "booking_web_e2e", "booking_admin_e2e"];

test("packages the apps build on also run the mocked browser projects", () => {
  for (const file of [
    "packages/domain-hotels/src/index.ts",
    "packages/domain-booking/src/index.ts",
    "packages/locale-constants/src/index.ts",
  ]) {
    assert.deepEqual(
      selectJobs([file]).jobs,
      [...FRONTEND, "first_party_auth", ...BROWSER_E2E, ...TYPESCRIPT.slice(3)],
      file,
    );
  }
});

test("each app and its own browser specs run only that app's browser project", () => {
  for (const [files, job] of [
    [["apps/pms-web/app/(app)/layout.tsx", "tests/e2e/pms-web/smoke.spec.ts"], "pms_web_e2e"],
    [
      ["apps/booking-web/app/layout.tsx", "tests/e2e/booking-web/tenant-smoke.spec.ts"],
      "booking_web_e2e",
    ],
    [
      ["apps/booking-admin/app/page.tsx", "tests/e2e/booking-admin/setup.spec.ts"],
      "booking_admin_e2e",
    ],
  ]) {
    for (const file of files) {
      assert.deepEqual(selectJobs([file]).jobs, [...FRONTEND, "first_party_auth", job], file);
    }
  }
});

test("shared e2e mocks and helpers run every mocked browser project", () => {
  for (const file of [
    "tests/e2e/support/pmsWebMocks.ts",
    "tests/e2e/support/adaptiveSetupOwnerReads.ts",
    "tests/e2e/helpers/cookie-settings.ts",
    "tests/e2e/support/cors.ts",
  ]) {
    assert.deepEqual(
      selectJobs([file]).jobs,
      [...FRONTEND, "first_party_auth", ...BROWSER_E2E],
      file,
    );
  }
});

test("frontend-only changes skip the PostgreSQL and Python jobs", () => {
  assert.deepEqual(selectJobs(["apps/vayada-admin/app/page.tsx"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
  ]);
  assert.deepEqual(selectJobs(["tests/e2e/first-party-auth/login.spec.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
  ]);
  assert.deepEqual(selectJobs(["tests/e2e/landing/smoke.spec.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
  ]);
});

test("Python backend changes run only the backend matrix", () => {
  assert.deepEqual(
    selectJobs(["apps/pms-api/app/main.py", "apps/booking-api/migrations/0001.sql"]).jobs,
    ["backend"],
  );
});

test("anything unclassified runs every job", () => {
  for (const file of [
    ".github/workflows/pr-checks.yml",
    "scripts/ci/pr-checks.mjs",
    "package-lock.json",
    "engineering/deployment-contract/manifest-v1.schema.json",
    "engineering/fixtures/platform-media-upload/cases.json",
    "auth-db/migrations/0001.sql",
    "tsconfig.base.json",
    "Dockerfile.md.txt",
    "tests/e2e/fixtures/shared-room.json",
  ]) {
    assert.deepEqual(selectJobs([file]).jobs, ALL, file);
  }
});

test("mixed changes take the union and an unknown file list runs everything", () => {
  assert.deepEqual(
    selectJobs(["README.md", "apps/pms-api/app/main.py", "apps/landing/app/page.tsx"]).jobs,
    [...FRONTEND, "first_party_auth", "backend"],
  );
  assert.deepEqual(selectJobs(null).jobs, ALL);
  assert.deepEqual(selectJobs([]).jobs, ALL);
});

const cli = new URL("./pr-checks.mjs", import.meta.url).pathname;
const WORKFLOW = readFileSync(new URL(`../../${WORKFLOW_FILE}`, import.meta.url), "utf8");

// Replaces exactly one occurrence, so a fixture edit fails loudly when the text moves on.
const once = (from, to) => (text) => {
  assert.equal(text.split(from).length, 2, `expected exactly one ${JSON.stringify(from)}`);
  return text.replace(from, to);
};

// The -U0 diff git prints for an edit, as the "changes" job reads it.
function workflowDiff(before, after) {
  const dir = mkdtempSync(join(tmpdir(), "pr-checks-diff-"));
  writeFileSync(join(dir, "before.yml"), before);
  writeFileSync(join(dir, "after.yml"), after);
  const args = ["diff", "--no-index", "--no-ext-diff", "-U0", "before.yml", "after.yml"];
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  return result.stdout;
}

const jobsForEdit = (before, ...edits) => {
  const after = edits.reduce((text, edit) => edit(text), before);
  return workflowChangeJobs(before, after, workflowDiff(before, after));
};

// The shape of pr-checks.yml in a few lines, so these cases survive edits to the real file.
const FIXTURE = [
  "name: PR Checks",
  "on:",
  "  pull_request:",
  '    branches: [main, "fm/**"]',
  "concurrency:",
  "  group: pr-checks-${{ github.ref }}",
  "  cancel-in-progress: true",
  "# Job selection is path-based.",
  "jobs:",
  "  changes:",
  "    runs-on: ubuntu-latest",
  "    outputs:",
  "      run_frontend: ${{ steps.select.outputs.run_frontend }}",
  "    steps:",
  "      - id: select",
  "        run: node scripts/ci/pr-checks.mjs select",
  "",
  "  frontend:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Lint",
  "        run: npm run lint",
  "",
  "  api_unit:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm run test:unit-suites",
  "",
  "  # Each shard gets its own cluster.",
  "  api_postgres:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      # Suites on the ordinary login.",
  "      - name: Run suites",
  "        run: >-",
  "          npm test --",
  "          src/a.integration.test.ts",
  "          src/b.integration.test.ts",
  "",
  "  backend:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: python -m pytest tests/ -v",
  "",
  "  required:",
  "    name: Required Checks",
  "    needs: [changes, frontend, api_unit, api_postgres, backend]",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: node scripts/ci/pr-checks.mjs verify",
  "",
].join("\n");

const addSuite = once(
  "          src/b.integration.test.ts\n",
  "          src/b.integration.test.ts\n          src/c.integration.test.ts\n",
);

test("a pr-checks.yml edit inside one job block runs that job and frontend", () => {
  assert.deepEqual(jobsForEdit(FIXTURE, addSuite), ["frontend", "api_postgres"]);
  assert.deepEqual(jobsForEdit(FIXTURE, once("tests/ -v", "tests/")), ["frontend", "backend"]);
  assert.deepEqual(jobsForEdit(FIXTURE, once("npm run lint", "npm run lint -- --quiet")), [
    "frontend",
  ]);
  // A deleted line maps through the old file.
  assert.deepEqual(jobsForEdit(FIXTURE, once("          src/a.integration.test.ts\n", "")), [
    "frontend",
    "api_postgres",
  ]);
  // A comment inside a job is part of that job (a folded `run: >-` line could start with #).
  assert.deepEqual(jobsForEdit(FIXTURE, once("# Suites on the", "# Suites for the")), [
    "frontend",
    "api_postgres",
  ]);
});

test("edits in several job blocks run the union of those jobs", () => {
  assert.deepEqual(
    jobsForEdit(
      FIXTURE,
      addSuite,
      once("test:unit-suites", "test:unit-suites -- --bail"),
      once("tests/ -v", "tests/"),
    ),
    ["frontend", "api_unit", "api_postgres", "backend"],
  );
});

test("a comment between jobs changes nothing but frontend", () => {
  assert.deepEqual(jobsForEdit(FIXTURE, once("its own cluster", "a fresh cluster")), ["frontend"]);
});

test("pr-checks.yml edits outside the selectable job blocks run every job", () => {
  const edits = {
    "trigger branches": once('[main, "fm/**"]', '[main, "fm/**", "fix/**"]'),
    concurrency: once("cancel-in-progress: true", "cancel-in-progress: false"),
    "a top-level comment": once("# Job selection is path-based.", "# Job selection is file-based."),
    "the changes job": once("pr-checks.mjs select", "pr-checks.mjs select --verbose"),
    "the required job": once("pr-checks.mjs verify", "pr-checks.mjs verify --strict"),
    "a new job": once("  required:\n", "  lint_yaml:\n    runs-on: ubuntu-latest\n\n  required:\n"),
    "a renamed job key": once("  api_unit:\n", "  api_units:\n"),
    "a quoted job key": once("  api_unit:\n", '  "api_unit":\n'),
    "an anchor and its alias": (text) =>
      once(
        "npm run lint",
        "npm run lint\n        env: &shared.env {A: b}",
      )(once("tests/ -v", "tests/ -v\n        env: *shared.env")(text)),
  };
  for (const [what, edit] of Object.entries(edits)) {
    assert.equal(jobsForEdit(FIXTURE, edit), null, what);
  }
});

test("lines after a quoted or oddly indented job key never count as the job before it", () => {
  const quoted = once("  api_postgres:\n", '  "api_postgres":\n')(FIXTURE);
  assert.equal(jobsForEdit(quoted, once("          src/a.integration.test.ts\n", "")), null);
});

test("any YAML anchor, alias or merge key in either version runs every job", () => {
  for (const anchored of [
    "env: &pg.env {A: b}",
    "env: *pg.env",
    "x: &1 a",
    "list: [&a x, *a]",
    "m: {y: *a}",
    "<<: *base",
  ]) {
    const before = once("npm run lint", `npm run lint\n        ${anchored}`)(FIXTURE);
    assert.equal(jobsForEdit(before, once("tests/ -v", "tests/")), null, anchored);
  }
});

test("an added, deleted or undiffable pr-checks.yml runs every job", () => {
  const after = addSuite(FIXTURE);
  const diff = workflowDiff(FIXTURE, after);
  assert.equal(workflowChangeJobs(null, after, diff), null);
  assert.equal(workflowChangeJobs(FIXTURE, null, diff), null);
  assert.equal(workflowChangeJobs(FIXTURE, after, ""), null);
  assert.equal(workflowChangeJobs(FIXTURE, after, undefined), null);
});

// Each job's block in the real file as the YAML parser sees it: key line and last line.
function parsedJobBlocks(text) {
  const lineCounter = new LineCounter();
  const jobs = parseDocument(text, { lineCounter }).get("jobs", true);
  return jobs.items.map((pair) => ({
    id: pair.key.value,
    keyLine: lineCounter.linePos(pair.key.range[0]).line,
    lastLine: lineCounter.linePos(pair.value.range[1] - 1).line,
  }));
}

test("workflowLineJobs agrees with the YAML parser on every line of the real pr-checks.yml", () => {
  const mapped = workflowLineJobs(WORKFLOW);
  const lines = WORKFLOW.split("\n");
  const owner = new Map();
  for (const { id, keyLine, lastLine } of parsedJobBlocks(WORKFLOW)) {
    assert.equal(mapped[keyLine], null, `${id} key line`);
    for (let line = keyLine + 1; line <= lastLine; line++) owner.set(line, id);
  }
  for (let line = 1; line <= lines.length; line++) {
    const text = lines[line - 1];
    if (/^\s*(#|$)/.test(text)) continue; // blank and comment lines change nothing on their own
    assert.equal(mapped[line], owner.get(line) ?? null, `line ${line}: ${text}`);
  }
});

test("a line added or removed in any job block of the real pr-checks.yml runs just that job", () => {
  for (const { id, lastLine } of parsedJobBlocks(WORKFLOW)) {
    if (!SELECTABLE_JOBS.includes(id)) continue;
    const lines = WORKFLOW.split("\n");
    const expected = id === "frontend" ? ["frontend"] : ["frontend", id];
    const added = [...lines.slice(0, lastLine), "        # probe", ...lines.slice(lastLine)];
    const removed = [...lines.slice(0, lastLine - 1), ...lines.slice(lastLine)];
    for (const after of [added.join("\n"), removed.join("\n")]) {
      assert.deepEqual(
        workflowChangeJobs(WORKFLOW, after, workflowDiff(WORKFLOW, after)),
        expected,
        id,
      );
    }
  }
});

test("the current pr-checks.yml has no YAML anchors or aliases, so job-block selection applies", () => {
  let found = 0;
  visit(parseDocument(WORKFLOW), (key, node) => {
    if (isAlias(node) || node?.anchor) found += 1;
  });
  assert.equal(found, 0);
  assert.doesNotMatch(WORKFLOW, YAML_ANCHOR);
});

test("a pr-checks.yml change selects its job blocks alongside the other changed files", () => {
  assert.deepEqual(
    selectJobs([WORKFLOW_FILE, "apps/pms-api/app/main.py"], {
      workflowJobs: ["frontend", "api_postgres"],
    }).jobs,
    ["frontend", "api_postgres", "backend"],
  );
  assert.deepEqual(selectJobs([WORKFLOW_FILE], { workflowJobs: null }).jobs, ALL);
  assert.deepEqual(selectJobs([WORKFLOW_FILE]).jobs, ALL);
});

// A repository whose HEAD is a pull request merge commit, as actions/checkout leaves it.
function pullRequestMergeRepo(editWorkflow) {
  const dir = mkdtempSync(join(tmpdir(), "pr-checks-repo-"));
  const git = (...args) => {
    const identity = ["-c", "user.name=ci", "-c", "user.email=ci@example.com"];
    const result = spawnSync("git", [...identity, "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, WORKFLOW_FILE), FIXTURE);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, WORKFLOW_FILE), editWorkflow(FIXTURE));
  git("commit", "-q", "-am", "pr");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "README.md"), "the base branch moved on\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base moves");
  git("merge", "-q", "--no-ff", "-m", "merge pr", "pr");
  return dir;
}

function runSelectCli(dir, event, env = {}) {
  const output = join(dir, "github-output");
  const result = spawnSync(process.execPath, [cli, "select"], {
    cwd: dir,
    encoding: "utf8",
    // CI runs these tests inside a pull_request job, whose own base ref must not leak in.
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: event,
      GITHUB_BASE_REF: "",
      PR_FULL_CI: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  return SELECTABLE_JOBS.filter((job) => outputs[`run_${job}`] === "true");
}

test("the select CLI runs only the edited job blocks of a pull request's pr-checks.yml", () => {
  assert.deepEqual(runSelectCli(pullRequestMergeRepo(addSuite), "pull_request"), [
    "frontend",
    "api_postgres",
  ]);
  const renamed = pullRequestMergeRepo(once("  api_unit:\n", "  api_units:\n"));
  assert.deepEqual(runSelectCli(renamed, "pull_request"), ALL);
});

test("the select CLI runs every job for a push or a manual run", () => {
  const dir = pullRequestMergeRepo(addSuite);
  for (const event of ["push", "workflow_dispatch"]) {
    assert.deepEqual(runSelectCli(dir, event), ALL, event);
  }
});

test("a pull request stacked on another branch runs only the quick jobs of its selection", () => {
  const stacked = { event: "pull_request", baseRef: "fm/vay-1-parent", fullCi: false };
  assert.deepEqual(stackedSelection(ALL, stacked).jobs, STACKED_PR_JOBS);
  assert.deepEqual(stackedSelection([], stacked).jobs, []);
  assert.deepEqual(stackedSelection(["api_postgres", "backend"], stacked).jobs, []);
  assert.match(stackedSelection(ALL, stacked).reason, new RegExp(`label ${FULL_CI_LABEL}`));
  // The quick jobs: nothing with a database, a browser project or the Python apps.
  for (const job of STACKED_PR_JOBS) assert.ok(SELECTABLE_JOBS.includes(job), job);
  for (const job of [
    "api_postgres",
    "setup_draft_reset_postgres",
    "backend",
    ...BROWSER_E2E_JOBS,
  ]) {
    assert.ok(!STACKED_PR_JOBS.includes(job), job);
  }
});

test("pull requests into main, labelled or base-less ones and other events keep the full selection", () => {
  for (const options of [
    { event: "pull_request", baseRef: "main", fullCi: false },
    { event: "pull_request", baseRef: "fm/vay-1-parent", fullCi: true },
    { event: "pull_request", baseRef: "", fullCi: false },
    { event: "pull_request", baseRef: undefined, fullCi: false },
    { event: "merge_group", baseRef: "fm/vay-1-parent", fullCi: false },
    { event: "workflow_dispatch", baseRef: "fm/vay-1-parent", fullCi: false },
  ]) {
    assert.deepEqual(
      stackedSelection(ALL, options),
      { jobs: ALL, reason: null },
      JSON.stringify(options),
    );
  }
});

test("the select CLI narrows a stacked pull request unless it carries the full-ci label", () => {
  const dir = pullRequestMergeRepo(once("  api_unit:\n", "  api_units:\n"));
  const stacked = { GITHUB_BASE_REF: "fm/vay-1-parent" };
  assert.deepEqual(runSelectCli(dir, "pull_request", stacked), STACKED_PR_JOBS);
  assert.deepEqual(runSelectCli(dir, "pull_request", { ...stacked, PR_FULL_CI: "true" }), ALL);
  assert.deepEqual(runSelectCli(dir, "pull_request", { GITHUB_BASE_REF: "main" }), ALL);
  assert.deepEqual(runSelectCli(dir, "workflow_dispatch", stacked), ALL);
});

test("every path rule that runs frontend also runs frontend_build", () => {
  for (const rule of RULES) {
    // Workflow files are read only by contract tests in the frontend job (guard test below).
    if (rule.name === "other-workflows") continue;
    assert.equal(
      rule.jobs.includes("frontend"),
      rule.jobs.includes("frontend_build"),
      `${rule.name}: frontend and frontend_build go together`,
    );
  }
});

// The merge queue runs every job (VAY-2287): main fast-forwards to the commit the queue tested, so
// the release precheck reuses that run instead of dispatching its own on the same commit.
test("a queued entry runs every job, whatever its pull request selected", () => {
  const dir = pullRequestMergeRepo(addSuite);
  assert.deepEqual(runSelectCli(dir, "pull_request"), ["frontend", "api_postgres"]);
  assert.deepEqual(runSelectCli(dir, "merge_group"), ALL);
});

test("other workflow files run the jobs whose tests read workflow files", () => {
  for (const file of [
    ".github/workflows/deploy-next-pms-web.yml",
    ".github/workflows/build-coordinated-release.yml",
    ".github/workflows/main-unit-suites.yml",
  ]) {
    assert.deepEqual(selectJobs([file]).jobs, ["frontend", "first_party_auth"], file);
  }
  // Not a workflow file directly under .github/workflows: unclassified.
  assert.deepEqual(selectJobs([".github/actions/setup/action.yml"]).jobs, ALL);
});

test("the root Playwright config runs every Playwright job and nothing else", () => {
  assert.deepEqual(selectJobs(["playwright.config.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    ...BROWSER_E2E_JOBS,
  ]);
});

test("frontend-only packages run only the jobs of the apps that use them", () => {
  assert.deepEqual(selectJobs(["packages/product-onboarding/src/index.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    ...BROWSER_E2E_JOBS,
  ]);
  assert.deepEqual(selectJobs(["packages/feature-hub/src/index.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    "pms_web_e2e",
    "booking_admin_e2e",
  ]);
  assert.deepEqual(selectJobs(["packages/settings-ui/package.json"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    "pms_web_e2e",
    "booking_admin_e2e",
    "api_unit",
  ]);
  assert.deepEqual(selectJobs(["packages/pms-vayada-adapter/src/index.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    "api_unit",
  ]);
  // A neighbour with a similar name keeps the broad rule.
  assert.deepEqual(selectJobs(["packages/settings-ui-next/src/index.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    ...BROWSER_E2E_JOBS,
    ...TYPESCRIPT.slice(3),
  ]);
});

// ---- Guards: the narrower rules above stay true only while the repository looks like this.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".turbo",
]);
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|sh)$/;
// Dockerfiles stay out: PR checks never build an image (asserted below).
const CONFIG_FILE = /\.(?:json|ya?ml|css|scss|html|toml|ini|sql)$/;

// Every source and config file in the checkout, as repo-relative paths.
function repoFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) repoFiles(path, out);
    } else if (CODE_FILE.test(entry.name) || CONFIG_FILE.test(entry.name)) {
      const file = relative(ROOT, path).split("\\").join("/");
      if (file !== "package-lock.json" && !file.startsWith("engineering/evidence/")) out.push(file);
    }
  }
  return out;
}
const FILES = repoFiles();
const read = (file) => readFileSync(join(ROOT, file), "utf8");

function workspaces() {
  const list = [];
  for (const parent of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, parent))) {
      const manifest = join(ROOT, parent, name, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      const deps = new Set(
        ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
          (field) => Object.keys(json[field] ?? {}),
        ),
      );
      list.push({ dir: `${parent}/${name}`, name: json.name, deps, scripts: json.scripts ?? {} });
    }
  }
  return list;
}
const WORKSPACES = workspaces();
const workspaceOf = (file) => WORKSPACES.find((ws) => file.startsWith(`${ws.dir}/`));

// Workspaces that depend on `name`, directly or through other workspaces.
function dependentsOf(name) {
  const found = new Map();
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const ws of WORKSPACES) {
      if (ws.deps.has(current) && !found.has(ws.dir)) {
        found.set(ws.dir, ws);
        queue.push(ws.name);
      }
    }
  }
  return [...found.values()];
}

const FRONTEND_ONLY = Object.keys(FRONTEND_ONLY_PACKAGES).map((dir) => {
  const pkg = WORKSPACES.find((ws) => ws.dir === `packages/${dir}`);
  assert.ok(pkg, `packages/${dir} is not a workspace`);
  return pkg;
});
const ruleOf = (pkg) => selectJobs([`${pkg.dir}/src/index.ts`]).jobs;
const jobsOf = (file) => selectJobs([file]).jobs;

const APP_BROWSER_JOB = {
  "apps/pms-web": "pms_web_e2e",
  "apps/booking-web": "booking_web_e2e",
  "apps/booking-admin": "booking_admin_e2e",
};
const ROOT_SCRIPTS = JSON.parse(read("package.json")).scripts;
const API_SCRIPTS = WORKSPACES.find((ws) => ws.dir === "apps/api").scripts;
const workspacesIn = (script) =>
  [...script.matchAll(/(?:--workspace|-w)[= ](\S+)/g)].map((match) => match[1]);
const WORKFLOW_JOBS = parse(WORKFLOW).jobs;
const runText = (job) => (job.steps ?? []).map((step) => step.run ?? "").join("\n");
const npmRuns = (text) => [...text.matchAll(/npm run ([\w:.-]+)/g)].map((match) => match[1]);

// The root package.json scripts a job runs: `npm run <script>` in its steps, followed through
// nested `npm run` calls and pre/post hooks.
function rootScriptsRunBy(job) {
  const found = new Set();
  const queue = npmRuns(runText(job));
  while (queue.length > 0) {
    const name = queue.shift();
    for (const script of [`pre${name}`, name, `post${name}`]) {
      if (found.has(script) || ROOT_SCRIPTS[script] === undefined) continue;
      found.add(script);
      queue.push(...npmRuns(ROOT_SCRIPTS[script]));
    }
  }
  return [...found];
}

test("frontend-only package rules match the dependents declared in every package.json", () => {
  const unitSuites = workspacesIn(ROOT_SCRIPTS["test:unit-suites"]);
  const backendBuild = workspacesIn(API_SCRIPTS["build:backend-packages"]);
  for (const pkg of FRONTEND_ONLY) {
    const rule = ruleOf(pkg);
    const dependents = dependentsOf(pkg.name);
    for (const ws of dependents) {
      const frontendOnly = FRONTEND_ONLY.find((other) => other.dir === ws.dir);
      assert.ok(
        frontendOnly || (ws.dir.startsWith("apps/") && ws.dir !== "apps/api"),
        `${ws.dir} depends on ${pkg.name}: remove it from FRONTEND_ONLY_PACKAGES`,
      );
      for (const job of frontendOnly ? ruleOf(frontendOnly) : []) {
        assert.ok(rule.includes(job), `${ws.dir} runs ${job}, so ${pkg.name} must too`);
      }
    }
    for (const ws of [pkg, ...dependents]) {
      assert.ok(!backendBuild.includes(ws.name), `build:backend-packages builds ${ws.name}`);
    }
    const expected = new Set(dependents.map((ws) => APP_BROWSER_JOB[ws.dir]).filter(Boolean));
    if ([pkg, ...dependents].some((ws) => unitSuites.includes(ws.name))) expected.add("api_unit");
    assert.deepEqual(
      [...FRONTEND_ONLY_PACKAGES[pkg.dir.slice("packages/".length)]].sort(),
      [...expected].sort(),
      `${pkg.dir} must list the jobs of ${dependents.map((ws) => ws.dir).join(", ") || "no app"}`,
    );
    // npm ci runs install scripts in every job, including the ones this rule skips.
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.equal(pkg.scripts[hook], undefined, `${pkg.name} has a ${hook} script`);
    }
  }
});

// Files that may point at a frontend-only package even though their own changes run jobs its
// rule skips.
const PACKAGE_REFERENCE_ALLOWED = [
  /^scripts\/ci\/pr-checks(\.test)?\.mjs$/, // this selector
  /^tools\/hotel-import-simulator\//, // a local tool no PR check runs
];

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*|\bvi\.(?:mock|importActual)\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// How a file can point at a package: its npm name, `packages/<dir>`, `../<dir>`, or `"<dir>"` as
// a path segment of its own (join(root, "packages", "<dir>")).
function referenceTo(pkg) {
  const dir = pkg.dir.slice("packages/".length);
  return new RegExp(
    `${escapeRegExp(pkg.name)}(?![\\w-])|packages/${dir}(?![\\w-])|\\.\\./${dir}(?![\\w-])|["'\`]${dir}["'\`]`,
  );
}

test("nothing that a skipped job runs reaches a frontend-only package", () => {
  const problems = [];
  for (const pkg of FRONTEND_ONLY) {
    const rule = ruleOf(pkg);
    const reachable = new Set([pkg.dir, ...dependentsOf(pkg.name).map((ws) => ws.dir)]);
    const reference = referenceTo(pkg);
    for (const file of FILES) {
      const ws = workspaceOf(file);
      if (ws && reachable.has(ws.dir)) continue;
      // A change to this file runs only jobs that a change to the package runs anyway.
      if (jobsOf(file).every((job) => rule.includes(job))) continue;
      if (file === "package.json" || file === WORKFLOW_FILE) continue; // checked per job below
      if (PACKAGE_REFERENCE_ALLOWED.some((pattern) => pattern.test(file))) continue;
      const text = read(file);
      if (reference.test(text)) problems.push(`${file} names ${pkg.name}`);
      if (/packages\/\*/.test(text)) problems.push(`${file} globs packages/*`);
      if (!CODE_FILE.test(file)) continue;
      for (const [, specifier] of text.matchAll(IMPORT_SPECIFIER)) {
        if (!specifier.startsWith(".")) continue;
        const target = relative(ROOT, resolve(dirname(join(ROOT, file)), specifier));
        const into = workspaceOf(`${target.split("\\").join("/")}/`);
        if (into && reachable.has(into.dir)) {
          problems.push(`${file} imports ${specifier}, and ${into.dir} uses ${pkg.name}`);
        }
      }
    }
    for (const [id, job] of Object.entries(WORKFLOW_JOBS)) {
      if (!SELECTABLE_JOBS.includes(id) || rule.includes(id)) continue;
      if (reference.test(JSON.stringify(job))) problems.push(`pr-checks.yml job ${id} names it`);
      for (const script of rootScriptsRunBy(job)) {
        const text = ROOT_SCRIPTS[script];
        if (reference.test(text) || /--workspaces\b|(^|\s)-ws\b/.test(text)) {
          problems.push(`${id} runs the root script ${script}, which reaches ${pkg.name}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], "update FRONTEND_ONLY_PACKAGES or its allowed references");
});

// Where workflow files are read, and the jobs that run those readers.
const WORKFLOW_READERS = {
  "scripts/ci/": "npm run test:pr-checks",
  "scripts/coordinated-release/": "npm run test:coordinated-release",
  "tests/e2e/first-party-auth/": "npm run e2e:first-party-auth",
};

test("only the frontend and first-party auth jobs run code that reads workflow files", () => {
  const readers = FILES.filter(
    (file) => CODE_FILE.test(file) && /\.?github\/workflows|["'`]\.github["'`]/.test(read(file)),
  );
  for (const file of readers) {
    assert.ok(
      Object.keys(WORKFLOW_READERS).some((dir) => file.startsWith(dir)),
      `${file} reads workflow files: add the job that runs it to the other-workflows rule`,
    );
  }
  const rule = selectJobs([".github/workflows/deploy-landing.yml"]).jobs;
  for (const command of Object.values(WORKFLOW_READERS)) {
    const jobs = Object.entries(WORKFLOW_JOBS)
      .filter(([, job]) => runText(job).includes(command))
      .map(([id]) => id);
    assert.ok(jobs.length > 0, `no job runs ${command}`);
    for (const job of jobs) assert.ok(rule.includes(job), `${job} runs ${command}`);
  }
  // No other job may run code from those folders, directly or through a root script.
  for (const [id, job] of Object.entries(WORKFLOW_JOBS)) {
    if (!SELECTABLE_JOBS.includes(id) || rule.includes(id)) continue;
    const text = [runText(job), ...rootScriptsRunBy(job).map((s) => ROOT_SCRIPTS[s])].join("\n");
    for (const dir of Object.keys(WORKFLOW_READERS)) {
      assert.ok(!text.includes(dir), `${id} runs code from ${dir}`);
    }
  }
  // A local reusable workflow or action would make another workflow file part of PR checks.
  assert.doesNotMatch(WORKFLOW, /uses:\s*\.\//);
});

test("PR checks build no Docker image, so Dockerfiles cannot change what they test", () => {
  assert.doesNotMatch(WORKFLOW, /docker\s+(?:build|buildx|compose)|docker\/build-push-action/);
});

test("only the Playwright jobs run Playwright, and nothing imports the root config", () => {
  const rule = selectJobs(["playwright.config.ts"]).jobs;
  const projects = new Set();
  for (const [id, job] of Object.entries(WORKFLOW_JOBS)) {
    const runs = runText(job);
    for (const [, project] of runs.matchAll(/npm run e2e:([\w-]+)/g)) projects.add(project);
    if (/playwright|\be2e:/.test(runs)) assert.ok(rule.includes(id), `${id} runs Playwright`);
  }
  // The unrun projects are allowed to name frontend-only packages (PACKAGE_REFERENCE_ALLOWED).
  assert.deepEqual([...projects].sort(), [
    "booking-admin",
    "booking-web",
    "first-party-auth",
    "landing",
    "pms-web",
  ]);
  // Project patterns are unanchored (/booking-web\/.*\.spec\.ts/): a spec anywhere whose path
  // contains a PR-run project's folder runs in that project, so it must live in that folder.
  const config = read("playwright.config.ts");
  const patterns = Object.fromEntries(
    [...config.matchAll(/name: "([\w-]+)-chromium",\s*testMatch: \/((?:\\\/|[^/\n])+)\//g)].map(
      ([, name, source]) => [name, new RegExp(source)],
    ),
  );
  const specs = FILES.filter((file) => file.startsWith("tests/e2e/"));
  for (const project of projects) {
    assert.ok(patterns[project], `no testMatch for ${project}-chromium`);
    for (const spec of specs.filter((file) => patterns[project].test(file))) {
      assert.ok(spec.startsWith(`tests/e2e/${project}/`), `${spec} runs in ${project}-chromium`);
    }
  }
  const rootConfig = join(ROOT, "playwright.config");
  const importers = FILES.filter(
    (file) =>
      CODE_FILE.test(file) &&
      [...read(file).matchAll(IMPORT_SPECIFIER)].some(
        ([, specifier]) =>
          specifier.startsWith(".") &&
          resolve(dirname(join(ROOT, file)), specifier).replace(/\.ts$/, "") === rootConfig,
      ),
  );
  assert.deepEqual(importers, []);
});

const needsFor = (results, selected = ALL) => ({
  changes: {
    result: "success",
    outputs: Object.fromEntries(
      SELECTABLE_JOBS.map((job) => [`run_${job}`, String(selected.includes(job))]),
    ),
  },
  ...Object.fromEntries(SELECTABLE_JOBS.map((job) => [job, { result: results[job] ?? "success" }])),
});

test("verify passes when every job succeeded", () => {
  assert.deepEqual(verifyRequiredChecks(needsFor({})), []);
});

test("verify passes when a job was skipped because the change detector excluded it", () => {
  const needs = needsFor(
    { api_postgres: "skipped", setup_draft_reset_postgres: "skipped", backend: "skipped" },
    ["frontend", "first_party_auth"],
  );
  assert.deepEqual(verifyRequiredChecks(needs), []);
});

test("verify passes on the docs-only fast path where everything is skipped", () => {
  const skipped = Object.fromEntries(SELECTABLE_JOBS.map((job) => [job, "skipped"]));
  assert.deepEqual(verifyRequiredChecks(needsFor(skipped, [])), []);
});

test("verify fails when a selected job failed", () => {
  const problems = verifyRequiredChecks(needsFor({ api_postgres: "failure" }));
  assert.deepEqual(problems, ["api_postgres: failure (run_api_postgres=true)"]);
});

test("verify fails when a selected job was cancelled or timed out", () => {
  // A job that exceeds timeout-minutes reports `cancelled` in the needs context; a run cancelled
  // by concurrency reports the same. Neither may count as passing.
  assert.deepEqual(verifyRequiredChecks(needsFor({ frontend: "cancelled" })), [
    "frontend: cancelled (run_frontend=true)",
  ]);
  assert.deepEqual(verifyRequiredChecks(needsFor({ backend: "timed_out" })), [
    "backend: timed_out (run_backend=true)",
  ]);
});

test("verify fails when a job the detector selected was skipped anyway", () => {
  assert.deepEqual(verifyRequiredChecks(needsFor({ api_postgres: "skipped" })), [
    "api_postgres: skipped (run_api_postgres=true)",
  ]);
});

test("verify fails when the change detector did not succeed, even if jobs look skipped", () => {
  const skipped = Object.fromEntries(SELECTABLE_JOBS.map((job) => [job, "skipped"]));
  const needs = needsFor(skipped, []);
  needs.changes = { result: "failure", outputs: {} };
  const problems = verifyRequiredChecks(needs);
  assert.equal(problems[0], "changes: failure (job selection must succeed)");
  assert.equal(problems.length, 1 + SELECTABLE_JOBS.length);
  assert.ok(problems.includes("api_postgres: skipped (run_api_postgres=unset)"));
});

test("verify fails when a job is missing from needs or is not covered by a selector output", () => {
  const missing = needsFor({});
  delete missing.api_postgres;
  assert.deepEqual(verifyRequiredChecks(missing), [
    "api_postgres: missing (run_api_postgres=true)",
  ]);

  const extra = needsFor({});
  extra.new_job = { result: "skipped" };
  assert.deepEqual(verifyRequiredChecks(extra), ["new_job: skipped (run_new_job=unset)"]);
});

const runVerify = (needs, script = cli) =>
  spawnSync(process.execPath, [script, "verify"], {
    encoding: "utf8",
    env: { ...process.env, NEEDS: JSON.stringify(needs) },
  });

const hold = (number, extra = {}) => ({
  number,
  state: "open",
  html_url: `https://github.com/o/r/issues/${number}`,
  ...extra,
});

test("only open issues count as merge queue holds, never pull requests", () => {
  assert.equal(HOLD_LABEL, "release-train-hold");
  const issues = [hold(1), hold(2, { state: "closed" }), hold(3, { pull_request: {} })];
  assert.deepEqual(
    openHolds(issues).map((issue) => issue.number),
    [1],
  );
});

// A fake clock: sleep() advances time instantly. `reads` are the successive hold-list results;
// the last one repeats.
const holdHarness = (reads) => {
  let time = 0;
  const logs = [];
  const sleeps = [];
  return {
    logs,
    sleeps,
    options: {
      listHolds: async () => {
        const next = reads.length > 1 ? reads.shift() : reads[0];
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
      now: () => time,
      maxWaitMs: 120 * 60_000,
      pollMs: 60_000,
      log: (line) => logs.push(line),
    },
  };
};

test("the hold gate passes at once when no hold is open", async () => {
  const { options, sleeps, logs } = holdHarness([[]]);
  await waitWhileHeld(options);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(logs, []);
});

test("the hold gate waits while a hold is open and passes once it closes", async () => {
  const { options, sleeps, logs } = holdHarness([[hold(7)], [hold(7)], []]);
  await waitWhileHeld(options);
  assert.deepEqual(sleeps, [60_000, 60_000]);
  assert.deepEqual(logs, [
    "merge queue hold: https://github.com/o/r/issues/7; waiting (0 min so far)",
  ]);
});

test("the hold gate fails at the deadline and names the hold", async () => {
  const { options } = holdHarness([[hold(7)]]);
  await assert.rejects(
    waitWhileHeld(options),
    /^Error: release hold still open after 120 min: https:\/\/github.com\/o\/r\/issues\/7$/,
  );
});

test("the hold gate treats an unreadable hold list as held (fail closed)", async () => {
  const recovered = holdHarness([new Error("HTTP 502"), []]);
  await waitWhileHeld(recovered.options);
  assert.match(recovered.logs[0], /could not read holds \(HTTP 502\)/);

  const down = holdHarness([new Error("HTTP 502")]);
  await assert.rejects(
    waitWhileHeld(down.options),
    /still open after 120 min: could not read holds/,
  );
});

// Runs the hold CLI against a local stand-in for the GitHub issues API. `reply` maps the request
// number (0-based) and headers to { status, body, etag }.
const runHoldCli = async (reply, env = {}) => {
  const requests = [];
  const server = createServer((request, response) => {
    const answer = reply(requests.length, request.headers);
    requests.push({ url: request.url, headers: request.headers });
    response.statusCode = answer.status ?? 200;
    if (answer.etag) response.setHeader("etag", answer.etag);
    response.setHeader("content-type", "application/json");
    response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, [cli, "hold"], {
      timeout: 20_000,
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: "o/r",
        GH_TOKEN: "test-token",
        HOLD_POLL_SECONDS: "0.05",
        HOLD_MAX_WAIT_MINUTES: "0.005",
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on("close", resolve));
    return { status, stderr, requests };
  } finally {
    server.close();
  }
};

test("the hold CLI passes without a hold and asks for open release-train-hold issues", async () => {
  const result = await runHoldCli(() => ({ body: [hold(3, { pull_request: {} })] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No merge queue hold is open/);
  assert.equal(
    result.requests[0].url,
    "/repos/o/r/issues?state=open&labels=release-train-hold&per_page=100",
  );
  assert.equal(result.requests[0].headers.authorization, "Bearer test-token");
});

test("the hold CLI fails while a hold stays open past its deadline", async () => {
  const result = await runHoldCli(() => ({ body: [hold(9)] }));
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /::error::release hold still open after 0 min: https:\/\/github.com\/o\/r\/issues\/9/,
  );
  assert.ok(result.requests.length >= 2, "polls more than once before giving up");
});

test("the hold CLI counts an error reply as held", async () => {
  const result = await runHoldCli(() => ({ status: 500, body: { message: "boom" } }));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /still open after 0 min: could not read holds \(GET .* HTTP 500\)/);
});

test("the hold CLI repeats reads conditionally and keeps the cached holds on a 304", async () => {
  const result = await runHoldCli((index, headers) =>
    index === 0
      ? { body: [hold(4)], etag: '"v1"' }
      : headers["if-none-match"] === '"v1"'
        ? { status: 304 }
        : { body: [] },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /still open after 0 min: https:\/\/github.com\/o\/r\/issues\/4/);
  assert.equal(result.requests[1].headers["if-none-match"], '"v1"');
});

test("the hold CLI never treats a 304 without a cached reply as no hold", async () => {
  const result = await runHoldCli(() => ({ status: 304 }));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /could not read holds \(GET .* HTTP 304\)/);
  assert.ok(result.requests.every((request) => !request.headers["if-none-match"]));
});

test("the hold CLI reads unconditionally when a reply carried no ETag", async () => {
  const result = await runHoldCli(() => ({ body: [hold(5)] }));
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.requests.length >= 2);
  assert.ok(result.requests.every((request) => !request.headers["if-none-match"]));
});

test("the hold CLI refuses to run without a token", async () => {
  const result = await runHoldCli(() => ({ body: [] }), { GH_TOKEN: "" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::hold needs GITHUB_REPOSITORY and GH_TOKEN/);
});

test("no issue template applies the hold label, so only maintainers can pause the queue", () => {
  // Markdown templates and YAML issue forms both live here (or in ISSUE_TEMPLATE.md).
  const dir = join(ROOT, ".github/ISSUE_TEMPLATE");
  const templates = [
    ...(existsSync(dir) ? readdirSync(dir).map((name) => `.github/ISSUE_TEMPLATE/${name}`) : []),
    ...[".github/ISSUE_TEMPLATE.md", "ISSUE_TEMPLATE.md", "docs/ISSUE_TEMPLATE.md"].filter((file) =>
      existsSync(join(ROOT, file)),
    ),
  ];
  for (const file of templates) assert.ok(!read(file).includes(HOLD_LABEL), file);
});

test("the verify CLI exits non-zero on a failed job and zero when everything passed", () => {
  const failed = runVerify(needsFor({ api_postgres: "failure" }));
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /::error::api_postgres: failure/);
  const passed = runVerify(needsFor({}));
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /All required jobs succeeded/);
});

test("the verify CLI still runs (and fails) when invoked through a symlink", () => {
  const link = join(mkdtempSync(join(tmpdir(), "pr-checks-")), "pr-checks.mjs");
  symlinkSync(cli, link);
  const result = runVerify(needsFor({ frontend: "cancelled" }), link);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /::error::frontend: cancelled/);
});

test("the verify CLI refuses to run without the needs context", () => {
  const result = spawnSync(process.execPath, [cli, "verify"], {
    encoding: "utf8",
    env: { ...process.env, NEEDS: "" },
  });
  assert.notEqual(result.status, 0);
});

test("pr-checks.yml wires every job through the change detector and the aggregator", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8"),
  );
  const jobs = Object.keys(workflow.jobs);
  assert.deepEqual(jobs, ["changes", ...SELECTABLE_JOBS, "required"]);

  assert.deepEqual(
    Object.keys(workflow.jobs.changes.outputs),
    SELECTABLE_JOBS.map((job) => `run_${job}`),
  );
  for (const job of SELECTABLE_JOBS) {
    assert.deepEqual(workflow.jobs[job].needs, ["changes"], `${job} must depend only on changes`);
    assert.equal(
      workflow.jobs[job].if,
      `needs.changes.outputs.run_${job} == 'true'`,
      `${job} gate`,
    );
  }

  const required = workflow.jobs.required;
  assert.equal(required.name, "Required Checks");
  // The ruleset requires this status by name, so no other job may report it.
  assert.deepEqual(
    Object.keys(workflow.jobs).filter((id) => workflow.jobs[id].name === "Required Checks"),
    ["required"],
  );
  assert.equal(required.if, "always()");
  assert.deepEqual([...required.needs].sort(), ["changes", ...SELECTABLE_JOBS].sort());
  const verify = required.steps.find((step) => step.run?.includes("pr-checks.mjs verify"));
  assert.equal(verify.env.NEEDS, "${{ toJSON(needs) }}");
});

test("the select step reads the full-ci label of the pull request", () => {
  const select = parse(WORKFLOW).jobs.changes.steps.find((step) => step.id === "select");
  assert.equal(
    select.env.PR_FULL_CI,
    `\${{ contains(github.event.pull_request.labels.*.name, '${FULL_CI_LABEL}') }}`,
  );
});

// Closing a pull request (a stack collapsing into its bottom pull request) cancels its PR Checks
// run: the cancel workflow joins the group PR Checks uses for pull requests.
test("closing a pull request cancels its PR Checks run and reports nothing else", () => {
  const prChecks = parse(WORKFLOW);
  const cancel = parse(
    readFileSync(new URL("../../.github/workflows/pr-checks-cancel.yml", import.meta.url), "utf8"),
  );
  assert.equal(
    prChecks.concurrency.group,
    "pr-checks-${{ github.event.pull_request.number || github.ref }}",
  );
  assert.deepEqual(cancel.concurrency, {
    group: "pr-checks-${{ github.event.pull_request.number }}",
    "cancel-in-progress": true,
  });
  assert.deepEqual(Object.keys(cancel.on), ["pull_request"]);
  assert.deepEqual(cancel.on.pull_request.types, ["closed"]);
  assert.deepEqual(cancel.on.pull_request.branches, prChecks.on.pull_request.branches);
  assert.deepEqual(cancel.permissions, {});
  for (const job of Object.values(cancel.jobs)) {
    assert.notEqual(job.name, "Required Checks");
    for (const step of job.steps) assert.equal(step.uses, undefined, "runs no action or checkout");
  }
});

test("pr-checks.yml reports Required Checks to the merge queue and selects from a 2-deep checkout", () => {
  const workflow = parse(WORKFLOW);
  assert.deepEqual(workflow.on.merge_group, { types: ["checks_requested"], branches: ["main"] });
  assert.ok("workflow_dispatch" in workflow.on);
  const steps = workflow.jobs.changes.steps;
  assert.equal(steps[0].with["fetch-depth"], 2, "HEAD^1 of the pull request merge commit");
  const select = steps.find((step) => step.id === "select");
  assert.ok(steps.indexOf(select) > 0);
  assert.equal(select.env.MERGE_GROUP_BASE, undefined, "the queue no longer diffs");
});

test("Required Checks waits out a merge queue hold only after the jobs verified", () => {
  const required = parse(WORKFLOW).jobs.required;
  assert.equal(
    required["timeout-minutes"],
    "${{ github.event_name == 'merge_group' && 130 || 5 }}",
  );
  assert.deepEqual(required.permissions, { contents: "read", issues: "read" });
  const verify = required.steps.findIndex((step) => step.run?.includes("pr-checks.mjs verify"));
  const wait = required.steps.findIndex((step) => step.run?.includes("pr-checks.mjs hold"));
  assert.ok(verify >= 0 && wait === verify + 1, "the hold wait runs right after verify");
  assert.equal(required.steps[wait].if, "github.event_name == 'merge_group'");
  assert.equal(required.steps[wait].env.GH_TOKEN, "${{ github.token }}");
});

test("pr-checks.yml runs for main and every stacked base branch without per-ticket entries", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.on.pull_request.branches, [
    "main",
    "fm/**",
    "fix/**",
    "flamurmaliqi2811/**",
  ]);
});

test("every API PostgreSQL step belongs to exactly one shard or runs in all of them", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs.api_postgres;
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(shards, ["platform", "pms", "pricing", "hotel-setup"]);
  const perShard = Object.fromEntries(shards.map((shard) => [shard, 0]));
  for (const step of job.steps) {
    if (!step.if) continue;
    const match = /^matrix\.shard == '([a-z-]+)'$/.exec(step.if);
    assert.ok(match && shards.includes(match[1]), `${step.name}: unexpected condition ${step.if}`);
    perShard[match[1]] += 1;
  }
  for (const shard of shards) assert.ok(perShard[shard] > 0, `${shard} has no steps`);
});

// A step whose URL named another database would run its suites in a shared one without failing.
test("every API PostgreSQL step that creates its test database runs its suites there", () => {
  const workflow = parse(WORKFLOW);
  const isolated = workflow.jobs.api_postgres.steps.filter((step) => {
    const created = [...(step.run ?? "").matchAll(/CREATE DATABASE (\w+)/g)].map((m) => m[1]);
    return created.length === 1 && step.env?.TEST_DATABASE_URL;
  });
  for (const step of isolated) {
    const [, database] = /CREATE DATABASE (\w+)/.exec(step.run);
    assert.match(database, /_test$/, `${step.name}: Channex suites require a *_test database`);
    for (const name of ["TEST_DATABASE_URL", "TARGET_DATABASE_URL"]) {
      if (!step.env[name]) continue;
      assert.equal(new URL(step.env[name]).pathname, `/${database}`, `${step.name}: ${name}`);
    }
    if (step.run.includes("--workspace vayada-api run test")) {
      const migrate = step.run.indexOf("run target:migrate");
      assert.ok(
        migrate >= 0 && migrate < step.run.indexOf("--workspace vayada-api run test"),
        `${step.name}: migrates ${database} before its suites`,
      );
    }
  }
});

// The release precheck's isolated database blocks (VAY-2245). A workflow_dispatch of this workflow
// replaces that precheck, so each block keeps its own new database, both URLs and its exact files.
const PRECHECK_ISOLATED_BLOCKS = {
  vayada_booking_edit_test: ["src/routes/pendingBookingEdits.integration.test.ts"],
  vayada_role_test: ["src/pmsDashboardRoleAccess.integration.test.ts"],
  vayada_pay_settings_test: [
    "src/financePaymentSettingsOrdinary.integration.test.ts",
    "src/bookingAddonCurrencyOrdinary.integration.test.ts",
  ],
  vayada_conf_emails_test: ["src/domains/pmsConfirmationEmails.integration.test.ts"],
  vayada_fin_plan_test: [
    "src/financeBillingPlanOrdinary.integration.test.ts",
    "src/financeBillingPlanParity.integration.test.ts",
  ],
  vayada_fin_writers_test: [
    "src/domains/financePaymentWriters.integration.test.ts",
    "src/jobs/financeSubscriptions.integration.test.ts",
  ],
  vayada_public_profile_test: ["src/activeBookingPublicationProfile.integration.test.ts"],
  vayada_feature_hub_test: [
    "src/pmsBookingModules.integration.test.ts",
    "src/domains/replacementPromoCode.integration.test.ts",
    "src/domains/replacementAddons.integration.test.ts",
    "src/domains/pmsInventoryBundle.integration.test.ts",
    "src/platform/bookingFunnel.integration.test.ts",
  ],
  vayada_pub_cmd_test: ["src/domains/bookingPublicationCommandRepository.integration.test.ts"],
  vayada_guest_terms_test: ["src/domains/bookingGuestTermsStore.integration.test.ts"],
};

test("the release precheck's isolated database blocks keep their database, env and files", () => {
  const steps = parse(WORKFLOW).jobs.api_postgres.steps;
  for (const [database, files] of Object.entries(PRECHECK_ISOLATED_BLOCKS)) {
    const matches = steps.filter((step) =>
      new RegExp(`CREATE DATABASE ${database}\\b`).test(step.run ?? ""),
    );
    assert.equal(matches.length, 1, `${database}: exactly one step creates it`);
    const [step] = matches;
    assert.match(
      step.if ?? "",
      /^matrix\.shard == '[a-z-]+'$/,
      `${database}: runs on every dispatch`,
    );
    for (const name of ["TEST_DATABASE_URL", "TARGET_DATABASE_URL"]) {
      assert.equal(
        new URL(step.env?.[name] ?? "x:").pathname,
        `/${database}`,
        `${database}: ${name}`,
      );
    }
    assert.doesNotMatch(step.run, /\b[A-Z_]*DATABASE_URL=/, `${database}: no inline database URL`);
    const migrate = step.run.indexOf("run target:migrate");
    const suites = step.run.indexOf("--workspace vayada-api run test");
    assert.ok(migrate >= 0 && migrate < suites, `${database}: migrates before its suites`);
    assert.equal(step.run.indexOf("--workspace vayada-api run test", suites + 1), -1);
    assert.match(step.run.slice(suites), /run test -- --no-file-parallelism /);
    assert.deepEqual(
      [...step.run.matchAll(/\bsrc\/\S+\.test\.ts\b/g)].map((m) => m[0]).sort(),
      [...files].sort(),
      `${database}: suites`,
    );
  }
});
