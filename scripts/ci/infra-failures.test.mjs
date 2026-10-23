import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  BOT,
  CAUSES,
  ISSUE_TITLE,
  MARKER,
  buildReport,
  classify,
  collect,
  failedStepLog,
  githubClient,
  publish,
} from "./infra-failures.mjs";

// Lines from real PR Checks logs and annotations (2026-10-12 to 2026-10-22), timestamps dropped.
const LOGS = {
  apt: "E: Failed to fetch https://packages.microsoft.com/ubuntu/24.04/prod/dists/noble/InRelease  403  Forbidden [IP: 13.107.213.51 443]",
  playwright:
    "Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames: Host: cdn.playwright.dev. is not in the cert's altnames: DNS:*.azureedge.net",
  image:
    "Error response from daemon: toomanyrequests: Data limit exceeded\n##[error]Docker pull failed with exit code 1",
  npm: "npm error code ECONNRESET\nnpm error network aborted",
  pip: "WARNING: Retrying (Retry(total=4)) after connection broken by 'ReadTimeoutError(\"HTTPSConnectionPool(host='pypi.org', port=443)\")'",
  "google-fonts":
    "Failed to fetch font `Inter`.\nURL: https://fonts.googleapis.com/css2?family=Inter",
  timeout: ": The job has exceeded the maximum execution time of 30m0s",
  runner: "##[error]The runner has received a shutdown signal.",
  "pg-teardown":
    " Test Files  8 passed (8)\n      Tests  16 passed (16)\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nerror: terminating connection due to administrator command\n  code: '57P01'",
};

test("each known cause matches its own real log line and no other cause does", () => {
  assert.deepEqual(
    CAUSES.map((cause) => cause.key),
    Object.keys(LOGS),
  );
  for (const [key, log] of Object.entries(LOGS)) {
    assert.equal(classify(log, ["Run the specs"]), key, key);
  }
});

test("an apt failure inside Playwright's install-deps counts as apt", () => {
  const log = `${LOGS.apt}\nE: Some index files failed to download.\nFailed to install browsers\nError: Installation process exited with code: 100`;
  assert.equal(classify(log, ["Install Chromium"]), "apt");
});

test("a passing browser install's download lines are not a failure cause", () => {
  const install =
    "Downloading Chrome for Testing 148.0.7778.96 (playwright chromium v1223) from https://cdn.playwright.dev/builds/cft/148.0.7778.96/linux64/chrome-linux64.zip\nChrome for Testing downloaded to /home/runner/.cache/ms-playwright/chromium-1223";
  assert.equal(
    classify(`${install}\n  1) booking-admin › addons.spec.ts`, ["Run the specs"]),
    "tests",
  );
});

test("57P01 counts as the teardown race only inside vitest's unhandled errors of a passing run", () => {
  const timedOut =
    'FAIL src/jobs/financeExpenseGeneration.integration.test.ts\nError: Test timed out in 30000ms.\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\n{"code":"57P01","error":"terminating connection due to administrator command"}';
  assert.equal(classify(timedOut, ["Run PMS TypeScript PostgreSQL integration"]), "tests");
  // A passing suite logs 57P01 too; with some other unhandled error it is not the race.
  const other =
    '{"code":"57P01","error":"terminating connection due to administrator command"}\n Tests  16 passed (16)\n⎯⎯⎯ Unhandled Errors ⎯⎯⎯\nTypeError: Cannot read properties of undefined';
  assert.equal(classify(other, ["Run PMS TypeScript PostgreSQL integration"]), "tests");
});

test("an unknown failure in a setup step is flagged; one in a step that runs the change is not", () => {
  assert.equal(classify("something new", ["Install Chromium"]), "setup");
  assert.equal(classify("something new", ["Initialize containers"]), "setup");
  assert.equal(classify("something new", ["Set up job"]), "setup");
  assert.equal(classify("something new", ["Install dependencies"]), "tests");
  assert.equal(classify("something new", ["Build the packages pms-web imports"]), "tests");
  assert.equal(classify("something new", ["Typecheck"]), "tests");
  assert.equal(classify("", []), "tests");
});

