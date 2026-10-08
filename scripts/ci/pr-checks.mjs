#!/usr/bin/env node
// Path-based job selection and the fail-closed aggregator for .github/workflows/pr-checks.yml.
//
//   node scripts/ci/pr-checks.mjs select   # "changes" job: writes run_<job>=true|false outputs
//   node scripts/ci/pr-checks.mjs verify   # "Required Checks" job: exits 1 unless every job passed
//
// No dependencies on purpose: both jobs run before (or without) `npm ci`.
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SELECTABLE_JOBS = [
  "frontend",
  "first_party_auth",
  "api_postgres",
  "setup_draft_reset_postgres",
  "backend",
];

const TYPESCRIPT_JOBS = [
  "frontend",
  "first_party_auth",
  "api_postgres",
  "setup_draft_reset_postgres",
];

// The first matching rule decides what a changed file selects. A file that matches no rule
// selects every job, so new directories and tooling changes fail safe (run everything).
export const RULES = [
  { name: "docs", test: /(^|\/)[^/]+\.md$/, jobs: [] },
  { name: "docs", test: /^(LICENSE|\.gitignore|\.coderabbit\.yaml)$/, jobs: [] },
  { name: "docs", test: /^\.agents\//, jobs: [] },
  { name: "evidence", test: /^engineering\/evidence\//, jobs: [] },
  {
    name: "python-backend",
    test: /^apps\/(marketplace-api|booking-api|pms-api)\//,
    jobs: ["backend"],
  },
  {
    name: "frontend",
    test: /^apps\/(marketplace-web|vayada-admin|booking-web|booking-admin|pms-web|landing)\//,
    jobs: ["frontend", "first_party_auth"],
  },
  // The frontend job runs the landing Playwright suite; first_party_auth runs the auth suite.
  { name: "e2e", test: /^tests\/e2e\//, jobs: ["frontend", "first_party_auth"] },
  // apps/api, shared packages and packages/backend-migration/migrations: full PG16 + PG17 coverage.
  { name: "typescript", test: /^(apps\/api|packages)\//, jobs: TYPESCRIPT_JOBS },
];

export function selectJobs(files) {
  const selected = new Set();
  const reasons = [];
  if (!files || files.length === 0) {
    reasons.push("no changed files could be determined: running every job");
    return { jobs: [...SELECTABLE_JOBS], reasons };
  }
  for (const file of files) {
    const rule = RULES.find((candidate) => candidate.test.test(file));
    for (const job of rule ? rule.jobs : SELECTABLE_JOBS) selected.add(job);
    reasons.push(`${file}: ${rule ? rule.name : "unclassified (runs every job)"}`);
  }
  return { jobs: SELECTABLE_JOBS.filter((job) => selected.has(job)), reasons };
}

// `needs` is the workflow's needs context. A job passes only when it succeeded, or when it was
// skipped because the "changes" job set run_<job>=false. Failure, cancellation (which is how a
// timed-out job reports), an unexpected skip, a missing job and a failed "changes" job all fail.
export function verifyRequiredChecks(needs) {
  const problems = [];
  const changes = needs.changes;
  if (changes?.result !== "success") {
    problems.push(`changes: ${changes?.result ?? "missing"} (job selection must succeed)`);
  }
  const outputs = changes?.outputs ?? {};
  const jobs = new Set([
    ...SELECTABLE_JOBS,
    ...Object.keys(needs).filter((name) => name !== "changes"),
  ]);
  for (const job of jobs) {
    const result = needs[job]?.result;
    const selected = outputs[`run_${job}`];
    if (result === "success") continue;
    if (result === "skipped" && selected === "false") continue;
    problems.push(`${job}: ${result ?? "missing"} (run_${job}=${selected ?? "unset"})`);
  }
  return problems;
}

// On pull_request events HEAD is GitHub's merge commit, so HEAD^1 is the base branch tip and
// `git diff HEAD^1 HEAD` is exactly the PR's "Files changed" view. Needs fetch-depth >= 2.
function changedFiles() {
  const git = (args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/).length - 1;
  if (parents !== 2)
    throw new Error(`HEAD has ${parents} parent(s); expected a pull request merge commit`);
  return git(["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"])
    .split("\0")
    .filter(Boolean);
}

function emit(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  else console.log(line);
}

function runSelect() {
  let files = null;
  try {
    files = changedFiles();
  } catch (error) {
    console.error(
      `::warning::Could not determine changed files, running every job: ${error.message}`,
    );
  }
  const { jobs, reasons } = selectJobs(files);
  for (const line of [...reasons, `selected jobs: ${jobs.join(", ") || "none"}`])
    console.error(line);
  for (const job of SELECTABLE_JOBS) emit(`run_${job}=${jobs.includes(job)}`);
}

function runVerify() {
  if (!process.env.NEEDS) throw new Error("NEEDS must contain the toJSON(needs) context");
  const needs = JSON.parse(process.env.NEEDS);
  const problems = verifyRequiredChecks(needs);
  for (const [job, { result }] of Object.entries(needs)) console.error(`${job}: ${result}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.error("All required jobs succeeded or were legitimately skipped.");
}

const commands = { select: runSelect, verify: runVerify };
// Compare real paths so a symlinked invocation can never turn the CLI into a silent no-op.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.error("usage: pr-checks.mjs <select|verify>");
    process.exit(2);
  }
  command();
}
