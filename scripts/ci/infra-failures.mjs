#!/usr/bin/env node
// Weekly report of PR Checks jobs that failed for infrastructure reasons (VAY-2314), run every
// Monday by the CI Infra Report workflow. It reads the past week's PR Checks runs through the
// GitHub API and sorts every failed job, attempts a rerun replaced included, by the error in its
// failed step's log (or, for a job that ran out of time, its annotations). It then rewrites one
// GitHub issue, so a new flake source shows up as soon as it costs reruns. It also times the
// browser installs of the merge queue runs, which run every job.
//
//   node scripts/ci/infra-failures.mjs            # needs GITHUB_TOKEN, GITHUB_REPOSITORY
//   node scripts/ci/infra-failures.mjs --dry-run  # prints the report, touches no issue
//
// The report quotes no log text: this repository is public and logs carry what tests print. A run
// cancelled by a newer push is not read, even if a job had failed in it.
// No dependencies on purpose: the job runs without `npm ci`.
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BOT = "github-actions[bot]";
export const ISSUE_TITLE = "PR Checks: infrastructure failures, weekly";
export const ISSUE_LABELS = ["monitoring"];
export const MARKER = "<!-- ci-infra-failures -->";
export const WORKFLOW = "pr-checks.yml";
export const INSTALL_STEP = "Install Chromium";
// The GitHub token allows 1,000 API requests an hour per repository, shared with every other
// workflow (the merge queue's hold gate polls too). The report stops reading at either limit.
export const MAX_REQUESTS = 750;
export const RATE_RESERVE = 150;
// The window ends this long before the report, so it holds only finished runs; runs are at most
// about 2.5 hours long with a merge queue hold.
export const SETTLE_MS = 6 * 60 * 60 * 1000;

// Known infrastructure causes, by what a failed step's log shows. The first match wins, so the
// specific ones come first. Patterns name errors, never lines a passing job prints too (every
// browser install logs its cdn.playwright.dev URL).
export const CAUSES = [
  // Before Playwright: a failed apt-get inside `playwright install-deps` also ends in Playwright's
  // "Failed to install browsers".
  {
    key: "apt",
    label: "Ubuntu packages (apt)",
    test: /E: Failed to fetch|E: Unable to fetch some archives|Some index files failed to download/,
  },
  {
    key: "playwright",
    label: "Playwright browser download",
    test: /ERR_TLS_CERT_ALTNAME_INVALID|Failed to download (?:Chrome|Chromium|FFmpeg)|Download failed: server returned code|Failed to install browsers/,
  },
  {
    key: "image",
    label: "Container image pull",
    test: /toomanyrequests|Docker pull failed|manifest unknown/,
  },
  {
    key: "npm",
    label: "npm registry",
    test: /npm (?:ERR!|error) (?:code (?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|E429|E5\d\d)|network)/,
  },
  {
    key: "pip",
    label: "Python packages (pip)",
    test: /ReadTimeoutError|Could not fetch URL https:\/\/pypi|Max retries exceeded with url: \/simple/,
  },
  {
    key: "google-fonts",
    label: "Google Fonts at build time",
    test: /Failed to fetch font|NextFontGoogleFontFileReplacer/,
  },
  {
    // Only in the job's annotations: its log just ends.
    key: "timeout",
    label: "Job ran out of time",
    test: /exceeded the maximum execution time/,
  },
  {
    key: "runner",
    label: "Runner lost",
    test: /The runner has received a shutdown signal|lost communication with the server/,
  },
  {
    // pg-pool can end before a dropped login's sockets close (hotel-setup flake, #3179): the
    // tests pass, then vitest reports the 57P01 as an unhandled error. Passing suites print 57P01
    // too, and so does a failed or timed-out test's teardown.
    key: "pg-teardown",
    label: "PostgreSQL teardown (57P01)",
    test: (log) => {
      const unhandled = log.search(/Unhandled Errors?/);
      return (
        unhandled !== -1 &&
        /57P01|terminating connection due to administrator command/.test(log.slice(unhandled)) &&
        !/\bFAIL\b|Test timed out/.test(log)
      );
    },
  },
];