const UNTIL = new Date("2026-10-26T05:23:00Z");
const step = (name, conclusion, startedAt, seconds) => ({
  name,
  conclusion,
  started_at: startedAt,
  completed_at: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
});
// A log line as GitHub writes it: an ISO timestamp with 7 decimals, then the text.
const at = (time, text) => `2026-10-22T${time}.1234567Z ${text}`;

test("failedStepLog keeps only the failed steps' lines, so a recovered retry is not the cause", () => {
  const steps = [
    step("Install Chromium", "success", "2026-10-22T10:01:00Z", 60),
    step("Run the specs", "failure", "2026-10-22T10:02:00Z", 30),
  ];
  const log = [
    at("10:01:05", LOGS.playwright),
    at("10:01:40", "##[warning]Chromium download failed (attempt 1 of 3)"),
    at("10:02:10", "1) booking-admin › addons.spec.ts"),
    at("10:02:30", "##[error]Process completed with exit code 1."),
    at("10:02:45", "Post job cleanup."),
  ].join("\n");
  const failed = failedStepLog(log, steps);
  assert.match(failed, /addons\.spec\.ts/);
  assert.match(failed, /exit code 1/);
  assert.doesNotMatch(failed, /ERR_TLS|Post job/);
  assert.equal(classify(failed, ["Run the specs"]), "tests");
  // No failed step with times, or no line in its window: the whole log.
  assert.equal(failedStepLog(log, []), log);
  assert.equal(failedStepLog(log, [step("Gone", "failure", "2026-10-22T11:00:00Z", 5)]), log);
});

const job = (id, name, conclusion, steps = [], extra = {}) => ({
  id,
  name,
  conclusion,
  steps,
  html_url: `https://github.com/o/r/actions/runs/1/job/${id}`,
  started_at: "2026-10-22T10:00:00Z",
  run_attempt: 1,
  ...extra,
});

function fakeClient({ runs, jobs, logs = {}, annotations = {}, budget = Infinity }) {
  const calls = { runs: [], jobs: [], logs: [], annotations: [] };
  let optional = 0;
  return {
    calls,
    canRead: () => optional < budget,
    async runs(from, to) {
      calls.runs.push([from.toISOString(), to.toISOString()]);
      return runs.filter((run) => {
        const created = Date.parse(run.created_at);
        return created >= from.getTime() && created <= to.getTime();
      });
    },
    async jobs(id) {
      optional += 1;
      calls.jobs.push(id);
      return jobs[id] ?? [];
    },
    async log(id) {
      optional += 1;
      calls.logs.push(id);
      return logs[id] ?? "";
    },
    async annotations(id) {
      optional += 1;
      calls.annotations.push(id);
      return annotations[id] ?? [];
    },
  };
}

const run = (id, conclusion, extra = {}) => ({
  id,
  status: "completed",
  conclusion,
  event: "pull_request",
  run_attempt: 1,
  created_at: "2026-10-22T10:00:00Z",
  ...extra,
});
const TIMED_OUT = [
  { title: null, message: "The job has exceeded the maximum execution time of 30m0s" },
];

