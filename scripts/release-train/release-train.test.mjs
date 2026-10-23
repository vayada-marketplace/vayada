import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { createGitHub, HttpError } from "./github.mjs";
import { closeHold, holdMarker, openHold, settle } from "./hold.mjs";
import { classifyFailure, failedSection, greenProblems, precheck } from "./precheck.mjs";
import { findPublication, readPublication, waitForPublication } from "./publish.mjs";
import { cleanupHold, platformPayload, readOptions, renderSummary, runTrain } from "./train.mjs";

const REPO = "vayada-marketplace/vayada";
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const T0 = Date.parse("2026-10-23T12:00:00Z");

// A GitHub stand-in: `handler(method, path, body)` answers every call; any other call fails the test.
function fakeGitHub(handler) {
  const calls = [];
  const call = async (method, path, body, options) => {
    calls.push({ method, path, body, options });
    const answer = await handler(method, path, body, options);
    if (answer === undefined) throw new Error(`unexpected ${method} ${path}`);
    return answer;
  };
  return {
    calls,
    get: (path, options) => call("GET", path, undefined, options),
    post: (path, body, options) => call("POST", path, body, options),
    patch: (path, body, options) => call("PATCH", path, body, options),
    graphql: (query, variables) => call("GRAPHQL", "graphql", variables),
  };
}

function clock(start = T0) {
  let now = start;
  return { now: () => now, sleep: async (ms) => (now += ms) };
}

const quiet = () => {};

