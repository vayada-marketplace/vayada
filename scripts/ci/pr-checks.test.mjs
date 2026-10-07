import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { SELECTABLE_JOBS, selectJobs, verifyRequiredChecks } from "./pr-checks.mjs";

const ALL = [...SELECTABLE_JOBS];
const TYPESCRIPT = ["frontend", "first_party_auth", "api_postgres", "setup_draft_reset_postgres"];

test("docs and inventory-only changes select no jobs", () => {
  const files = [
    "README.md",
    "apps/api/README.md",
    "engineering/hotel-setup-bootstrap-images.json",
    "engineering/evidence/vay-794/pms-runtime-health-2026-06-15.json",
    "engineering/code-quality-gates.md",
    ".agents/skills/work-on-linear-ticket/SKILL.md",
    ".coderabbit.yaml",
  ];
  assert.deepEqual(selectJobs(files).jobs, []);
});

test("TypeScript API, shared packages and migrations run full PostgreSQL coverage", () => {
  for (const file of [
    "apps/api/src/server.ts",
    "packages/backend-migration/migrations/0400_new.sql",
    "packages/domain-hotels/src/index.ts",
  ]) {
    assert.deepEqual(selectJobs([file]).jobs, TYPESCRIPT, file);
  }
});

test("frontend-only changes skip the PostgreSQL and Python jobs", () => {
  assert.deepEqual(selectJobs(["apps/marketplace-web/app/page.tsx"]).jobs, [
    "frontend",
    "first_party_auth",
  ]);
  assert.deepEqual(selectJobs(["tests/e2e/first-party-auth/login.spec.ts"]).jobs, [
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

test("every API PostgreSQL step belongs to exactly one shard or runs in all of them", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/pr-checks.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs.api_postgres;
  const shards = job.strategy.matrix.shard;
  assert.deepEqual(shards, ["platform", "pms", "hotel-setup"]);
  const perShard = Object.fromEntries(shards.map((shard) => [shard, 0]));
  for (const step of job.steps) {
    if (!step.if) continue;
    const match = /^matrix\.shard == '([a-z-]+)'$/.exec(step.if);
    assert.ok(match && shards.includes(match[1]), `${step.name}: unexpected condition ${step.if}`);
    perShard[match[1]] += 1;
  }
  for (const shard of shards) assert.ok(perShard[shard] > 0, `${shard} has no steps`);
  const names = job.steps.map((step) => step.name);
  // The fresh-cluster RLS proof must precede migrations; the RDS-like creator proof must be last.
  assert.ok(
    names.indexOf("Verify setup reader RLS helper grants on a fresh cluster") <
      names.indexOf("Apply target migrations"),
  );
  assert.equal(names.at(-1), "Verify protected logo lifecycle with an RDS-like creator");
});