test("collect reads failed runs first, every attempt's failed jobs, timeouts and queue installs", async () => {
  const client = fakeClient({
    runs: [
      run(1, "success"),
      run(4, "success", { event: "merge_group" }),
      run(2, "failure"),
      run(3, "success", { run_attempt: 2 }),
      run(5, "cancelled"),
      run(6, "failure", { status: "in_progress" }),
    ],
    jobs: {
      2: [
        job(21, "Frontend Build and App Tests", "failure", [
          step("Install Chromium", "success", "2026-10-22T10:01:00Z", 20),
          step("Landing consent browser regressions", "failure", "2026-10-22T10:02:00Z", 5),
        ]),
        job(22, "Required Checks", "failure"),
      ],
      3: [
        job(31, "TypeScript API PostgreSQL Integration (PG16, hotel-setup)", "failure", [], {
          run_attempt: 1,
        }),
        job(32, "TypeScript API PostgreSQL Integration (PG16, hotel-setup)", "success", [], {
          run_attempt: 2,
        }),
        // Attempt 1 ran out of time in its install; the rerun passed.
        job(33, "Booking Admin Browser Specs (2/2)", "cancelled", [
          step("Install Chromium", "cancelled", "2026-10-22T10:01:00Z", 1700),
        ]),
        // Cancelled with its run by a person: not a failure.
        job(34, "Booking Web Browser Specs (1/2)", "cancelled"),
      ],
      4: [
        job(41, "Booking Admin Browser Specs (1/2)", "success", [
          step("Install Chromium", "success", "2026-10-22T10:01:00Z", 23),
        ]),
        job(42, "PMS Web Browser Specs (1/2)", "success", [
          step("Install Chromium", "success", "2026-10-22T10:01:00Z", 640),
        ]),
      ],
    },
    logs: {
      21: at("10:02:02", LOGS.playwright),
      31: LOGS["pg-teardown"],
    },
    annotations: {
      33: TIMED_OUT,
      34: [{ title: null, message: "The operation was canceled." }],
    },
  });
  const data = await collect({ client, until: UNTIL });
  assert.equal(client.calls.runs.length, 7);
  assert.equal(client.calls.runs[0][0], "2026-10-19T05:23:00.000Z");
  assert.equal(client.calls.runs.at(-1)[1], "2026-10-26T05:22:59.000Z");
  assert.equal(data.runs, 6);
  assert.deepEqual(client.calls.jobs, [2, 3, 4]);
  assert.deepEqual(client.calls.logs, [21, 31]);
  assert.deepEqual(client.calls.annotations, [33, 34]);
  assert.deepEqual(
    data.failures.map((f) => [f.run, f.job, f.cause, f.steps]),
    [
      [2, "Frontend Build and App Tests", "playwright", ["Landing consent browser regressions"]],
      [3, "TypeScript API PostgreSQL Integration (PG16, hotel-setup)", "pg-teardown", []],
      [3, "Booking Admin Browser Specs (2/2)", "timeout", ["Install Chromium"]],
    ],
  );
  assert.deepEqual(data.installs, [23, 640]);
  assert.equal(data.unreadRuns, 0);
});

test("collect stops reading at the API budget and the report says the counts are a lower bound", async () => {
  const many = Array.from({ length: 3 }, (_, i) => job(i + 1, `Job ${i}`, "failure"));
  const client = fakeClient({
    runs: [run(1, "failure"), run(2, "failure"), run(3, "success", { event: "merge_group" })],
    jobs: { 1: many },
    logs: { 1: "log", 2: "log", 3: "log" },
    budget: 3,
  });
  const data = await collect({ client, until: UNTIL });
  assert.deepEqual(client.calls.jobs, [1]);
  assert.deepEqual(client.calls.logs, [1, 2]);
  assert.deepEqual(
    data.failures.map((f) => f.cause),
    ["tests", "tests", "unread"],
  );
  assert.equal(data.unreadRuns, 2);
  assert.match(
    buildReport(data).body,
    /Not read for the API budget: 1 failed jobs and 2 runs\. The counts above are a lower bound\./,
  );
});

const failure = (cause, extra = {}) => ({
  run: 1,
  attempt: 1,
  event: "pull_request",
  job: "Booking Admin Browser Specs (1/2)",
  steps: ["Install Chromium"],
  cause,
  url: "https://github.com/o/r/actions/runs/1/job/2",
  at: "2026-10-22T10:00:00Z",
  ...extra,
});

