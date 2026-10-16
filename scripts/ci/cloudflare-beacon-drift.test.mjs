import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BOT,
  FIXTURE_FILE,
  ISSUE_TITLE,
  MARKER,
  PIN_FILE,
  beaconVersion,
  buildReport,
  fetchBeacon,
  githubClient,
  integrityOf,
  readPin,
  reconcile,
  statementDiff,
  surface,
  touchesIssues,
} from "./cloudflare-beacon-drift.mjs";

const OLD = Buffer.from(
  'var a=1;navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum",x);versions:{js:"2026.10.0"};',
);
const NEW = Buffer.from(
  'var a=2;navigator.sendBeacon("https://cloudflareinsights.com/cdn-cgi/rum",x);fetch("https://example.com/collect");versions:{js:"2026.10.1"};',
);
const live = (bytes) => ({
  bytes,
  etag: 'W/"2026.10.1"',
  lastModified: "Thu, 15 Oct 2026 18:26:54 GMT",
});
const drift = (overrides = {}) =>
  buildReport({ pin: integrityOf(OLD), override: "", fixture: OLD, live: live(NEW), ...overrides });

test("the committed beacon copy is exactly the bytes the app pins", () => {
  assert.equal(integrityOf(readFileSync(FIXTURE_FILE)), readPin(readFileSync(PIN_FILE, "utf8")));
});

test("readPin rejects a source without a sha384 integrity constant", () => {
  assert.equal(readPin('const integrity = "sha384-abc+/=";'), "sha384-abc+/=");
  assert.throws(() => readPin('const integrity = "sha256-abc";'), /No sha384 integrity/);
  assert.throws(() => readPin("const other = 1;"), /No sha384 integrity/);
});

test("beaconVersion reads the js version and falls back to unknown", () => {
  assert.equal(beaconVersion(OLD.toString()), "2026.10.0");
  assert.equal(beaconVersion("no version here"), "unknown");
  assert.equal(beaconVersion('js:"1.0\n| **x**"'), "unknown");
});

test("statementDiff lists statements only one side has, counting duplicates", () => {
  assert.deepEqual(statementDiff("a;b;b;c;", "a;b;c;d;"), {
    before: 4,
    after: 4,
    removed: ["b"],
    added: ["d"],
  });
  assert.deepEqual(statementDiff("a; b ;", "a;b"), { before: 2, after: 2, removed: [], added: [] });
});

test("surface counts transports and lists endpoints", () => {
  const { urls, counts } = surface(NEW.toString());
  assert.deepEqual(urls, [
    "https://cloudflareinsights.com/cdn-cgi/rum",
    "https://example.com/collect",
  ]);
  assert.equal(Object.fromEntries(counts)["fetch()"], 1);
  assert.equal(Object.fromEntries(counts)["navigator.sendBeacon"], 1);
  assert.deepEqual(surface('x("/cdn-cgi/rum")').urls, ["/cdn-cgi/rum"]);
  const pixel = Object.fromEntries(surface("new Image();new Worker(u);document.write(x)").counts);
  assert.equal(pixel["new Image / workers / document.write"], 3);
});

test("a matching live file produces no report body", () => {
  const report = buildReport({
    pin: integrityOf(NEW),
    override: "",
    fixture: NEW,
    live: live(NEW),
  });
  assert.equal(report.matches, true);
  assert.equal(report.body, undefined);
  assert.match(report.summary, /matches the pin/);
});

