import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LineCounter, isAlias, parse, parseDocument, visit } from "yaml";
import {
  SELECTABLE_JOBS,
  WORKFLOW_FILE,
  YAML_ANCHOR,
  selectJobs,
  verifyRequiredChecks,
  workflowChangeJobs,
  workflowLineJobs,
} from "./pr-checks.mjs";

const ALL = [...SELECTABLE_JOBS];
const TYPESCRIPT = [
  "frontend",
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
    "packages/product-onboarding/src/index.ts",
    "packages/settings-ui/src/index.ts",
  ]) {
    assert.deepEqual(
      selectJobs([file]).jobs,
      ["frontend", "first_party_auth", ...BROWSER_E2E, ...TYPESCRIPT.slice(2)],
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
      assert.deepEqual(selectJobs([file]).jobs, ["frontend", "first_party_auth", job], file);
    }
  }
});

test("the apps/api read model a marketplace-web spec imports also runs that project", () => {
  assert.deepEqual(selectJobs(["apps/api/src/domains/pmsRoomFactsReadModel.ts"]).jobs, [
    "frontend",
    "first_party_auth",
    "marketplace_web_e2e",
    ...TYPESCRIPT.slice(2),
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
      ["frontend", "first_party_auth", ...BROWSER_E2E],
      file,
    );
  }
});

test("frontend-only changes skip the PostgreSQL and Python jobs", () => {
  assert.deepEqual(selectJobs(["apps/booking-admin/app/page.tsx"]).jobs, [
    "frontend",
    "first_party_auth",
  ]);
  assert.deepEqual(selectJobs(["tests/e2e/first-party-auth/login.spec.ts"]).jobs, [
    "frontend",
    "first_party_auth",
  ]);
  assert.deepEqual(selectJobs(["tests/e2e/landing/smoke.spec.ts"]).jobs, [
    "frontend",
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
    ["frontend", "first_party_auth", "backend"],
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
  assert.deepEqual(runSelectCli(pullRequestMergeRepo(addSuite), "pull_request"), [
    "frontend",
    "api_postgres",
  ]);
  const renamed = pullRequestMergeRepo(once("  api_unit:\n", "  api_units:\n"));
  assert.deepEqual(runSelectCli(renamed, "pull_request"), ALL);
});

test("the select CLI runs every job for any event other than pull_request", () => {
  const dir = pullRequestMergeRepo(addSuite);
  for (const event of ["merge_group", "push", "workflow_dispatch"]) {
    assert.deepEqual(runSelectCli(dir, event), ALL, event);
  }
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