test("the report counts each cause, lists setup-step mysteries and the queue's slow installs", () => {
  const { headline, body } = buildReport({
    since: new Date("2026-10-19T05:23:00Z"),
    until: UNTIL,
    runs: 1150,
    failures: [
      failure("playwright"),
      failure("playwright", { at: "2026-10-23T10:00:00Z", job: "First-Party | Auth" }),
      failure("apt"),
      failure("setup", { steps: ["Initialize containers"] }),
      failure("tests", { steps: ["Typecheck"] }),
    ],
    installs: [20, 23, 640],
  });
  assert.equal(
    headline,
    "2026-10-19 to 2026-10-26: 3 PR Checks jobs failed for infrastructure reasons",
  );
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /of 5 failed jobs in 1150 runs/);
  assert.match(body, /\| Playwright browser download \| 2 \| \[`First-Party \\\| Auth`\]/);
  assert.match(body, /\| Ubuntu packages \(apt\) \| 1 \|/);
  assert.doesNotMatch(body, /npm registry|Not read/);
  assert.match(body, /\*\*1 failed in a setup step with no known cause\.\*\*/);
  assert.match(body, /`Initialize containers`/);
  assert.match(body, /1 other failed jobs \(tests, typecheck, lint, build\)/);
  assert.match(body, /3 installs: median 23 s, 1 over 3 min \(longest 10\.7 min\)/);
});

test("names from a pull request's workflow render as code, never as links, mentions or HTML", () => {
  const { body } = buildReport({
    since: new Date("2026-10-19T05:23:00Z"),
    until: UNTIL,
    runs: 1,
    failures: [failure("apt", { job: "@someone [x](https://evil.example) <img src=x> `tick`" })],
    installs: [],
  });
  assert.match(body, /\[`@someone \[x\]\(https:\/\/evil\.example\) <img src=x> 'tick'`\]\(/);
});

test("a quiet week says so", () => {
  const { headline, body } = buildReport({
    since: new Date("2026-10-19T05:23:00Z"),
    until: UNTIL,
    runs: 10,
    failures: [],
    installs: [],
  });
  assert.match(headline, /: 0 PR Checks jobs failed/);
  assert.match(body, /No known infrastructure cause this week\./);
  assert.match(body, /No merge queue run installed a browser\./);
});

function fakeIssues(open) {
  const calls = [];
  return {
    calls,
    openIssues: async () => open,
    createIssue: async (fields) => (calls.push(["create", fields]), { number: 9 }),
    updateIssue: async (number, fields) => calls.push(["update", number, fields]),
    comment: async (number, body) => calls.push(["comment", number, body]),
  };
}
const REPORT = { headline: "Week: 1 PR Checks job failed", body: `${MARKER}\nreport` };

test("publish opens the issue once, then rewrites it and comments the headline each week", async () => {
  const first = fakeIssues([]);
  assert.equal(await publish({ client: first, report: REPORT }), "opened #9");
  assert.deepEqual(first.calls, [
    ["create", { title: ISSUE_TITLE, body: REPORT.body, labels: ["monitoring"] }],
  ]);
  const later = fakeIssues([{ number: 7, user: { login: BOT }, body: `${MARKER}\nold` }]);
  assert.equal(await publish({ client: later, report: REPORT }), "updated #7");
  assert.deepEqual(later.calls, [
    ["update", 7, { body: REPORT.body }],
    ["comment", 7, "Week: 1 PR Checks job failed. The description has the details."],
  ]);
});

test("publish ignores an issue someone else opened with the marker", async () => {
  const client = fakeIssues([{ number: 3, user: { login: "someone" }, body: MARKER }]);
  assert.equal(await publish({ client, report: REPORT }), "opened #9");
});

test("the client lists runs by whole-second ranges, pages through runs and jobs, and reads logs as text", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([init.method, url.replace("https://api.github.com/repos/o/r", "")]);
    if (url.includes("/logs")) return new Response("log text");
    const page = Number(new URL(url).searchParams.get("page"));
    if (url.includes("/jobs")) {
      const jobs = Array.from({ length: page === 1 ? 100 : 4 }, (_, i) => ({
        id: page * 1000 + i,
      }));
      return Response.json({ total_count: 104, jobs });
    }
    const runs = Array.from({ length: page === 1 ? 100 : 1 }, (_, id) => ({ id }));
    return Response.json({ workflow_runs: runs });
  };
  const client = githubClient({ token: "t", repository: "o/r", fetchImpl });
  const runs = await client.runs(
    new Date("2026-10-19T05:23:00.000Z"),
    new Date("2026-10-20T05:22:59.000Z"),
  );
  assert.equal(runs.length, 101);
  assert.deepEqual(requests.slice(0, 2), [
    [
      "GET",
      "/actions/workflows/pr-checks.yml/runs?created=2026-10-19T05:23:00Z..2026-10-20T05:22:59Z&per_page=100&page=1",
    ],
    [
      "GET",
      "/actions/workflows/pr-checks.yml/runs?created=2026-10-19T05:23:00Z..2026-10-20T05:22:59Z&per_page=100&page=2",
    ],
  ]);
  assert.equal((await client.jobs(7)).length, 104);
  assert.equal(await client.log(5), "log text");
  const failing = githubClient({
    token: "t",
    repository: "o/r",
    fetchImpl: async () => new Response("gone", { status: 410 }),
  });
  assert.equal(await failing.log(5), "");
  assert.deepEqual(await failing.annotations(5), []);
});

