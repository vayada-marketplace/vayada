#!/usr/bin/env node
// Path-based job selection and the fail-closed aggregator for .github/workflows/pr-checks.yml.
//
//   node scripts/ci/pr-checks.mjs select   # "changes" job: writes run_<job>=true|false outputs
//   node scripts/ci/pr-checks.mjs verify   # "Required Checks" job: exits 1 unless every job passed
//   node scripts/ci/pr-checks.mjs hold     # "Required Checks" on merge_group: waits out a hold
//
// No dependencies on purpose: both jobs run before (or without) `npm ci`.
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SELECTABLE_JOBS = [
  "frontend",
  "frontend_build",
  "first_party_auth",
  "pms_web_e2e",
  "booking_web_e2e",
  "booking_admin_e2e",
  "api_unit",
  "api_postgres",
  "setup_draft_reset_postgres",
  "backend",
];

// The two halves of the old frontend job: typecheck, lint and package tests; build and the tests
// of the built apps. A path that needs one needs both.
const FRONTEND_JOBS = ["frontend", "frontend_build"];

const TYPESCRIPT_JOBS = [
  ...FRONTEND_JOBS,
  "first_party_auth",
  "api_unit",
  "api_postgres",
  "setup_draft_reset_postgres",
];

// The mocked Playwright projects that gate PRs (one dev server each, no backend).
export const BROWSER_E2E_JOBS = ["pms_web_e2e", "booking_web_e2e", "booking_admin_e2e"];

// A pull request into another pull request's branch (a stack) runs only these quick jobs of its
// selection: typecheck, lint, build, unit suites and the auth contracts. Main is gated by its own
// pull request, which runs the full selection once the stack collapses into it, and by the merge
// queue, which runs again before main moves. The label runs the full selection on a stacked PR.
export const STACKED_PR_JOBS = ["frontend", "frontend_build", "first_party_auth", "api_unit"];
export const FULL_CI_LABEL = "full-ci";

// Packages that neither apps/api nor any backend package depends on, with the extra jobs their
// changes need: the browser projects of the apps that use them, and api_unit when
// test:unit-suites runs their tests. frontend, frontend_build and first_party_auth always run too. The guard
// tests in pr-checks.test.mjs recompute this from every package.json and fail when anything
// else starts to reach one of these packages.
export const FRONTEND_ONLY_PACKAGES = {
  // booking-admin, booking-web, pms-web, vayada-admin
  "product-onboarding": BROWSER_E2E_JOBS,
  // booking-admin, pms-web
  "feature-hub": ["pms_web_e2e", "booking_admin_e2e"],
  // booking-admin, pms-web; its tests are in test:unit-suites
  "settings-ui": ["pms_web_e2e", "booking_admin_e2e", "api_unit"],
  // booking-web, pms-web
  "locale-ui": ["pms_web_e2e", "booking_web_e2e"],
  // booking-admin, booking-web, landing, pms-web, vayada-admin
  fonts: BROWSER_E2E_JOBS,
  // no app; its tests are in test:unit-suites
  "pms-vayada-adapter": ["api_unit"],
};