function response(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("reads retry server errors and network failures with backoff", async () => {
  const answers = [
    response(502, "bad gateway"),
    Promise.reject(new TypeError("fetch failed")),
    response(200, { ok: 1 }),
  ];
  const slept = [];
  const gh = createGitHub({
    token: "t",
    fetchImpl: async () => answers.shift(),
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(await gh.get("/x"), { ok: 1 });
  assert.deepEqual(slept, [2000, 4000]);
});

test("a 4xx answer is final, and a write sent with retry false goes out once", async () => {
  let calls = 0;
  const gh = createGitHub({
    token: "t",
    fetchImpl: async () => (calls++, response(404, "missing")),
    sleep: async () => {},
  });
  await assert.rejects(gh.get("/x"), (error) => error instanceof HttpError && error.status === 404);
  assert.equal(calls, 1);
  calls = 0;
  const flaky = createGitHub({
    token: "t",
    fetchImpl: async () => (calls++, response(502, "")),
    sleep: async () => {},
  });
  await assert.rejects(flaky.post("/dispatches", {}, { retry: false }), /HTTP 502/);
  assert.equal(calls, 1);
});

test("rate limits are read from GitHub's headers and their wait is honoured", async () => {
  const limited = (status, headers) => new Response("slow down", { status, headers });
  const slept = [];
  const now = () => Date.parse("2026-10-23T12:00:00Z");
  const reset = String(now() / 1000 + 90);
  const answers = [
    limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
    limited(429, { "retry-after": "7" }),
    limited(403, { "retry-after": "3600" }),
    response(200, []),
  ];
  const gh = createGitHub({
    token: "t",
    now,
    fetchImpl: async () => answers.shift(),
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(await gh.get("/x"), []);
  // The reset 90 s away; retry-after 7 s (longer than the 4 s backoff); a 1 h wait capped at 10 min.
  assert.deepEqual(slept, [90_000, 7_000, 600_000]);
});

test("a 403 without rate-limit headers is final, whatever its body says", async () => {
  let calls = 0;
  const denied = createGitHub({
    token: "t",
    fetchImpl: async () => (
      calls++,
      response(403, "API rate limit exceeded? Resource not accessible")
    ),
    sleep: async () => {},
  });
  await assert.rejects(denied.get("/x"), /HTTP 403/);
  assert.equal(calls, 1);
});

test("every call carries its own timeout", async () => {
  const signals = [];
  const gh = createGitHub({
    token: "t",
    timeoutMs: 1234,
    fetchImpl: async (url, init) => (signals.push(init.signal), response(200, {})),
  });
  await gh.get("/x");
  assert.ok(signals[0] instanceof AbortSignal);
});

const openIssue = (number) => ({ number, state: "open", labels: [{ name: "release-train-hold" }] });
const issueNumber = (path) => Number(/\/issues\/(\d+)$/.exec(path)?.[1]);

const holdIssue = (number, marker, created = "2026-10-23T11:55:00Z") => ({
  number,
  html_url: `https://github.com/${REPO}/issues/${number}`,
  body: `Reason: x\n${marker}`,
  created_at: created,
});

test("a rerun reuses its own open hold instead of stacking another", async () => {
  const gh = fakeGitHub((method, path) => {
    if (method === "GET" && path.includes("/issues?state=open&labels=release-train-hold"))
      return [holdIssue(7, "release-train-run: 99"), holdIssue(8, holdMarker(42))];
  });
  assert.deepEqual(await openHold(gh, REPO, { reason: "r", marker: holdMarker(42) }), {
    number: 8,
    url: `https://github.com/${REPO}/issues/8`,
    reused: true,
  });
  assert.equal(gh.calls.filter((call) => call.method === "POST").length, 0);
});

test("a new hold carries the label and the run marker and is created once", async () => {
  let created = null;
  const gh = fakeGitHub((method, path, body, options) => {
    if (method === "GET" && path.includes("/issues?")) return created ? [created] : [];
    if (method === "POST" && path === `/repos/${REPO}/issues`) {
      assert.equal(options.retry, false);
      assert.deepEqual(body.labels, ["release-train-hold"]);
      assert.match(body.body, /release-train-run: 42/);
      created = { ...holdIssue(9, holdMarker(42)), number: 9 };
      throw new Error("reply lost");
    }
  });
  const hold = await openHold(gh, REPO, {
    reason: "r",
    marker: holdMarker(42),
    sleep: async () => {},
  });
  assert.equal(hold.number, 9);
});

test("after a lost reply the hold is looked for until the labelled list shows it", async () => {
  let listReads = 0;
  const gh = fakeGitHub((method, path) => {
    if (method === "GET" && path.includes("/issues?"))
      return listReads++ < 3 ? [] : [holdIssue(9, holdMarker(42))];
    if (method === "POST" && path === `/repos/${REPO}/issues`) throw new Error("socket hang up");
  });
  const slept = [];
  const hold = await openHold(gh, REPO, {
    reason: "r",
    marker: holdMarker(42),
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(hold, { number: 9, url: `https://github.com/${REPO}/issues/9`, reused: true });
  assert.equal(gh.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(slept, [10_000, 10_000, 10_000]);
});

test("a hold whose label GitHub dropped gets the label added", async () => {
  const gh = fakeGitHub((method, path, body) => {
    if (method === "GET" && path.includes("/issues?")) return [];
    if (method === "POST" && path === `/repos/${REPO}/issues`)
      return { ...holdIssue(9, holdMarker(42)), labels: [] };
    if (method === "POST" && path === `/repos/${REPO}/issues/9/labels`) {
      assert.deepEqual(body, { labels: ["release-train-hold"] });
      return [];
    }
  });
  assert.equal((await openHold(gh, REPO, { reason: "r", marker: holdMarker(42) })).number, 9);
  assert.ok(gh.calls.some((call) => call.path.endsWith("/issues/9/labels")));
});

test("the cleanup after a cancelled train closes only that run's open hold", async () => {
  const closedIssues = new Set([10]);
  const gh = fakeGitHub((method, path) => {
    if (method === "GET" && path.includes("/issues?"))
      return [
        holdIssue(7, holdMarker(41)),
        holdIssue(8, holdMarker(42)),
        holdIssue(9, "manual hold"),
      ];
    if (method === "GET" && issueNumber(path))
      return {
        ...openIssue(issueNumber(path)),
        state: closedIssues.has(issueNumber(path)) ? "closed" : "open",
      };
    if (method === "POST" || method === "PATCH") return {};
  });
  // #12 is the hold this run recorded; the list does not show it yet. #10 was already closed.
  assert.deepEqual(await cleanupHold(gh, REPO, "42", "https://run/42", [12, 10]), [12, 8]);
  assert.deepEqual(
    gh.calls.filter((call) => call.method === "PATCH").map((call) => call.path),
    [`/repos/${REPO}/issues/12`, `/repos/${REPO}/issues/8`],
  );
  const none = fakeGitHub((method, path) => (path.includes("/issues?") ? [] : undefined));
  assert.deepEqual(await cleanupHold(none, REPO, "42", "u"), []);
});

test("closing a hold comments, then closes the issue", async () => {
  const gh = fakeGitHub((method, path) =>
    method === "POST" || method === "PATCH" ? {} : undefined,
  );
  await closeHold(gh, REPO, 9, "done");
  assert.deepEqual(
    gh.calls.map((call) => [call.method, call.path, call.body]),
    [
      ["POST", `/repos/${REPO}/issues/9/comments`, { body: "done" }],
      ["PATCH", `/repos/${REPO}/issues/9`, { state: "closed" }],
    ],
  );
});

const entry = (number, state, oid = OTHER) => ({
  position: number,
  state,
  headCommit: { oid },
  pullRequest: { number, title: "t" },
});

// A queue that drains as the clock moves: `script` maps poll numbers to queue entries and main shas.
function settleWorld({
  entries,
  mains,
  holds = () => [holdIssue(5, holdMarker(1))],
  gatePassed = () => false,
  files = () => [],
  holdState = () => "open",
}) {
  let poll = -1;
  return fakeGitHub((method, path) => {
    if (method === "GET" && path.includes("/issues?")) return holds();
    if (method === "GET" && issueNumber(path))
      return { ...openIssue(issueNumber(path)), state: holdState() };
    if (method === "GRAPHQL") {
      poll += 1;
      return { repository: { mergeQueue: { entries: { nodes: entries(poll) } } } };
    }
    if (method === "GET" && path.includes("/check-runs?check_name=Required%20Checks"))
      return { check_runs: gatePassed() ? [{ status: "completed", conclusion: "success" }] : [] };
    if (method === "GET" && path.includes("/files?")) return files(path);
    if (method === "GET" && path === `/repos/${REPO}/commits/main`) return { sha: mains(poll) };
  });
}

test("settle waits for entries that can still merge, then for two still reads past the floor", async () => {
  const { now, sleep } = clock(Date.parse("2026-10-23T11:55:30Z"));
  // Poll 0 is the gate-editor scan. Entry #1 is through Required Checks and merges by poll 3.
  const world = settleWorld({
    entries: (poll) => (poll <= 2 ? [entry(1, "AWAITING_CHECKS")] : []),
    gatePassed: () => true,
    mains: (poll) => (poll <= 2 ? OTHER : SHA),
  });
  const lines = [];
  const started = now();
  assert.equal(
    await settle(world, REPO, { hold: 5, sleep, now, log: (line) => lines.push(line) }),
    SHA,
  );
  assert.ok(lines.some((line) => line.includes("#1")));
  // Polls 1-2 see #1, polls 3-4 are the two still reads a minute apart.
  assert.equal((now() - started) / 60_000, 3);
});

test("the first entry still waiting at the gate holds back every entry behind it", async () => {
  const { now, sleep } = clock(Date.parse("2026-10-23T11:55:30Z"));
  const world = settleWorld({
    entries: () => [entry(1, "AWAITING_CHECKS"), entry(2, "MERGEABLE")],
    mains: () => SHA,
  });
  assert.equal(await settle(world, REPO, { hold: 5, sleep, now, log: quiet }), SHA);
});

test("settle stops when a queued PR edits the hold gate or the hold closes", async () => {
  const { now, sleep } = clock();
  const editor = settleWorld({
    entries: () => [entry(3, "AWAITING_CHECKS")],
    mains: () => SHA,
    files: () => [{ filename: "scripts/ci/pr-checks.mjs" }],
  });
  await assert.rejects(
    settle(editor, REPO, { hold: 5, sleep, now, log: quiet }),
    /#3 edit the hold gate/,
  );
  let reads = 0;
  const closed = settleWorld({
    entries: () => [],
    mains: () => SHA,
    holdState: () => (reads++ < 1 ? "open" : "closed"),
  });
  await assert.rejects(
    settle(closed, REPO, { hold: 5, sleep, now, log: quiet }),
    /hold #5 was closed while settling/,
  );
  const none = settleWorld({ entries: () => [], mains: () => SHA, holdState: () => "closed" });
  await assert.rejects(
    settle(none, REPO, { hold: 5, sleep, now, log: quiet }),
    /hold #5 is not open/,
  );
});

test("settle waits for the labelled list to show a new hold and counts the floor from then", async () => {
  // The first real run (2026-10-23) read the list 0.3 s after opening its hold and found nothing.
  const { now, sleep } = clock(Date.parse("2026-10-23T12:00:00Z"));
  let listReads = 0;
  const world = settleWorld({
    entries: () => [],
    mains: () => SHA,
    holds: () => (listReads++ < 2 ? [] : [holdIssue(5, holdMarker(1), "2026-10-23T12:00:00Z")]),
  });
  const started = now();
  assert.equal(await settle(world, REPO, { hold: 5, sleep, now, log: quiet }), SHA);
  // Visible after 10 s; two still reads a minute apart, the second at least 2 min after that.
  assert.equal((now() - started) / 1000, 130);
});

test("settle stops when the list never shows the hold, so nothing pauses the queue", async () => {
  const { now, sleep } = clock();
  const world = settleWorld({ entries: () => [], mains: () => SHA, holds: () => [] });
  await assert.rejects(
    settle(world, REPO, { hold: 5, sleep, now, log: quiet }),
    /hold #5 did not appear in the release-train-hold list within 120 s/,
  );
});

test("a failed settle read starts the two still reads over", async () => {
  const { now, sleep } = clock(Date.parse("2026-10-23T12:30:00Z"));
  let mainReads = 0;
  const world = fakeGitHub((method, path) => {
    if (method === "GET" && path.includes("/issues?")) return [holdIssue(5, "m")];
    if (method === "GET" && issueNumber(path)) return openIssue(issueNumber(path));
    if (method === "GRAPHQL") return { repository: { mergeQueue: { entries: { nodes: [] } } } };
    if (method === "GET" && path.endsWith("/commits/main")) {
      mainReads += 1;
      if (mainReads === 2) throw new Error("connect ETIMEDOUT");
      return { sha: SHA };
    }
  });
  const started = now();
  assert.equal(await settle(world, REPO, { hold: 5, sleep, now, log: quiet }), SHA);
  // reads 1 ok, 2 failed, 3 ok, 4 ok: three minutes of polling instead of one.
  assert.equal((now() - started) / 60_000, 3);
});

function jobs({ skip = [], drop = [], extra = [] } = {}) {
  const names = [
    "Select checks",
    "Required Checks",
    "Frontend Test, Typecheck, Lint",
    "Frontend Build and App Tests",
    "First-Party Auth Contracts",
    "TypeScript API and Package Unit Suites",
    "Backend Tests (booking-api)",
    "Backend Tests (pms-api)",
    "Setup Draft Reset PostgreSQL 16 Integration",
    "Setup Draft Reset PostgreSQL 17 Integration",
    ...["PMS Web", "Booking Web", "Booking Admin"].flatMap((app) =>
      [1, 2].map((n) => `${app} Browser Specs (${n}/2)`),
    ),
    ...[16, 17].flatMap((v) =>
      ["platform", "pms", "pms-migrations", "pricing", "hotel-setup"].map(
        (s) => `TypeScript API PostgreSQL Integration (PG${v}, ${s})`,
      ),
    ),
    ...extra,
  ].filter((name) => !drop.includes(name));
  return names.map((name, id) => ({
    id,
    name,
    status: "completed",
    conclusion: skip.includes(name) ? "skipped" : "success",
    steps: [],
  }));
}

test("green means every job succeeded, enough ran, and every shard ran on PG16 and PG17", () => {
  assert.deepEqual(greenProblems(jobs()), []);
  assert.match(
    greenProblems(jobs({ skip: ["Backend Tests (pms-api)"] }))[0],
    /1 job\(s\) did not succeed: Backend Tests \(pms-api\) \(skipped\)/,
  );
  assert.match(greenProblems(jobs().slice(0, 10)).join("\n"), /only 10 jobs ran/);
  assert.deepEqual(
    greenProblems(jobs({ drop: ["TypeScript API PostgreSQL Integration (PG17, pms-migrations)"] })),
    ["missing PG17 pms-migrations leg"],
  );
  assert.deepEqual(greenProblems(jobs({ drop: ["Setup Draft Reset PostgreSQL 17 Integration"] })), [
    "missing PG17 setup draft reset",
  ]);
  const noPricing = jobs({
    drop: [16, 17].map((v) => `TypeScript API PostgreSQL Integration (PG${v}, pricing)`),
  });
  assert.deepEqual(greenProblems(noPricing), [
    "missing PG16 pricing leg",
    "missing PG17 pricing leg",
  ]);
});

const failedJob = (step = "Run tests") => ({
  id: 1,
  name: "TypeScript API PostgreSQL Integration (PG16, pms)",
  conclusion: "failure",
  steps: [
    { name: "Checkout", conclusion: "success" },
    { name: step, conclusion: "failure" },
  ],
});
const stepLog = (body) =>
  [
    "##[group]Run docker pull postgres",
    "Docker pull failed with exit code 1, back off 4s",
    "pulled on retry",
    "##[endgroup]",
    "##[group]Run npm run test",
    body,
    "##[error]Process completed with exit code 1.",
    "##[group]Run stop containers",
    "terminating connection due to administrator command",
  ].join("\n");

test("a failure is an infrastructure flake only when the failed step's own section says so", () => {
  assert.match(failedSection(stepLog("boom")), /^##\[group\]Run npm run test\nboom\n/);
  assert.equal(failedSection("no error here"), null);
  // A retried pull and the container log elsewhere in a log never make a real failure a flake.
  assert.deepEqual(
    classifyFailure({ job: failedJob(), log: stepLog("Tests  1 failed | 99 passed") }).infra,
    false,
  );
  assert.equal(
    classifyFailure({ job: failedJob(), log: stepLog("npm error code ECONNRESET") }).infra,
    true,
  );
  assert.equal(classifyFailure({ job: failedJob("Initialize containers"), log: null }).infra, true);
  assert.equal(
    classifyFailure({
      job: failedJob(),
      annotations: ["The runner has received a shutdown signal."],
    }).infra,
    true,
  );
  assert.equal(classifyFailure({ job: failedJob(), log: null }).infra, false);
  assert.equal(
    classifyFailure({ job: { ...failedJob(), conclusion: "cancelled" }, log: null }).infra,
    false,
  );
  const teardown = [
    "Unhandled Error",
    "error: terminating connection due to administrator command",
    " Test Files  40 passed (40)",
    "      Tests  300 passed (300)",
    "     Errors  1 error",
  ].join("\n");
  assert.equal(classifyFailure({ job: failedJob(), log: stepLog(teardown) }).infra, true);
  assert.equal(
    classifyFailure({
      job: failedJob(),
      log: stepLog(`${teardown}\n Test Files  1 failed | 39 passed`),
    }).infra,
    false,
  );
});

const prRun = (id, extra = {}) => ({
  id,
  run_attempt: 1,
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  run_started_at: "2026-10-23T11:40:00Z",
  created_at: "2026-10-23T11:40:00Z",
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  ...extra,
});

function precheckWorld({
  queueRuns = [],
  tip = SHA,
  dispatched = [],
  jobsFor = () => jobs(),
  logs = {},
} = {}) {
  let state = 0;
  return fakeGitHub((method, path, body, options) => {
    if (method === "GET" && path.includes("runs?event=merge_group"))
      return { workflow_runs: queueRuns };
    if (method === "GET" && path.match(/\/attempts\/\d+\/jobs/)) {
      const [, id, attempt] = path.match(/runs\/(\d+)\/attempts\/(\d+)/);
      return { jobs: jobsFor(Number(id), Number(attempt)) };
    }
    if (method === "GET" && path.endsWith("/commits/main")) return { sha: tip };
    if (method === "POST" && path.endsWith("/workflows/pr-checks.yml/dispatches")) {
      assert.equal(options.retry, false);
      return {};
    }
    if (method === "GET" && path.includes("runs?event=workflow_dispatch"))
      return { workflow_runs: dispatched.length ? [dispatched[0]] : [] };
    if (method === "GET" && path.match(/actions\/runs\/\d+$/))
      return dispatched[Math.min(state++, dispatched.length - 1)];
    if (method === "POST" && path.endsWith("/rerun-failed-jobs")) return {};
    if (method === "GET" && path.includes("/annotations")) return [];
    if (method === "GET" && path.includes("/logs")) return Buffer.from(logs[path] ?? "");
  });
}

test("the precheck reuses a fresh green merge queue run and dispatches nothing", async () => {
  const { now, sleep } = clock();
  const gh = precheckWorld({
    queueRuns: [prRun(10, { run_started_at: "2026-10-23T09:00:00Z" }), prRun(11)],
  });
  const result = await precheck(gh, REPO, SHA, { sleep, now, log: quiet });
  assert.equal(result.status, "green");
  assert.match(result.url, /runs\/11$/);
  assert.ok(!gh.calls.some((call) => call.method === "POST"));
});

test("a stale or incomplete queue run is not reused; a dry run only reports that it would dispatch", async () => {
  const { now, sleep } = clock();
  const old = precheckWorld({ queueRuns: [prRun(11, { run_started_at: "2026-10-23T05:00:00Z" })] });
  assert.equal(
    (await precheck(old, REPO, SHA, { dispatch: false, sleep, now, log: quiet })).status,
    "would-dispatch",
  );
  const skipped = precheckWorld({
    queueRuns: [prRun(11)],
    jobsFor: () => jobs({ skip: ["Backend Tests (pms-api)"] }),
  });
  assert.equal(
    (await precheck(skipped, REPO, SHA, { dispatch: false, sleep, now, log: quiet })).status,
    "would-dispatch",
  );
});

test("without a reusable run the precheck dispatches once on the tip and waits for it", async () => {
  const { now, sleep } = clock();
  const gh = precheckWorld({
    dispatched: [prRun(20, { status: "in_progress", conclusion: null }), prRun(20)],
  });
  const result = await precheck(gh, REPO, SHA, { sleep, now, log: quiet });
  assert.equal(result.status, "green");
  assert.equal(gh.calls.filter((call) => call.method === "POST").length, 1);
  const moved = precheckWorld({ tip: OTHER });
  assert.match(
    (await precheck(moved, REPO, SHA, { sleep, now, log: quiet })).detail,
    /main is at bbbbbbbbb/,
  );
  assert.ok(!moved.calls.some((call) => call.method === "POST"));
});

test("only infrastructure flakes get one rerun of the failed jobs", async () => {
  const { now, sleep } = clock();
  const failing = (attempt) =>
    jobs().map((job) =>
      job.name.endsWith("(PG16, pms)") && attempt === 1 ? { ...failedJob(), id: 77 } : job,
    );
  const flake = precheckWorld({
    dispatched: [
      prRun(30, { conclusion: "failure" }),
      prRun(30, { run_attempt: 2 }),
      prRun(30, { run_attempt: 2 }),
    ],
    jobsFor: (id, attempt) => failing(attempt),
    logs: {
      [`/repos/${REPO}/actions/jobs/77/logs`]: stepLog("Error: toomanyrequests: rate limit"),
    },
  });
  assert.equal((await precheck(flake, REPO, SHA, { sleep, now, log: quiet })).status, "green");
  assert.equal(flake.calls.filter((call) => call.path.endsWith("/rerun-failed-jobs")).length, 1);
  const real = precheckWorld({
    dispatched: [prRun(31, { conclusion: "failure" })],
    jobsFor: (id, attempt) => failing(attempt),
    logs: { [`/repos/${REPO}/actions/jobs/77/logs`]: stepLog(" Test Files  1 failed | 9 passed") },
  });
  const result = await precheck(real, REPO, SHA, { sleep, now, log: quiet });
  assert.equal(result.status, "failed");
  assert.ok(!real.calls.some((call) => call.path.endsWith("/rerun-failed-jobs")));
});

const publishRun = (id, extra = {}) => ({
  id,
  name: "Publish coordinated next release",
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-23T12:00:00Z",
  ...extra,
});
const buildRun = (extra = {}) => ({
  id: 5,
  name: "Build coordinated next release",
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-23T11:50:00Z",
  html_url: "u",
  ...extra,
});

function publishWorld({ runs, artifacts }) {
  return fakeGitHub((method, path) => {
    if (method === "GET" && path.includes(`/actions/runs?head_sha=${SHA}`))
      return { workflow_runs: runs() };
    const match = path.match(/actions\/runs\/(\d+)\/artifacts/);
    if (method === "GET" && match) return { artifacts: artifacts[match[1]] ?? [] };
  });
}

test("the publication is found by artifact name, not by the publish run's head sha", async () => {
  // Two merges a second apart: run 61 (head SHA) published OTHER's build; run 62 published SHA's.
  const gh = publishWorld({
    runs: () => [publishRun(61), publishRun(62), publishRun(63, { conclusion: "failure" })],
    artifacts: {
      61: [
        {
          id: 1,
          name: `next-release-published-v1-${OTHER}-9-1`,
          created_at: "2026-10-23T12:01:00Z",
        },
      ],
      62: [
        { id: 2, name: `next-release-published-v1-${SHA}-8-1`, created_at: "2026-10-23T12:02:00Z" },
      ],
    },
  });
  assert.deepEqual(await findPublication(gh, REPO, SHA), {
    runId: 62,
    artifactId: 2,
    name: `next-release-published-v1-${SHA}-8-1`,
    createdAt: "2026-10-23T12:02:00Z",
  });
});

test("a failed build stops the wait; a dry run does not wait", async () => {
  const { now, sleep } = clock();
  const failed = publishWorld({ runs: () => [buildRun({ conclusion: "failure" })], artifacts: {} });
  await assert.rejects(
    waitForPublication(failed, REPO, SHA, { sleep, now, log: quiet }),
    /ended failure/,
  );
  const pending = publishWorld({
    runs: () => [buildRun({ status: "in_progress", conclusion: null })],
    artifacts: {},
  });
  assert.deepEqual(
    (await waitForPublication(pending, REPO, SHA, { wait: false, sleep, now, log: quiet }))
      .publication,
    null,
  );
});

function writePublication(directory, sha = SHA) {
  const manifest = {
    manifestId: `vayada-release/v1/${sha}/8/1`,
    source: { sha, branch: "main" },
    services: {
      "next-target-backend": { digest: `sha256:${"1".repeat(64)}` },
      "next-pms-frontend": { digest: `sha256:${"2".repeat(64)}` },
    },
  };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(directory, "published-record.json"),
    JSON.stringify({ manifestId: manifest.manifestId }),
  );
}

test("the release identity hashes the exact publication bytes and binds the sha", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-train-test-"));
  writePublication(directory);
  const identity = readPublication(directory, SHA);
  const hash = (file) =>
    createHash("sha256")
      .update(readFileSync(join(directory, file)))
      .digest("hex");
  assert.equal(identity.manifestSha256, hash("manifest.json"));
  assert.equal(identity.publishedRecordSha256, hash("published-record.json"));
  assert.equal(identity.digests["next-target-backend"], `sha256:${"1".repeat(64)}`);
  assert.throws(() => readPublication(directory, OTHER), /not bbbb/);
});

test("train options default to a dry run with push admission", () => {
  const base = {
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: "42",
    GITHUB_REF: "refs/heads/main",
    TRAIN_SUMMARY: "VAY-1 x",
  };
  const options = readOptions(base);
  assert.equal(options.dryRun, true);
  assert.equal(options.admission, "push");
  assert.equal(readOptions({ ...base, TRAIN_ADMISSION: "pr" }).admission, "pr");
  assert.equal(options.keepHold, false);
  assert.equal(options.runUrl, `https://github.com/${REPO}/actions/runs/42`);
  assert.throws(() => readOptions({ ...base, TRAIN_SHA: "abc" }), /full 40-character sha/);
  assert.throws(() => readOptions({ ...base, TRAIN_ADMISSION: "merge" }), /pr or push/);
  assert.throws(() => readOptions({ ...base, TRAIN_SUMMARY: " " }), /TRAIN_SUMMARY/);
  assert.throws(() => readOptions({ ...base, TRAIN_DRY_RUN: "yes" }), /true or false/);
});

test("the platform payload stays within GitHub's ten top-level keys", () => {
  const payload = platformPayload(
    readOptions({ GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "42", TRAIN_SUMMARY: "s" }),
    SHA,
    {
      artifactId: 2,
      manifestId: "m",
      manifestSha256: "c".repeat(64),
      publishedRecordSha256: "d".repeat(64),
    },
  );
  assert.ok(Object.keys(payload).length <= 10);
  assert.deepEqual(payload.release, {
    sha: SHA,
    artifactId: 2,
    manifestId: "m",
    manifestSha256: "c".repeat(64),
    publishedRecordSha256: "d".repeat(64),
  });
  assert.equal(payload.dryRun, true);
});

// The whole app side of a release against one fake repository.
function trainWorld({ main = () => SHA, buildConclusion = "success" } = {}) {
  const holds = [];
  const gh = fakeGitHub((method, path, body) => {
    if (method === "GET" && path.includes("/issues?state=open"))
      return holds.filter((issue) => issue.open);
    if (method === "POST" && path === `/repos/${REPO}/issues`) {
      const issue = {
        ...holdIssue(
          100 + holds.length,
          body.body.split("\n").find((line) => line.startsWith("release-train-run")),
          "2026-10-23T11:00:00Z",
        ),
        labels: body.labels.map((name) => ({ name })),
        open: true,
      };
      holds.push(issue);
      return issue;
    }
    if (method === "GET" && issueNumber(path)) {
      const issue = holds.find((item) => item.number === issueNumber(path));
      return { ...issue, state: issue.open ? "open" : "closed" };
    }
    if (method === "POST" && path.match(/issues\/\d+\/comments$/)) return {};
    if (method === "PATCH" && path.match(/issues\/\d+$/)) {
      holds.find((issue) => path.endsWith(`/${issue.number}`)).open = false;
      return {};
    }
    if (method === "GRAPHQL") return { repository: { mergeQueue: { entries: { nodes: [] } } } };
    if (method === "GET" && path.endsWith("/commits/main")) return { sha: main() };
    if (method === "GET" && path.includes("runs?event=merge_group"))
      return { workflow_runs: [prRun(11, { run_started_at: "2026-10-23T11:30:00Z" })] };
    if (method === "GET" && path.match(/\/attempts\/\d+\/jobs/)) return { jobs: jobs() };
    if (method === "GET" && path.includes(`/actions/runs?head_sha=${SHA}`))
      return { workflow_runs: [buildRun({ conclusion: buildConclusion }), publishRun(62)] };
    if (method === "GET" && path.endsWith("/runs/62/artifacts?per_page=50"))
      return {
        artifacts: [
          {
            id: 2,
            name: `next-release-published-v1-${SHA}-8-1`,
            created_at: "2026-10-23T12:02:00Z",
          },
        ],
      };
  });
  const platform = fakeGitHub((method, path) =>
    method === "POST" && path === "/repos/vayada-marketplace/vayada-platform/dispatches"
      ? {}
      : undefined,
  );
  const workdir = mkdtempSync(join(tmpdir(), "release-train-test-"));
  return {
    gh,
    platform,
    holds,
    workdir,
    download: async (_gh, _repo, id, directory) => writePublication(directory),
  };
}

const trainOptions = (overrides = {}) => ({
  ...readOptions({
    GITHUB_REPOSITORY: REPO,
    GITHUB_RUN_ID: "42",
    GITHUB_REF: "refs/heads/main",
    TRAIN_SUMMARY: "VAY-1 thing",
  }),
  ...overrides,
});

test("a dry run writes nothing in the app repository and sends a dry-run event", async () => {
  const world = trainWorld();
  const { now, sleep } = clock();
  const result = await runTrain(trainOptions(), { ...world, sleep, now, log: quiet });
  assert.equal(result.ok, true);
  assert.deepEqual(
    world.gh.calls.filter((call) => call.method !== "GET" && call.method !== "GRAPHQL"),
    [],
  );
  const [dispatch] = world.platform.calls;
  assert.equal(dispatch.body.event_type, "release-train");
  assert.equal(dispatch.body.client_payload.dryRun, true);
  assert.equal(dispatch.body.client_payload.release.artifactId, 2);
  const summary = renderSummary(trainOptions(), result.steps, result.identity);
  assert.match(summary, /## Release train \(dry run\)/);
  assert.match(summary, /\| next-target-backend \| `sha256:1{64}` \|/);
});

test("a release holds, settles, prechecks, closes the hold at publish, then hands off", async () => {
  const world = trainWorld();
  const { now, sleep } = clock();
  const remembered = [];
  const result = await runTrain(trainOptions({ dryRun: false, admission: "push" }), {
    ...world,
    sleep,
    now,
    log: quiet,
    rememberHold: (number) => remembered.push(number),
  });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(
    result.steps.map((step) => `${step.name}:${step.status}`),
    [
      "hold:done",
      "settle:done",
      "precheck:done",
      "publication:done",
      "hold close:done",
      "platform:done",
    ],
  );
  assert.equal(world.holds.length, 1);
  assert.equal(world.holds[0].open, false);
  assert.equal(result.steps[0].detail.includes("reused"), false);
  const payload = world.platform.calls[0].body.client_payload;
  assert.equal(payload.dryRun, false);
  assert.equal(payload.admission, "push");
  assert.deepEqual(payload.appRun, { id: 42, url: `https://github.com/${REPO}/actions/runs/42` });
  // The cleanup step of the same job finds the hold by this number, not through the lagging list.
  assert.deepEqual(remembered, [world.holds[0].number]);
});

test("keep_hold leaves the hold open for the coordinator", async () => {
  const world = trainWorld();
  const { now, sleep } = clock();
  const result = await runTrain(trainOptions({ dryRun: false, keepHold: true }), {
    ...world,
    sleep,
    now,
    log: quiet,
  });
  assert.equal(result.ok, true);
  assert.equal(world.holds[0].open, true);
  assert.equal(world.platform.calls.length, 1);
});

test("a stop before the hand-off closes the hold and sends nothing to the platform", async () => {
  const world = trainWorld({ buildConclusion: "failure" });
  const { now, sleep } = clock();
  const result = await runTrain(trainOptions({ dryRun: false }), {
    ...world,
    sleep,
    now,
    log: quiet,
  });
  assert.equal(result.ok, false);
  assert.equal(world.holds[0].open, false);
  assert.match(result.steps.find((step) => step.name === "stopped").detail, /ended failure/);
  assert.equal(world.platform.calls.length, 0);
  const commented = world.gh.calls.find((call) => call.path.endsWith("/comments"));
  assert.match(commented.body.body, /stopped before any deploy/);
});

test("a requested sha must be where main settles, and real releases run only from main", async () => {
  const world = trainWorld();
  const { now, sleep } = clock();
  const wrong = await runTrain(trainOptions({ dryRun: false, sha: OTHER }), {
    ...world,
    sleep,
    now,
    log: quiet,
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.steps.at(-2).detail, /not the requested bbbbbbbbb/);
  await assert.rejects(
    runTrain(trainOptions({ dryRun: false, ref: "refs/heads/fm/x" }), {
      ...trainWorld(),
      sleep,
      now,
      log: quiet,
    }),
    /only from main/,
  );
});

test("the workflow dry-runs by default, runs real releases only from main, and never cancels a train", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/release-train.yml", import.meta.url), "utf8"),
  );
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.dry_run.default, true);
  assert.equal(inputs.admission.default, "push");
  assert.equal(inputs.keep_hold.default, false);
  assert.deepEqual(workflow.concurrency, { group: "release-train", "cancel-in-progress": false });
  const job = workflow.jobs.train;
  assert.equal(job.if, "github.ref == 'refs/heads/main' || inputs.dry_run");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const run = job.steps.find((step) => step.name === "Run the release train");
  assert.equal(run.run, "node scripts/release-train/train.mjs");
  assert.equal(run.env.TRAIN_DRY_RUN, "${{ inputs.dry_run }}");
  // The step stops before the job does, so a train that ran out of time still gets its hold closed.
  assert.ok(run["timeout-minutes"] < job["timeout-minutes"]);
  const cleanup = job.steps.at(-1);
  assert.equal(cleanup.run, "node scripts/release-train/train.mjs cleanup");
  assert.equal(
    cleanup.if,
    "${{ (cancelled() || failure()) && !inputs.dry_run && !inputs.keep_hold }}",
  );
});