test("a drifted live file reports versions, the new hash and what changed", () => {
  const report = drift({ repoUrl: "https://github.com/o/r" });
  assert.equal(report.matches, false);
  assert.ok(report.body.startsWith(`${MARKER}\n<!-- live: ${integrityOf(NEW)} -->\n`));
  assert.match(report.body, /\| version \(`js:`\) \| 2026\.10\.0 \| 2026\.10\.1 \|/);
  assert.match(
    report.body,
    new RegExp(`\`\`\`\\n${integrityOf(NEW).replace(/[+/]/g, "\\$&")}\\n\`\`\``),
  );
  assert.match(report.body, /\| fetch\(\) \| 0 \| 1 ⚠️ \|/);
  assert.match(report.body, /\| navigator\.sendBeacon \| 1 \| 1 \|/);
  assert.match(report.body, /\| `https:\/\/example\.com\/collect` \| no \| yes ⚠️ \|/);
  assert.match(report.body, /Removed statements \(2\)/);
  assert.match(report.body, /Added statements \(3\)/);
  assert.match(
    report.body,
    /\(https:\/\/github\.com\/o\/r\/blob\/main\/engineering\/cloudflare-beacon-pin-runbook\.md\)/,
  );
  assert.match(
    report.body,
    /\[Cloudflare Beacon Drift\]\(https:\/\/github\.com\/o\/r\/actions\/workflows\/cloudflare-beacon-drift\.yml\)/,
  );
  assert.doesNotMatch(report.body, /Test run/);
  // Nothing run-specific: tomorrow's run must produce the same body for the same live file.
  assert.equal(drift({ repoUrl: "https://github.com/o/r" }).body, report.body);
});

test("an override run is labelled as a test", () => {
  const override = `sha384-${"A".repeat(64)}`;
  const report = buildReport({ pin: integrityOf(NEW), override, fixture: NEW, live: live(NEW) });
  assert.equal(report.matches, false);
  assert.match(report.body, /\*\*Test run\.\*\*/);
  assert.match(report.body, new RegExp(`Expected \\(workflow_dispatch input\\): \`${override}\``));
  assert.match(report.body, /No statement differs from the committed copy\./);
});

test("long statement lists are capped", () => {
  const many = (prefix) =>
    Buffer.from(Array.from({ length: 50 }, (_, i) => `${prefix}${i}`).join(";"));
  const report = buildReport({
    pin: integrityOf(many("a")),
    override: "",
    fixture: many("a"),
    live: live(Buffer.from(`${"x".repeat(400)};${many("b")}`)),
  });
  assert.match(report.body, /… and 11 more/);
  assert.match(report.body, new RegExp(`${"x".repeat(300)} …`));
  assert.ok(report.body.length < 65536);
});

test("vendor code cannot close the statement code block", () => {
  const sneaky = Buffer.from("a=`x`;b=1;s='````\n@someone ![x](https://e.example)'");
  const report = buildReport({
    pin: integrityOf(OLD),
    override: "",
    fixture: OLD,
    live: live(sneaky),
  });
  assert.match(report.body, /\n`````js\n/);
  assert.match(report.body, /\n`````\n\n<\/details>/);
});

function fakeClient(issues) {
  const calls = [];
  return {
    calls,
    openIssues: async () => issues,
    createIssue: async (title, body) => (calls.push(["create", title, body]), { number: 99 }),
    updateIssue: async (number, fields) => (calls.push(["update", number, fields]), {}),
    comment: async (number, body) => (calls.push(["comment", number, body]), {}),
  };
}
const issue = (number, body, login = BOT) => ({ number, body, user: { login } });

test("reconcile opens one issue on the first mismatch", async () => {
  const report = drift();
  const client = fakeClient([issue(5, `quoting ${MARKER}`, "someone")]);
  assert.equal(await reconcile({ client, report, override: "" }), "opened #99");
  assert.deepEqual(client.calls, [["create", ISSUE_TITLE, report.body]]);
});

test("reconcile leaves an up-to-date issue alone and rewrites a stale one", async () => {
  const report = drift();
  const same = fakeClient([issue(7, report.body)]);
  assert.equal(await reconcile({ client: same, report, override: "" }), "#7 is up to date");
  assert.deepEqual(same.calls, []);

  const reworded = fakeClient([issue(7, report.body.replace("Next step", "Next"))]);
  assert.equal(await reconcile({ client: reworded, report, override: "" }), "updated #7");
  assert.deepEqual(reworded.calls, [["update", 7, { body: report.body }]]);
});