// The first matching rule decides what a changed file selects. A file that matches no rule
// selects every job, so new directories and tooling changes fail safe (run everything).
export const RULES = [
  { name: "docs", test: /(^|\/)[^/]+\.md$/, jobs: [] },
  { name: "docs", test: /^(LICENSE|\.gitignore|\.coderabbit\.yaml)$/, jobs: [] },
  { name: "docs", test: /^\.agents\//, jobs: [] },
  { name: "evidence", test: /^engineering\/evidence\//, jobs: [] },
  // Other workflows only reach PR checks through tests that read them: the pr-checks and
  // coordinated-release contracts (frontend) and first-party-auth/production-config.spec.ts
  // (first_party_auth). pr-checks.yml itself is handled by selectJobs.
  {
    name: "other-workflows",
    test: /^\.github\/workflows\/(?!pr-checks\.yml$)[^/]+\.ya?ml$/,
    jobs: ["frontend", "first_party_auth"],
  },
  // Only the Playwright runs read the root config: landing (frontend_build), first-party auth and the
  // three mocked browser projects.
  {
    name: "playwright-config",
    test: /^playwright\.config\.ts$/,
    jobs: [...FRONTEND_JOBS, "first_party_auth", ...BROWSER_E2E_JOBS],
  },
  {
    name: "python-backend",
    test: /^apps\/(booking-api|pms-api)\//,
    jobs: ["backend"],
  },
  // pms_web_e2e, booking_web_e2e and booking_admin_e2e run each app's mocked Playwright project.
  {
    name: "pms-web",
    test: /^apps\/pms-web\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "pms_web_e2e"],
  },
  {
    name: "booking-admin",
    test: /^apps\/booking-admin\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "booking_admin_e2e"],
  },
  {
    name: "booking-web",
    test: /^apps\/booking-web\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "booking_web_e2e"],
  },
  {
    name: "frontend",
    test: /^apps\/(vayada-admin|landing)\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth"],
  },
  {
    name: "pms-web-e2e",
    test: /^tests\/e2e\/pms-web\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "pms_web_e2e"],
  },
  // Shared mocks and helpers: every mocked browser project imports from these.
  {
    name: "browser-e2e-support",
    test: /^tests\/e2e\/(support|helpers)\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", ...BROWSER_E2E_JOBS],
  },
  {
    name: "booking-web-e2e",
    test: /^tests\/e2e\/booking-web\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "booking_web_e2e"],
  },
  {
    name: "booking-admin-e2e",
    test: /^tests\/e2e\/booking-admin\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth", "booking_admin_e2e"],
  },
  // frontend_build runs the landing Playwright suite; first_party_auth runs the auth suite. The
  // other projects here are not PR-gated. A new folder under tests/e2e/ matches no rule (every job).
  {
    name: "e2e",
    test: /^tests\/e2e\/(landing|first-party-auth|vayada-admin|next-stack-smoke|booking-public-canary)\//,
    jobs: [...FRONTEND_JOBS, "first_party_auth"],
  },
  ...Object.entries(FRONTEND_ONLY_PACKAGES).map(([name, jobs]) => ({
    name: `frontend-only package ${name}`,
    test: new RegExp(`^packages/${name}/`),
    jobs: [...FRONTEND_JOBS, "first_party_auth", ...jobs],
  })),
  // Packages the apps build on (everything but backend-*) also run the mocked browser projects.
  {
    name: "frontend-packages",
    test: /^packages\/(?!backend-)/,
    jobs: [...TYPESCRIPT_JOBS, ...BROWSER_E2E_JOBS],
  },
  // apps/api, backend packages and packages/backend-migration/migrations: the full unit suites
  // plus PG16 + PG17 coverage.
  { name: "typescript", test: /^(apps\/api|packages)\//, jobs: TYPESCRIPT_JOBS },
];

export const WORKFLOW_FILE = ".github/workflows/pr-checks.yml";

