import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import {
  BROWSER_E2E_JOBS,
  FRONTEND_ONLY_PACKAGES,
  RULES,
  SELECTABLE_JOBS,
  WORKFLOW_FILE,
  selectJobs,
  verifyRequiredChecks,
  workflowChangeJobs,
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

const BROWSER_E2E = ["pms_web_e2e", "marketplace_web_e2e", "booking_web_e2e"];

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
      ["apps/marketplace-web/app/page.tsx", "tests/e2e/marketplace-web/setup-activation.spec.ts"],
      "marketplace_web_e2e",
    ],
    [
      ["apps/booking-web/app/layout.tsx", "tests/e2e/booking-web/tenant-smoke.spec.ts"],
      "booking_web_e2e",
    ],
  ]) {
    for (const file of files) {
      assert.deepEqual(selectJobs([file]).jobs, [...FRONTEND, "first_party_auth", job], file);
    }
  }
});

test("the apps/api read model a marketplace-web spec imports also runs that project", () => {
  assert.deepEqual(selectJobs(["apps/api/src/domains/pmsRoomFactsReadModel.ts"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    "marketplace_web_e2e",
    ...TYPESCRIPT.slice(3),
  ]);
});

test("shared e2e mocks and helpers run every mocked browser project", () => {
  for (const file of [
    "tests/e2e/support/pmsWebMocks.ts",
    "tests/e2e/support/adaptiveSetupOwnerReads.ts",
    "tests/e2e/helpers/cookie-settings.ts",
    "tests/e2e/marketplace-web/utils/cors.ts",
  ]) {
    assert.deepEqual(
      selectJobs([file]).jobs,
      [...FRONTEND, "first_party_auth", ...BROWSER_E2E],
      file,
    );
  }
});

test("frontend-only changes skip the PostgreSQL and Python jobs", () => {
  assert.deepEqual(selectJobs(["apps/booking-admin/app/page.tsx"]).jobs, [
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

// Replaces exactly one occurrence, so a fixture edit fails loudly when the workflow moves on.
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

const jobsForEdit = (...edits) => {
  const after = edits.reduce((text, edit) => edit(text), WORKFLOW);
  return workflowChangeJobs(WORKFLOW, after, workflowDiff(WORKFLOW, after));
};

const PMS_BATCH_LAST_FILE = "          src/platform/workosWebhooks.integration.test.ts\n";
const addPmsBatchFile = once(
  PMS_BATCH_LAST_FILE,
  `${PMS_BATCH_LAST_FILE}          src/newSuite.integration.test.ts\n`,
);

test("a pr-checks.yml edit inside one job block runs that job and frontend", () => {
  assert.deepEqual(jobsForEdit(addPmsBatchFile), ["frontend", "api_postgres"]);
  assert.deepEqual(
    jobsForEdit(once("run: python -m pytest tests/ -v --tb=short", "run: python -m pytest tests/")),
    ["frontend", "backend"],
  );
  // A deleted line maps through the old file.
  assert.deepEqual(jobsForEdit(once("          src/propertySetupDraftCommand.test.ts\n", "")), [
    "frontend",
    "setup_draft_reset_postgres",
  ]);
  // A comment inside a job is part of that job (a folded `run: >-` line could start with #).
  assert.deepEqual(
    jobsForEdit(
      once("      # Pricing on the ordinary login (VAY-2057).", "      # Pricing (VAY-2057)."),
    ),
    ["frontend", "api_postgres"],
  );
});

test("edits in several job blocks run the union of those jobs", () => {
  assert.deepEqual(
    jobsForEdit(
      addPmsBatchFile,
      once("          src/propertySetupDraftCommand.test.ts\n", ""),
      once(
        "        run: npm run test:unit-suites\n",
        "        run: npm run test:unit-suites -- \n",
      ),
    ),
    ["frontend", "api_unit", "api_postgres", "setup_draft_reset_postgres"],
  );
});

test("a comment between jobs changes nothing but frontend", () => {
  assert.deepEqual(
    jobsForEdit(
      once(
        "  # Steps without a `matrix.shard` condition",
        "  # Steps with no `matrix.shard` condition",
      ),
    ),
    ["frontend"],
  );
});

test("pr-checks.yml edits outside the selectable job blocks run every job", () => {
  const edits = {
    "trigger branches": once('      - "fix/**"\n', '      - "fix/**"\n      - "hotfix/**"\n'),
    concurrency: once("  cancel-in-progress: true", "  cancel-in-progress: false"),
    "a top-level comment": once("# Job selection is path-based", "# Job selection is file-based"),
    "the changes job": once(
      "        run: node scripts/ci/pr-checks.mjs select",
      "        run: node scripts/ci/pr-checks.mjs select --verbose",
    ),
    "the required job": once(
      "    timeout-minutes: 5\n    needs:\n",
      "    timeout-minutes: 6\n    needs:\n",
    ),
    "a new job": once(
      "  required:\n",
      "  lint_yaml:\n    runs-on: ubuntu-latest\n    steps: []\n\n  required:\n",
    ),
    "a renamed job key": once("  api_unit:\n", "  api_units:\n"),
    "a YAML anchor inside one job": once(
      "        run: npm run test:unit-suites\n",
      "        run: &unit npm run test:unit-suites\n",
    ),
  };
  for (const [what, edit] of Object.entries(edits)) assert.equal(jobsForEdit(edit), null, what);
});

test("an added, deleted or undiffable pr-checks.yml runs every job", () => {
  const after = addPmsBatchFile(WORKFLOW);
  const diff = workflowDiff(WORKFLOW, after);
  assert.equal(workflowChangeJobs(null, after, diff), null);
  assert.equal(workflowChangeJobs(WORKFLOW, null, diff), null);
  assert.equal(workflowChangeJobs(WORKFLOW, after, ""), null);
  assert.equal(workflowChangeJobs(WORKFLOW, after, undefined), null);
});

test("the current pr-checks.yml has no YAML anchors, so job-block selection applies", () => {
  assert.doesNotMatch(WORKFLOW, /(^|\s)[&*][A-Za-z_][\w-]*(\s|$)|<<\s*:/m);
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
  writeFileSync(join(dir, WORKFLOW_FILE), WORKFLOW);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "pr");
  writeFileSync(join(dir, WORKFLOW_FILE), editWorkflow(WORKFLOW));
  git("commit", "-q", "-am", "pr");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "README.md"), "the base branch moved on\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base moves");
  git("merge", "-q", "--no-ff", "-m", "merge pr", "pr");
  return dir;
}

function runSelectCli(dir, event) {
  const output = join(dir, "github-output");
  const result = spawnSync(process.execPath, [cli, "select"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: event },
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
  const dir = pullRequestMergeRepo(addPmsBatchFile);
  assert.deepEqual(runSelectCli(dir, "pull_request"), ["frontend", "api_postgres"]);
  assert.deepEqual(
    runSelectCli(pullRequestMergeRepo(once("  api_unit:\n", "  api_units:\n")), "pull_request"),
    ALL,
  );
});

test("the select CLI runs every job for any event other than pull_request", () => {
  const dir = pullRequestMergeRepo(addPmsBatchFile);
  for (const event of ["merge_group", "push", "workflow_dispatch"]) {
    assert.deepEqual(runSelectCli(dir, event), ALL, event);
  }
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

test("an edit to one half of the frontend job runs only that half (and frontend)", () => {
  assert.deepEqual(
    jobsForEdit(once("        run: npm run lint\n", "        run: npm run lint -- --quiet\n")),
    ["frontend"],
  );
  assert.deepEqual(
    jobsForEdit(
      once(
        "        run: npm --workspace vayada-admin run test\n",
        "        run: npm --workspace vayada-admin run test -- --reporter=dot\n",
      ),
    ),
    ["frontend", "frontend_build"],
  );
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
  ]);
  assert.deepEqual(selectJobs(["packages/settings-ui/package.json"]).jobs, [
    ...FRONTEND,
    "first_party_auth",
    "pms_web_e2e",
    "marketplace_web_e2e",
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
const CONFIG_FILE = /\.(?:json|ya?ml|css)$/;

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

const APP_BROWSER_JOB = {
  "apps/pms-web": "pms_web_e2e",
  "apps/marketplace-web": "marketplace_web_e2e",
  "apps/booking-web": "booking_web_e2e",
};
const ROOT_SCRIPTS = JSON.parse(read("package.json")).scripts;
const API_SCRIPTS = WORKSPACES.find((ws) => ws.dir === "apps/api").scripts;
const workspacesIn = (script) => [...script.matchAll(/--workspace[= ](\S+)/g)].map((m) => m[1]);

test("frontend-only package rules match the dependents declared in every package.json", () => {
  const unitSuites = workspacesIn(ROOT_SCRIPTS["test:unit-suites"]);
  const backendBuild = workspacesIn(API_SCRIPTS["build:backend-packages"]);
  for (const [dir, jobs] of Object.entries(FRONTEND_ONLY_PACKAGES)) {
    const pkg = WORKSPACES.find((ws) => ws.dir === `packages/${dir}`);
    assert.ok(pkg, `packages/${dir} is not a workspace`);
    const dependents = dependentsOf(pkg.name);
    for (const ws of dependents) {
      assert.ok(
        ws.dir !== "apps/api" && !ws.dir.startsWith("packages/backend-"),
        `${ws.dir} depends on ${pkg.name}: remove it from FRONTEND_ONLY_PACKAGES`,
      );
    }
    assert.ok(!backendBuild.includes(pkg.name), `build:backend-packages builds ${pkg.name}`);
    const expected = new Set(dependents.map((ws) => APP_BROWSER_JOB[ws.dir]).filter(Boolean));
    if ([pkg, ...dependents].some((ws) => unitSuites.includes(ws.name))) expected.add("api_unit");
    assert.deepEqual(
      [...jobs].sort(),
      [...expected].sort(),
      `FRONTEND_ONLY_PACKAGES["${dir}"] must list the jobs of ${dependents.map((ws) => ws.dir).join(", ") || "no app"}`,
    );
  }
});

// Files outside a frontend-only package that may still name it: they run in a job that every
// frontend-only rule selects, or in none.
const PACKAGE_REFERENCE_ALLOWED = [
  /^scripts\/ci\/pr-checks(\.test)?\.mjs$/, // this selector
  /^tests\/e2e\/first-party-auth\//, // first_party_auth
  /^\.github\/workflows\/deploy-[\w-]+\.yml$/, // deploy path filters, not run by PR checks
  /^tools\/hotel-import-simulator\//, // a local tool no PR check runs
  // Playwright projects no PR check runs (the Playwright guard below pins the ones that do).
  /^tests\/e2e\/(booking-admin|vayada-admin|next-stack-smoke|booking-public-canary)\//,
];

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'`]([^"'`]+)["'`]/gm;

test("nothing outside their dependents reaches a frontend-only package", () => {
  const problems = [];
  for (const dir of Object.keys(FRONTEND_ONLY_PACKAGES)) {
    const pkg = WORKSPACES.find((ws) => ws.dir === `packages/${dir}`);
    const reachable = new Set([pkg.dir, ...dependentsOf(pkg.name).map((ws) => ws.dir)]);
    const nameOrPath = new RegExp(
      `${pkg.name.replace("/", "\\/")}(?![\\w-])|packages/${dir}(?![\\w-])`,
    );
    for (const file of FILES) {
      const ws = workspaceOf(file);
      if (ws && reachable.has(ws.dir)) continue;
      if (file === "package.json") continue; // the root scripts; checked by the test above
      if (file === WORKFLOW_FILE) continue; // checked per job below
      if (PACKAGE_REFERENCE_ALLOWED.some((pattern) => pattern.test(file))) continue;
      const text = read(file);
      if (nameOrPath.test(text)) problems.push(`${file} names ${pkg.name}`);
      if (!CODE_FILE.test(file)) continue;
      for (const [, specifier] of text.matchAll(IMPORT_SPECIFIER)) {
        if (!specifier.startsWith(".")) continue;
        const target = relative(ROOT, resolve(dirname(join(ROOT, file)), specifier));
        if (target.split("\\").join("/").startsWith(`${pkg.dir}/`))
          problems.push(`${file} imports ${specifier}`);
      }
    }
    const rule = selectJobs([`${pkg.dir}/src/index.ts`]).jobs;
    for (const [id, job] of Object.entries(parse(WORKFLOW).jobs)) {
      if (nameOrPath.test(JSON.stringify(job)) && !rule.includes(id))
        problems.push(`pr-checks.yml job ${id} names ${pkg.name}`);
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
    (file) => CODE_FILE.test(file) && /\.?github\/workflows/.test(read(file)),
  );
  for (const file of readers) {
    assert.ok(
      Object.keys(WORKFLOW_READERS).some((dir) => file.startsWith(dir)),
      `${file} reads workflow files: add the job that runs it to the other-workflows rule`,
    );
  }
  const workflow = parse(WORKFLOW);
  const rule = selectJobs([".github/workflows/deploy-landing.yml"]).jobs;
  for (const command of Object.values(WORKFLOW_READERS)) {
    const jobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.steps?.some((step) => step.run?.includes(command)))
      .map(([id]) => id);
    assert.ok(jobs.length > 0, `no job runs ${command}`);
    for (const job of jobs) assert.ok(rule.includes(job), `${job} runs ${command}`);
  }
  // A local reusable workflow or action would make another workflow file part of PR checks.
  assert.doesNotMatch(WORKFLOW, /uses:\s*\.\//);
});

test("only the Playwright jobs run Playwright, and nothing imports the root config", () => {
  const workflow = parse(WORKFLOW);
  const rule = selectJobs(["playwright.config.ts"]).jobs;
  const projects = new Set();
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const runs = (job.steps ?? []).map((step) => step.run ?? "").join("\n");
    for (const [, project] of runs.matchAll(/npm run e2e:([\w-]+)/g)) projects.add(project);
    if (/playwright|\be2e:/.test(runs)) assert.ok(rule.includes(id), `${id} runs Playwright`);
  }
  // The unrun projects are allowed to name frontend-only packages (PACKAGE_REFERENCE_ALLOWED).
  assert.deepEqual([...projects].sort(), [
    "booking-web",
    "first-party-auth",
    "landing",
    "marketplace-web",
    "pms-web",
  ]);
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
  assert.equal(required.if, "always()");
  assert.deepEqual([...required.needs].sort(), ["changes", ...SELECTABLE_JOBS].sort());
  const verify = required.steps.find((step) => step.run?.includes("pr-checks.mjs verify"));
  assert.equal(verify.env.NEEDS, "${{ toJSON(needs) }}");
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