test("reconcile comments when the live file changed again", async () => {
  const report = drift();
  const client = fakeClient([
    issue(8, `${MARKER}\n<!-- live: sha384-older -->\n`),
    issue(3, `${MARKER}`),
  ]);
  assert.equal(await reconcile({ client, report, override: "" }), "updated #3");
  assert.deepEqual(
    client.calls.map((c) => c.slice(0, 2)),
    [
      ["update", 3],
      ["comment", 3],
    ],
  );
  assert.match(client.calls[1][2], /changed again: now 2026\.10\.1/);
});

test("reconcile closes the bot's issues once the live file matches the pin", async () => {
  const report = buildReport({
    pin: integrityOf(NEW),
    override: "",
    fixture: NEW,
    live: live(NEW),
  });
  const client = fakeClient([issue(4, MARKER), issue(6, MARKER, "someone"), issue(9, "unrelated")]);
  assert.equal(await reconcile({ client, report, override: "" }), "closed #4");
  assert.deepEqual(
    client.calls.map((c) => c.slice(0, 2)),
    [
      ["comment", 4],
      ["update", 4],
    ],
  );
  assert.match(
    client.calls[0][2],
    new RegExp(`matches the pin on main again .*${"runbook step 5"}`),
  );
  assert.ok(client.calls[0][2].includes(integrityOf(NEW)));
  assert.deepEqual(client.calls[1][2], { state: "closed", state_reason: "completed" });
  const none = fakeClient([]);
  assert.equal(await reconcile({ client: none, report, override: "" }), "no open drift issue");
});

test("a run against an override never closes issues", async () => {
  const report = buildReport({
    pin: "sha384-x",
    override: integrityOf(NEW),
    fixture: NEW,
    live: live(NEW),
  });
  const client = fakeClient([issue(4, MARKER)]);
  assert.match(await reconcile({ client, report, override: integrityOf(NEW) }), /left as they are/);
  assert.deepEqual(client.calls, []);
});

const response = (status, body, headers = {}) => new Response(body, { status, headers });

test("fetchBeacon retries transient failures, then gives up", async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? response(503, "") : response(200, NEW, { etag: "e" }));
  const fetched = await fetchBeacon({ fetchImpl: flaky, delayMs: 0 });
  assert.equal(calls, 3);
  assert.deepEqual(fetched.bytes, NEW);
  assert.equal(fetched.etag, "e");
  await assert.rejects(
    fetchBeacon({ fetchImpl: async () => response(404, ""), attempts: 2, delayMs: 0 }),
    /HTTP 404/,
  );
});

test("githubClient pages through open issues, skips pull requests and fails loudly", async () => {
  const requests = [];
  const page = (n) =>
    Array.from({ length: n }, (_, i) => ({ number: i, pull_request: i === 0 ? {} : undefined }));
  const client = githubClient({
    token: "t",
    repository: "o/r",
    fetchImpl: async (url, init) => {
      requests.push([url, init.method, init.headers.authorization]);
      return response(200, JSON.stringify(url.endsWith("page=1") ? page(100) : page(2)));
    },
  });
  assert.equal((await client.openIssues()).length, 99 + 1);
  assert.deepEqual(requests, [
    ["https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=1", "GET", "Bearer t"],
    ["https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=2", "GET", "Bearer t"],
  ]);
  const failing = githubClient({
    token: "t",
    repository: "o/r",
    fetchImpl: async () => response(403, "no"),
  });
  await assert.rejects(failing.createIssue("t", "b"), /POST \/issues: HTTP 403/);
});

test("only main runs and test runs touch issues; dry runs never do", () => {
  const override = `sha384-${"A".repeat(64)}`;
  assert.equal(touchesIssues({ dryRun: false, ref: "refs/heads/main", override: "" }), true);
  assert.equal(touchesIssues({ dryRun: false, ref: "refs/heads/fm/pin", override: "" }), false);
  assert.equal(touchesIssues({ dryRun: false, ref: undefined, override: "" }), false);
  assert.equal(touchesIssues({ dryRun: false, ref: "refs/heads/fm/pin", override }), true);
  assert.equal(touchesIssues({ dryRun: true, ref: "refs/heads/main", override }), false);
});