test("the client stops optional reads near the rate limit or its own request budget", async () => {
  let left = 400;
  const client = githubClient({
    token: "t",
    repository: "o/r",
    fetchImpl: async () => {
      left -= 100;
      return Response.json({ jobs: [] }, { headers: { "x-ratelimit-remaining": String(left) } });
    },
  });
  assert.equal(client.canRead(), true);
  await client.jobs(1);
  await client.jobs(2);
  assert.equal(client.canRead(), true); // 200 left
  await client.jobs(3);
  assert.equal(client.canRead(), false); // 100 left, under the reserve
});

test("the client retries a read that timed out or got a 5xx, but not a 4xx", async () => {
  const pauses = [];
  const flaky = (failures) => {
    let calls = 0;
    return githubClient({
      token: "t",
      repository: "o/r",
      sleep: async (ms) => pauses.push(ms),
      fetchImpl: async () => {
        calls += 1;
        const failure = failures[calls - 1];
        if (failure === "timeout")
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (failure) return new Response("", { status: failure });
        return Response.json({ total_count: 1, jobs: [{ id: calls }] });
      },
    });
  };
  assert.deepEqual(await flaky(["timeout", 502]).jobs(1), [{ id: 3 }]);
  assert.deepEqual(pauses, [5_000, 15_000]);
  await assert.rejects(
    flaky(["timeout", "timeout", "timeout"]).jobs(1),
    /GET \/actions\/runs\/1\/jobs\?filter=all&per_page=100&page=1: The operation was aborted due to timeout/,
  );
  await assert.rejects(flaky([403]).jobs(1), /: HTTP 403$/);
  assert.equal(pauses.length, 4);
});

test("the weekly workflow runs the report from main with read access and issue writes only", () => {
  const workflow = parse(readFileSync(".github/workflows/ci-infra-report.yml", "utf8"));
  assert.deepEqual(workflow.permissions, {
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "write",
  });
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  const steps = workflow.jobs.report.steps;
  assert.ok(steps.some((s) => s.run === "node scripts/ci/infra-failures.mjs"));
  assert.ok(
    steps.every(
      (s) => !s.uses?.startsWith("actions/checkout") || s.with?.["persist-credentials"] === false,
    ),
  );
});
