import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PIN_FILE,
  buildReport,
  fixStep,
  integrityOf,
  readPin,
  reviewRecord,
} from "./cloudflare-beacon-drift.mjs";
import {
  BOT,
  dropFix,
  fixBranch,
  fixText,
  isOlder,
  pinSource,
  prepareFix,
} from "./cloudflare-beacon-fix.mjs";

const report = {
  liveVersion: "2026.10.2",
  liveIntegrity: "sha384-NEW",
  body: "<!-- cloudflare-beacon-drift -->\n<!-- live: sha384-NEW -->\nThe report.\n",
};
const changes = { "a.ts": "pin NEW\n", "b.json": "{}\n" };
const BRANCH = "automation/cloudflare-beacon-pin-main";
const args = (git, extra = {}) => ({
  git,
  base: "main",
  baseSha: "base-sha",
  changes,
  report,
  repoUrl: "https://github.com/o/r",
  override: "",
  ...extra,
});
const failure = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function fakeGit({ ref = null, files = {}, pull = null, closed = null, ran = true, create } = {}) {
  const calls = [];
  const reads = [];
  const log = (name, ...rest) => (calls.push([name, ...rest]), null);
  return {
    calls,
    reads,
    getRef: async () => ref,
    getFile: async (path, branch) => (reads.push(branch), files[path] ?? null),
    commit: async (fields) => (log("commit", fields.baseSha, fields.message), "new-sha"),
    setRef: async (...rest) => log("setRef", ...rest),
    deleteRef: async (name) => log("deleteRef", name),
    dispatch: async (...rest) => log("dispatch", ...rest),
    checksRan: async () => ran,
    openPull: async () => pull,
    closedPull: async () => closed,
    createPull: async (fields) => {
      log("createPull", fields.head, fields.base);
      return create ? create() : { number: 7, user: { login: BOT } };
    },
    updatePull: async (number, fields) => log("updatePull", number, Object.keys(fields)),
    comment: async (number, body) => log("comment", number, body),
  };
}
const names = (git) => git.calls.map((call) => call[0]);

test("fixBranch is one branch per base, with a safe name", () => {
  assert.equal(fixBranch("main"), BRANCH);
  assert.equal(fixBranch("fm/x y"), "automation/cloudflare-beacon-pin-fm-x-y");
});

test("isOlder compares dotted versions and ignores unknown ones", () => {
  assert.equal(isOlder("2026.10.0", "2026.10.1"), true);
  assert.equal(isOlder("2026.10.1", "2026.10.1"), false);
  assert.equal(isOlder("2026.11.0", "2026.10.9"), false);
  assert.equal(isOlder("unknown", "2026.10.1"), false);
});

test("pinSource turns one comment line into the two-line form, and replaces that form later", () => {
  const live = { integrity: "sha384-NEW", version: "2026.10.2" };
  const original = '// Reviewed by hand.\nconst integrity = "sha384-OLD";\nlet x;\n';
  const once = pinSource(original, { ...live, lastModified: "Mon, 02 Nov 2026 10:00:00 GMT" });
  assert.equal(
    once,
    '// Beacon 2026.10.2 (Cloudflare, 2026-11-02), pinned via Cloudflare Beacon Drift after review:\n// XHR and sendBeacon only. Vendor changes fail closed.\nconst integrity = "sha384-NEW";\nlet x;\n',
  );
  const twice = pinSource(once, { ...live, integrity: "sha384-NEWER", lastModified: undefined });
  assert.equal(twice.split("\n").length, once.split("\n").length);
  assert.match(twice, /\(Cloudflare, date unknown\)/);
  assert.throws(() => pinSource("const integrity = 'x';", live), /no commented/);
});

test("pinSource works on the real pin file, whichever comment form it has now", () => {
  const source = readFileSync(PIN_FILE, "utf8");
  const live = { integrity: "sha384-NEW", version: "2026.10.2", lastModified: "" };
  const out = pinSource(source, live);
  assert.equal(readPin(out), "sha384-NEW");
  assert.equal(pinSource(out, live), out);
  assert.equal(
    out.replace(/^.*\n.*\nconst integrity.*$/m, ""),
    source.replace(/^(\/\/.*\n)+const integrity.*$/m, ""),
  );
});

