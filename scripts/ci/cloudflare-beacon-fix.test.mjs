import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PIN_FILE, readPin } from "./cloudflare-beacon-drift.mjs";
import {
  BOT,
  dropFix,
  fixBranch,
  fixText,
  pinSource,
  prepareFix,
} from "./cloudflare-beacon-fix.mjs";

const report = {
  liveVersion: "2026.10.2",
  body: "<!-- cloudflare-beacon-drift -->\n<!-- live: sha384-NEW -->\nThe report.\n",
};
const changes = { "a.ts": "pin NEW\n", "b.json": "{}\n" };
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

function fakeGit({ branch = null, files = {}, pull = null, createPull } = {}) {
  const calls = [];
  const log = (name, ...rest) => (calls.push([name, ...rest]), null);
  return {
    calls,
    getRef: async () => branch,
    getFile: async (path) => files[path] ?? null,
    commit: async (fields) => (log("commit", fields.baseSha, fields.message), "new-sha"),
    setRef: async (...rest) => log("setRef", ...rest),
    deleteRef: async (name) => log("deleteRef", name),
    dispatch: async (...rest) => log("dispatch", ...rest),
    openPull: async () => pull,
    createPull: async (fields) => {
      log("createPull", fields.head, fields.base);
      if (createPull) return createPull();
      return { number: 7, user: { login: BOT } };
    },
    updatePull: async (number, fields) => log("updatePull", number, Object.keys(fields)),
    comment: async (number) => log("comment", number),
  };
}

test("fixBranch is one branch per base, with a safe name", () => {
  assert.equal(fixBranch("main"), "automation/cloudflare-beacon-pin-main");
  assert.equal(fixBranch("fm/x y"), "automation/cloudflare-beacon-pin-fm-x-y");
});

test("pinSource rewrites the real pin file's pin and the comment above it", () => {
  const source = readFileSync(PIN_FILE, "utf8");
  const live = { integrity: "sha384-NEW", version: "2026.10.2" };
  const out = pinSource(source, { ...live, lastModified: "Mon, 02 Nov 2026 10:00:00 GMT" });
  assert.equal(readPin(out), "sha384-NEW");
  assert.match(
    out,
    /\/\/ Beacon 2026\.10\.2 \(2026-11-02\), pinned by Cloudflare Beacon Drift\. Merging confirmed the review:\n\/\/ XHR and sendBeacon only\. Vendor changes fail closed\.\nconst integrity = "sha384-NEW";/,
  );
  assert.equal(out.split("\n").length, source.split("\n").length + 1);
  // A second update replaces the two-line comment instead of stacking another one.
  const again = pinSource(out, { ...live, integrity: "sha384-NEWER", lastModified: undefined });
  assert.equal(again.split("\n").length, out.split("\n").length);
  assert.match(again, /\(date unknown\)/);
  assert.throws(() => pinSource("const integrity = 'x';", live), /no commented/);
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
  assert.deepEqual(result.pull, 7);
  assert.equal(result.pushed, true);
  assert.deepEqual(
    git.calls.map((c) => c.slice(0, 2)),
    [
      ["commit", "base-sha"],
      ["setRef", "automation/cloudflare-beacon-pin-main"],
      ["dispatch", "pr-checks.yml"],
      ["createPull", "automation/cloudflare-beacon-pin-main"],
    ],
  );
  assert.equal(git.calls[1][3], false); // created, not force-updated
  assert.match(git.calls[0][2], /^Landing: pin Cloudflare beacon 2026\.10\.2 .*\n\nPrepared by /);
  assert.match(result.line, /#7 sets the new pin.*merging deploys the landing site/);
});

test("prepareFix leaves an up-to-date branch and pull request alone", async () => {
  const { title, body } = fixText({
    report,
    branch: fixBranch("main"),
    repoUrl: "https://github.com/o/r",
    override: "",
  });
  const git = fakeGit({
    branch: {},
    files: changes,
    pull: { number: 7, title, body, user: { login: BOT } },
  });
  const result = await prepareFix(args(git));
  assert.equal(result.pushed, false);
  assert.deepEqual(git.calls, []);
});

test("prepareFix force-updates a stale branch and refreshes only its own pull request", async () => {
  const stale = { ...changes, "a.ts": "pin OLD\n" };
  const git = fakeGit({
    branch: {},
    files: stale,
    pull: { number: 7, title: "t", body: "b", user: { login: BOT } },
  });
  await prepareFix(args(git));
  assert.deepEqual(
    git.calls.map((c) => c[0]),
    ["commit", "setRef", "dispatch", "updatePull"],
  );
  assert.equal(git.calls[1][3], true);
  const human = fakeGit({
    branch: {},
    files: stale,
    pull: { number: 8, title: "t", body: "b", user: { login: "someone" } },
  });
  const result = await prepareFix(args(human));
  assert.deepEqual(
    human.calls.map((c) => c[0]),
    ["commit", "setRef", "dispatch"],
  );
  assert.match(result.line, /#8/);
});

test("without permission to open pull requests the issue links the page that opens one", async () => {
  const git = fakeGit({ createPull: () => Promise.reject(failure(403)) });
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
  await assert.rejects(
    prepareFix(args(fakeGit({ createPull: () => Promise.reject(failure(500)) }))),
    /HTTP 500/,
  );
});

test("dropFix deletes the branch and closes its open pull request", async () => {
  assert.equal(
    await dropFix({ git: fakeGit(), base: "main", liveIntegrity: "sha384-X" }),
    "no fix branch",
  );
  const lone = fakeGit({ branch: {} });
  assert.match(await dropFix({ git: lone, base: "main", liveIntegrity: "sha384-X" }), /^deleted /);
  assert.deepEqual(lone.calls, [["deleteRef", "automation/cloudflare-beacon-pin-main"]]);
  const open = fakeGit({ branch: {}, pull: { number: 7 } });
  assert.match(await dropFix({ git: open, base: "main", liveIntegrity: "sha384-X" }), /^closed #7/);
  assert.deepEqual(
    open.calls.map((c) => c[0]),
    ["comment", "updatePull", "deleteRef"],
  );
});