// GitHub Actions accepts YAML anchors, aliases and merge keys. A block shared that way would let
// an edit inside one job change another, so any of them in either version runs every job. Anchor
// names may hold any character but whitespace and flow indicators; a false match (say, a shell
// line starting with `&&`) only runs every job.
export const YAML_ANCHOR = /(^[ \t]*|:[ \t]+|-[ \t]+|[[{,][ \t]*)[&*][^\s[\]{},]+|<<\s*:/m;

// Maps each line (index = 1-based line number) of pr-checks.yml to the job whose block it is in.
// Everything that is not inside one job maps to null: lines before `jobs:`, other top-level
// keys, job key lines, and anything indented less than a job's own keys. Comment lines at indent
// 0-2 under `jobs:` map to "#": YAML cannot nest them inside a job, so they change nothing.
export function workflowLineJobs(text) {
  const lines = [undefined];
  let inJobs = false;
  let job = null;
  for (const line of text.split("\n")) {
    if (inJobs && /^ {0,2}#/.test(line)) {
      lines.push("#");
    } else if (/^\S/.test(line)) {
      inJobs = /^jobs:\s*$/.test(line);
      job = null;
      lines.push(null);
    } else if (inJobs && /^ {2}[A-Za-z_][\w-]*\s*:/.test(line)) {
      job = /^ {2}([A-Za-z_][\w-]*)/.exec(line)[1];
      lines.push(null);
    } else if (/^\s*$/.test(line)) {
      lines.push(inJobs ? job : null);
    } else if (inJobs && /^ {4}/.test(line)) {
      lines.push(job);
    } else {
      // Anything else under jobs: (a quoted or oddly indented key, say) ends the current block.
      job = null;
      lines.push(null);
    }
  }
  return lines;
}

// The jobs an edit to pr-checks.yml can affect, from the file before and after and their -U0
// diff, or null when the edit is not confined to selectable job blocks (run every job). Jobs only
// interact through needs/outputs, which live in the "changes" and "required" blocks, and through
// YAML anchors; both fall back to every job. Frontend always runs because its pr-checks contract
// tests parse this file.
export function workflowChangeJobs(before, after, diff) {
  if (typeof before !== "string" || typeof after !== "string" || typeof diff !== "string") {
    return null;
  }
  if (YAML_ANCHOR.test(before) || YAML_ANCHOR.test(after)) return null;
  const hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  if (hunks.length === 0) return null;
  const oldLines = workflowLineJobs(before);
  const newLines = workflowLineJobs(after);
  const touched = new Set();
  for (const [, oldStart, oldCount = "1", newStart, newCount = "1"] of hunks) {
    for (let line = +oldStart; line < +oldStart + +oldCount; line++) touched.add(oldLines[line]);
    for (let line = +newStart; line < +newStart + +newCount; line++) touched.add(newLines[line]);
  }
  touched.delete("#");
  if (![...touched].every((job) => SELECTABLE_JOBS.includes(job))) return null;
  return SELECTABLE_JOBS.filter((job) => job === "frontend" || touched.has(job));
}

// `workflowJobs` is workflowChangeJobs() for this change; without it a pr-checks.yml edit runs
// every job.
export function selectJobs(files, { workflowJobs = null } = {}) {
  const selected = new Set();
  const reasons = [];
  if (!files || files.length === 0) {
    reasons.push("no changed files could be determined: running every job");
    return { jobs: [...SELECTABLE_JOBS], reasons };
  }
  for (const file of files) {
    if (file === WORKFLOW_FILE) {
      for (const job of workflowJobs ?? SELECTABLE_JOBS) selected.add(job);
      reasons.push(
        workflowJobs
          ? `${file}: only job blocks changed (${workflowJobs.join(", ")})`
          : `${file}: changed outside job blocks (runs every job)`,
      );
      continue;
    }
    const rule = RULES.find((candidate) => candidate.test.test(file));
    for (const job of rule ? rule.jobs : SELECTABLE_JOBS) selected.add(job);
    reasons.push(`${file}: ${rule ? rule.name : "unclassified (runs every job)"}`);
  }
  return { jobs: SELECTABLE_JOBS.filter((job) => selected.has(job)), reasons };
}

// Narrows a pull request's selection to STACKED_PR_JOBS when its base is another branch than main.
// An unknown base, the label, and every other event keep the full selection.
export function stackedSelection(jobs, { event, baseRef, fullCi }) {
  if (event !== "pull_request" || !baseRef || baseRef === "main" || fullCi) {
    return { jobs, reason: null };
  }
  return {
    jobs: jobs.filter((job) => STACKED_PR_JOBS.includes(job)),
    reason: `stacked on ${baseRef}: only ${STACKED_PR_JOBS.join(", ")} (label ${FULL_CI_LABEL} runs every selected job)`,
  };
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

// Merge queue pause (VAY-2241). While an open issue carries this label, a queued entry's
// "Required Checks" waits in `hold` instead of passing, so nothing merges into main while a release
// is being cut; the entry keeps its place and its finished checks. Labels can only be set by users
// with triage access, by issue templates or forms that name the label (there are none; a test
// guards that) and by apps with issue write access. A stray hold only delays merges, so every open
// labelled issue counts.
export const HOLD_LABEL = "release-train-hold";

export function openHolds(issues) {
  return issues.filter((issue) => issue.state === "open" && !issue.pull_request);
}

// Resolves once no hold is open. A failed read counts as "still held" (fail closed). Rejects at the
// deadline, which must stay below the ruleset's status check timeout so the reason is reported.
export async function waitWhileHeld({ listHolds, sleep, now, maxWaitMs, pollMs, log }) {
  const started = now();
  let reported = null;
  for (;;) {
    let state;
    try {
      const holds = await listHolds();
      if (holds.length === 0) return;
      state = holds.map((issue) => issue.html_url).join(", ");
    } catch (error) {
      state = `could not read holds (${error.message})`;
    }
    const waited = Math.round((now() - started) / 60_000);
    if (state !== reported) log(`merge queue hold: ${state}; waiting (${waited} min so far)`);
    reported = state;
    if (now() - started >= maxWaitMs)
      throw new Error(`release hold still open after ${waited} min: ${state}`);
    await sleep(pollMs);
  }
}

// The changed files and the pr-checks.yml job-block change of a pull request: HEAD is GitHub's
// merge commit, so HEAD^1 is the base branch tip and diffing from it is exactly the PR's "Files
// changed" view. Needs fetch-depth >= 2. Any git failure throws, and the caller runs every job.
export function changedFiles({ cwd } = {}) {
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const from = "HEAD^1";
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/).length - 1;
  if (parents !== 2)
    throw new Error(`HEAD has ${parents} parent(s); expected a pull request merge commit`);
  const files = git(["diff", "--name-only", "--no-renames", "-z", from, "HEAD"])
    .split("\0")
    .filter(Boolean);
  let workflowJobs = null;
  if (files.includes(WORKFLOW_FILE)) {
    const show = (rev) => {
      try {
        return git(["show", `${rev}:${WORKFLOW_FILE}`]);
      } catch {
        return null; // added or deleted: workflowChangeJobs runs every job
      }
    };
    const diff = git(["diff", "--no-ext-diff", "-U0", from, "HEAD", "--", WORKFLOW_FILE]);
    workflowJobs = workflowChangeJobs(show(from), show("HEAD"), diff);
  }
  return { files, workflowJobs };
}

function emit(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  else console.log(line);
}

function runSelect() {
  let changes = { files: null };
  // Only a pull request is narrowed to its changed files (see changedFiles). Every other event runs
  // every job: a manual run, a trigger added later, and the merge queue (VAY-2287), whose run on
  // the exact commit main fast-forwards to then serves as the release precheck.
  const event = process.env.GITHUB_EVENT_NAME || "pull_request";
  if (event !== "pull_request") {
    console.error(`${event} event: running every job`);
  } else {
    try {
      changes = changedFiles();
    } catch (error) {
      console.error(
        `::warning::Could not determine changed files, running every job: ${error.message}`,
      );
    }
  }
  const selection = selectJobs(changes.files, changes);
  const { jobs, reason } = stackedSelection(selection.jobs, {
    event,
    baseRef: process.env.GITHUB_BASE_REF,
    fullCi: process.env.PR_FULL_CI === "true",
  });
  const reasons = reason ? [...selection.reasons, reason] : selection.reasons;
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

async function runHold() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token } = process.env;
  if (!repository || !token) throw new Error("hold needs GITHUB_REPOSITORY and GH_TOKEN");
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  const url = `${api}/repos/${repository}/issues?state=open&labels=${HOLD_LABEL}&per_page=100`;
  // Every queued entry polls while held, and the token's hourly budget is shared by the whole
  // repository, so repeat reads are conditional: a 304 reply does not count against it.
  let cached = null;
  const listHolds = async () => {
    const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
    if (cached) headers["if-none-match"] = cached.etag;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (response.status === 304 && cached) return cached.holds;
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    const holds = openHolds(await response.json());
    const etag = response.headers.get("etag");
    cached = etag ? { etag, holds } : null;
    return holds;
  };
  await waitWhileHeld({
    listHolds,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    maxWaitMs: Number(process.env.HOLD_MAX_WAIT_MINUTES || 120) * 60_000,
    pollMs: Number(process.env.HOLD_POLL_SECONDS || 60) * 1000,
    log: (line) => console.error(line),
  });
  console.error("No merge queue hold is open.");
}

const commands = { select: runSelect, verify: runVerify, hold: runHold };
// Compare real paths so a symlinked invocation can never turn the CLI into a silent no-op.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.error("usage: pr-checks.mjs <select|verify|hold>");
    process.exit(2);
  }
  Promise.resolve()
    .then(command)
    .catch((error) => {
      console.error(`::error::${error.message}`);
      process.exit(1);
    });
}