test("fixText makes one title and body, without the issue markers", () => {
  const { title, body } = fixText({
    report,
    branch: "automation/x",
    repoUrl: "https://g/o/r",
    override: "",
  });
  assert.equal(
    title,
    "Landing: pin Cloudflare beacon 2026.10.2 (automated; merging deploys landing)",
  );
  assert.match(body, /\*\*Merging deploys the landing site\*\*/);
  assert.match(body, /They never run Cloudflare's new file/);
  assert.match(body, /pr-checks\.yml\?query=branch%3Aautomation%2Fx/);
  assert.match(body, /The report\./);
  assert.doesNotMatch(body, /<!--/);
  assert.match(
    fixText({ report, branch: "b", repoUrl: "u", override: "sha384-T" }).title,
    /^\[test\] /,
  );
});

test("prepareFix pushes a new branch, dispatches PR Checks and opens the pull request", async () => {
  const git = fakeGit();
  const result = await prepareFix(args(git));
  assert.equal(result.pull, 7);
  assert.equal(result.pushed, true);
  assert.deepEqual(names(git), ["commit", "setRef", "dispatch", "createPull"]);
  assert.deepEqual(git.calls[1], ["setRef", BRANCH, "new-sha", false]);
  assert.deepEqual(git.calls[2], ["dispatch", "pr-checks.yml", BRANCH]);
  assert.match(git.calls[0][2], /^Landing: pin Cloudflare beacon 2026\.10\.2 .*\n\nPrepared by /);
  assert.match(result.line, /#7 sets the new pin.*merging deploys the landing site/);
});

test("prepareFix leaves an up-to-date branch, its checks and its pull request alone", async () => {
  const { title, body } = fixText({
    report,
    branch: BRANCH,
    repoUrl: "https://github.com/o/r",
    override: "",
  });
  const git = fakeGit({
    ref: { object: { sha: "head" } },
    files: changes,
    pull: { number: 7, title, body, user: { login: BOT } },
  });
  const result = await prepareFix(args(git));
  assert.equal(result.pushed, false);
  assert.deepEqual(git.calls, []);
  assert.deepEqual([...new Set(git.reads)], [BRANCH]);
});

test("prepareFix dispatches PR Checks again when no run exists for the branch head", async () => {
  const git = fakeGit({
    ref: { object: { sha: "head" } },
    files: changes,
    ran: false,
    pull: { number: 7, user: { login: "someone" } },
  });
  await prepareFix(args(git));
  assert.deepEqual(names(git), ["dispatch"]);
});

test("a force-push under an open pull request tells its reviewers, and only the bot's text is rewritten", async () => {
  const stale = { ...changes, "a.ts": "pin OLD\n" };
  const ours = fakeGit({
    ref: { object: { sha: "old" } },
    files: stale,
    pull: { number: 7, title: "t", body: "b", user: { login: BOT } },
  });
  await prepareFix(args(ours));
  assert.deepEqual(names(ours), ["commit", "setRef", "comment", "dispatch", "updatePull"]);
  assert.equal(ours.calls[1][3], true);
  assert.match(
    ours.calls[2][2],
    /now pins \*\*2026\.10\.2\*\* \(`sha384-NEW`\)\. Review this report, not the earlier one:\n\nThe report\./,
  );
  const human = fakeGit({
    ref: { object: { sha: "old" } },
    files: stale,
    pull: { number: 8, title: "t", body: "b", user: { login: "someone" } },
  });
  const result = await prepareFix(args(human));
  assert.deepEqual(names(human), ["commit", "setRef", "comment", "dispatch"]);
  assert.match(result.line, /#8/);
});

test("without permission to open pull requests the issue links the page that opens one", async () => {
  const git = fakeGit({ create: () => Promise.reject(failure(403)) });
  const result = await prepareFix(args(git, { base: "fm/test" }));
  assert.equal(result.pull, null);
  assert.match(
    result.line,
    /\[open the pull request\]\(https:\/\/github\.com\/o\/r\/compare\/fm\/test\.\.\.automation\/cloudflare-beacon-pin-fm-test\?expand=1\)/,
  );
  assert.match(
    result.line,
    /gh pr create --base fm\/test --head automation\/cloudflare-beacon-pin-fm-test --fill/,
  );
  for (const status of [422, 500]) {
    await assert.rejects(
      prepareFix(args(fakeGit({ create: () => Promise.reject(failure(status)) }))),
      new RegExp(`HTTP ${status}`),
    );
  }
});

test("a pull request someone closed without merging is not opened again for the same commit", async () => {
  const git = fakeGit({ ref: { object: { sha: "head" } }, files: changes, closed: { number: 9 } });
  const result = await prepareFix(args(git));
  assert.deepEqual(names(git), []);
  assert.match(result.line, /#9 was closed without merging/);
});

test("prepareFix refuses base names that would break the issue's link or command", async () => {
  await assert.rejects(prepareFix(args(fakeGit(), { base: "x`$(id)`" })), /unexpected branch name/);
});

test("dropFix deletes the branch and closes its open pull request", async () => {
  assert.equal(
    await dropFix({ git: fakeGit(), base: "main", liveIntegrity: "sha384-X" }),
    "no fix branch",
  );
  const lone = fakeGit({ ref: {} });
  assert.match(await dropFix({ git: lone, base: "main", liveIntegrity: "sha384-X" }), /^deleted /);
  assert.deepEqual(lone.calls, [["deleteRef", BRANCH]]);
  const open = fakeGit({ ref: {}, pull: { number: 7 } });
  assert.match(await dropFix({ git: open, base: "main", liveIntegrity: "sha384-X" }), /^closed #7/);
  assert.deepEqual(names(open), ["comment", "updatePull", "deleteRef"]);
});

// fixStep: what the scheduled run does around prepareFix and dropFix.
const OLD = Buffer.from('a;versions:{js:"2026.10.1"}');
const NEW = Buffer.from('b;versions:{js:"2026.10.2"}');
const SOURCE = '// x\nconst integrity = "sha384-OLD";\n';
function step(
  git,
  { pin = integrityOf(OLD), override = "", live = NEW, record = reviewRecord(OLD) } = {},
) {
  const inputs = {
    pin,
    override,
    record,
    live: { bytes: live, lastModified: "" },
    repoUrl: "https://github.com/o/r",
  };
  return fixStep({
    client: git,
    inputs,
    report: buildReport(inputs),
    source: SOURCE,
    base: "main",
    baseSha: "s",
  });
}

test("fixStep prepares the fix on drift and puts its line in the issue report", async () => {
  const git = fakeGit();
  const { report: out, log } = await step(git);
  assert.match(out.body, /\*\*Prepared fix:\*\* #7/);
  assert.match(log, /^Fix: #7 \(pushed\)\.$/);
  assert.match(git.calls[0][2], /^Landing: pin Cloudflare beacon 2026\.10\.2/);
});

test("fixStep changes nothing for a test run against a correct pin", async () => {
  const git = fakeGit();
  const { report: out } = await step(git, {
    pin: integrityOf(NEW),
    override: `sha384-${"A".repeat(64)}`,
  });
  assert.deepEqual(git.calls, []);
  assert.doesNotMatch(out.body, /Prepared fix/);
});

test("fixStep proposes no downgrade when the live version is older than the reviewed one", async () => {
  const git = fakeGit();
  const { report: out } = await step(git, {
    pin: integrityOf(NEW),
    live: OLD,
    record: reviewRecord(NEW),
  });
  assert.deepEqual(git.calls, []);
  assert.match(out.body, /The live version 2026\.10\.1 is older than the reviewed 2026\.10\.2/);
});

test("fixStep turns failures into the issue line or a warning, never a crash", async () => {
  const broken = { ...fakeGit(), getRef: async () => Promise.reject(failure(502)) };
  const failed = await step(broken);
  assert.match(
    failed.report.body,
    /\*\*Prepared fix:\*\* failed \(HTTP 502\)\. Update the pin by hand/,
  );
  assert.match(failed.log, /^::warning::Preparing the fix failed/);
  const matching = await step(broken, { live: OLD });
  assert.match(matching.log, /^::warning::Removing the prepared fix failed/);
});

test("fixStep removes the fix once the live file matches, except on test runs", async () => {
  const git = fakeGit({ ref: {} });
  assert.equal((await step(git, { live: OLD })).log, `Fix: deleted ${BRANCH}.`);
  const test = fakeGit({ ref: {} });
  assert.match(
    (await step(test, { live: OLD, pin: integrityOf(OLD), override: integrityOf(OLD) })).log,
    /left alone/,
  );
  assert.deepEqual(test.calls, []);
});