// A failure with no known cause in one of these steps is likely a new flake source. Steps that
// run the change (npm ci, builds, tests) are left out: they fail for the change's own reasons.
export const SETUP_STEP =
  /^(?:Set up job|Initialize containers|Checkout|Set up (?:Node|Python)|Install (?:Chromium|PostgreSQL client))/;

export function classify(text, failedSteps) {
  const cause = CAUSES.find(({ test }) =>
    typeof test === "function" ? test(text) : test.test(text),
  );
  if (cause) return cause.key;
  return failedSteps.some((step) => SETUP_STEP.test(step)) ? "setup" : "tests";
}

// The lines of a job log written while one of its failed steps ran, so an earlier step's
// recovered retry is never taken for the cause. Every log line starts with its timestamp; step
// times are whole seconds. Without usable step times, the whole log.
export function failedStepLog(log, steps) {
  const windows = (steps ?? [])
    .filter((step) => ["failure", "cancelled"].includes(step.conclusion) && step.started_at)
    .map((step) => [
      Date.parse(step.started_at),
      Date.parse(step.completed_at ?? step.started_at) + 1000,
    ]);
  if (!windows.length) return log;
  const lines = log.split("\n").filter((line) => {
    const at = Date.parse(`${line.slice(0, 19)}Z`);
    return windows.some(([from, to]) => at >= from && at < to);
  });
  return lines.length ? lines.join("\n") : log;
}

const seconds = (step) => (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;

const day = 24 * 60 * 60 * 1000;

// Every failed job of the week's PR Checks runs, with its cause, and the merge queue's browser
// installs. Runs are listed a day at a time: one listing returns at most 1,000 runs. Failed runs
// are read first, so the API budget goes to them.
export async function collect({ client, until, days = 7 }) {
  const since = new Date(until.getTime() - days * day);
  const runs = [];
  for (let start = since.getTime(); start < until.getTime(); start += day) {
    const end = Math.min(start + day, until.getTime()) - 1000;
    runs.push(...(await client.runs(new Date(start), new Date(end))));
  }
  const failedRun = (run) => run.conclusion === "failure" || run.run_attempt > 1;
  const toRead = runs
    .filter((run) => run.status === "completed" && (failedRun(run) || run.event === "merge_group"))
    .sort((a, b) => Number(failedRun(b)) - Number(failedRun(a)));
  const failures = [];
  const installs = [];
  let unreadRuns = 0;
  for (const run of toRead) {
    if (!client.canRead()) {
      unreadRuns += 1;
      continue;
    }
    for (const job of await client.jobs(run.id)) {
      const install = job.steps?.find((step) => step.name === INSTALL_STEP);
      if (
        run.event === "merge_group" &&
        install?.conclusion === "success" &&
        install.completed_at
      ) {
        installs.push(seconds(install));
      }
      if (!failedRun(run) || job.name === "Required Checks") continue;
      if (job.conclusion !== "failure" && job.conclusion !== "cancelled") continue;
      const steps = (job.steps ?? [])
        .filter((step) => ["failure", "cancelled"].includes(step.conclusion))
        .map((step) => step.name);
      const failure = {
        run: run.id,
        attempt: job.run_attempt ?? run.run_attempt,
        event: run.event,
        job: job.name,
        steps,
        cause: "unread",
        url: job.html_url,
        at: job.started_at,
      };
      if (client.canRead()) {
        // A job that ran out of time is "cancelled" and says why only in its annotations; one
        // without a log (a lost runner) may too.
        let text =
          job.conclusion === "failure" ? failedStepLog(await client.log(job.id), job.steps) : "";
        if (!text && client.canRead()) {
          text = (await client.annotations(job.id))
            .map((annotation) => `${annotation.title ?? ""}: ${annotation.message ?? ""}`)
            .join("\n");
        }
        failure.cause = classify(text, steps);
      }
      // Otherwise the job was cancelled with its run, by a person or a rerun.
      if (
        job.conclusion === "cancelled" &&
        !["timeout", "runner", "unread"].includes(failure.cause)
      ) {
        continue;
      }
      failures.push(failure);
    }
  }
  return { since, until, runs: runs.length, unreadRuns, failures, installs };
}

// A job or step name as inline code: names come from the workflow a pull request may change, and
// the issue is public, so they must not render links, mentions or HTML.
const code = (text) => `\`${String(text).replaceAll("`", "'").replaceAll("|", "\\|")}\``;
const date = (when) => when.toISOString().slice(0, 10);
const minutes = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);

export function buildReport(
  { since, until, runs, unreadRuns = 0, failures, installs },
  { workflowUrl } = {},
) {
  const infra = failures.filter((f) => CAUSES.some((cause) => cause.key === f.cause));
  const link = (f) => `[${code(f.job)}](${f.url})${f.steps.length ? `, ${code(f.steps[0])}` : ""}`;
  const rows = CAUSES.map((cause) => {
    const hits = infra.filter((f) => f.cause === cause.key);
    if (!hits.length) return null;
    const latest = hits.toSorted((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
    return `| ${cause.label} | ${hits.length} | ${latest.map(link).join("<br>")} |`;
  }).filter(Boolean);
  const setup = failures.filter((f) => f.cause === "setup");
  const unread = failures.filter((f) => f.cause === "unread").length;
  const tests = failures.filter((f) => f.cause === "tests").length;
  const headline = `${date(since)} to ${date(until)}: ${infra.length} PR Checks job${infra.length === 1 ? "" : "s"} failed for infrastructure reasons`;

  const lines = [
    MARKER,
    `**${headline}**, of ${failures.length} failed jobs in ${runs} runs (attempts that a rerun replaced included).`,
    "",
    rows.length
      ? ["| Cause | Failed jobs | Latest |", "|---|---|---|", ...rows].join("\n")
      : "No known infrastructure cause this week.",
    "",
  ];
  if (setup.length) {
    lines.push(
      `**${setup.length} failed in a setup step with no known cause.** Look for a new flake source and add it to \`CAUSES\` in \`scripts/ci/infra-failures.mjs\`:`,
      "",
      ...setup.slice(0, 20).map((f) => `- ${link(f)}`),
      "",
    );
  }
  lines.push(`${tests} other failed jobs (tests, typecheck, lint, build) are not counted here.`);
  if (unread || unreadRuns) {
    lines.push(
      `Not read for the API budget: ${unread} failed jobs and ${unreadRuns} runs. The counts above are a lower bound.`,
    );
  }
  lines.push("", "### Browser installs in merge queue runs", "");
  if (installs.length) {
    const sorted = installs.toSorted((a, b) => a - b);
    const slow = sorted.filter((s) => s > 180);
    lines.push(
      `${installs.length} installs: median ${minutes(sorted[Math.floor(sorted.length / 2)])}, ${slow.length} over 3 min${slow.length ? ` (longest ${minutes(sorted.at(-1))})` : ""}. Retries show as "Infra retry" annotations on the run.`,
    );
  } else {
    lines.push("No merge queue run installed a browser.");
  }
  lines.push(
    "",
    `Rewritten every Monday by [CI Infra Report](${workflowUrl ?? "../actions"}) (VAY-2314). Known causes are retried inside their steps; a test failure is never retried.`,
    "",
  );
  return { headline, body: lines.join("\n") };
}

// The search syntax of the created filter takes whole seconds.
const iso = (when) => when.toISOString().replace(/\.\d{3}Z$/, "Z");

export function githubClient({
  token,
  repository,
  api = "https://api.github.com",
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let requests = 0;
  let rateLeft = Infinity;
  const call = async (method, path, body) => {
    requests += 1;
    const response = await fetchImpl(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const left = response.headers.get("x-ratelimit-remaining");
    if (left !== null) rateLeft = Number(left);
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };
  // A read that times out or gets a 429 or 5xx is tried twice more, 5 and 15 s later: one API
  // hiccup must not lose the week's report.
  const get = async (path, read = (response) => response.json()) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read(await call("GET", path));
      } catch (error) {
        const transient = !error.status || error.status === 429 || error.status >= 500;
        if (!transient || attempt === 3) throw new Error(`GET ${path}: ${error.message}`);
        await sleep(attempt === 1 ? 5_000 : 15_000);
      }
    }
  };
  const json = (path) => get(path);
  return {
    // Whether optional reads (job lists, logs, annotations) still fit the budget.
    canRead: () => requests < MAX_REQUESTS && rateLeft > RATE_RESERVE,
    async runs(from, to) {
      const runs = [];
      const created = `${iso(from)}..${iso(to)}`;
      for (let page = 1; ; page++) {
        const { workflow_runs: batch } = await json(
          `/actions/workflows/${WORKFLOW}/runs?created=${created}&per_page=100&page=${page}`,
        );
        runs.push(...batch);
        if (batch.length < 100) return runs;
      }
    },
    // Every attempt's jobs; a run rerun 4 times has over 100.
    async jobs(runId) {
      const jobs = [];
      for (let page = 1; ; page++) {
        const batch = await json(
          `/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
        );
        jobs.push(...batch.jobs);
        if (batch.jobs.length < 100 || jobs.length >= batch.total_count) return jobs;
      }
    },
    // A redirect to the stored log; an expired or missing log reads as empty.
    log: (jobId) =>
      get(`/actions/jobs/${jobId}/logs`, (response) => response.text()).catch(() => ""),
    annotations: (checkRunId) =>
      json(`/check-runs/${checkRunId}/annotations?per_page=100`).catch(() => []),
    async openIssues() {
      const issues = [];
      for (let page = 1; ; page++) {
        const batch = await json(`/issues?state=open&creator=${BOT}&per_page=100&page=${page}`);
        issues.push(...batch.filter((issue) => !issue.pull_request));
        if (batch.length < 100) return issues;
      }
    },
    createIssue: async (fields) => (await call("POST", "/issues", fields)).json(),
    updateIssue: (number, fields) => call("PATCH", `/issues/${number}`, fields),
    comment: (number, body) => call("POST", `/issues/${number}/comments`, { body }),
  };
}

// One open issue holds the latest report; each week adds a one-line comment, so the thread keeps
// the history and watchers hear of it. Only an issue this workflow opened counts: anyone can file
// one quoting the marker in this public repository.
export async function publish({ client, report }) {
  const [issue] = (await client.openIssues())
    .filter((candidate) => candidate.user?.login === BOT && candidate.body?.includes(MARKER))
    .sort((a, b) => a.number - b.number);
  if (!issue) {
    const created = await client.createIssue({
      title: ISSUE_TITLE,
      body: report.body,
      labels: ISSUE_LABELS,
    });
    return `opened #${created.number}`;
  }
  await client.updateIssue(issue.number, { body: report.body });
  await client.comment(issue.number, `${report.headline}. The description has the details.`);
  return `updated #${issue.number}`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_REF } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY)
    throw new Error("needs GITHUB_TOKEN and GITHUB_REPOSITORY");
  const client = githubClient({
    token: GITHUB_TOKEN,
    repository: GITHUB_REPOSITORY,
    api: process.env.GITHUB_API_URL,
  });
  const data = await collect({ client, until: new Date(Date.now() - SETTLE_MS) });
  const report = buildReport(data, {
    workflowUrl: `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}/actions/workflows/ci-infra-report.yml`,
  });
  console.log(report.headline);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.body);
  else console.log(`\n${report.body}`);
  // Only main's scheduled or manual run writes the issue; a branch run is a dry run.
  if (dryRun || GITHUB_REF !== "refs/heads/main") {
    console.log("Issue: none changed (dry run, or not main).");
    return;
  }
  console.log(`Issue: ${await publish({ client, report })}.`);
}

// Compare real paths so a symlinked invocation can never turn the CLI into a silent no-op.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
