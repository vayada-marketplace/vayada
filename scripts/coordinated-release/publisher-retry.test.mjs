import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sha256 } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const publish = readFileSync(
  join(root, ".github/workflows/publish-coordinated-release.yml"),
  "utf8",
);
const build = readFileSync(join(root, ".github/workflows/build-coordinated-release.yml"), "utf8");
const step = (workflow, name) =>
  workflow
    .split(`      - name: ${name}\n`)[1]
    .split("      - name:")[0]
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
const manifest = readFileSync(
  join(root, "engineering/deployment-contract/fixtures/manifest-v1.valid.json"),
);
const record = JSON.parse(
  readFileSync(
    join(root, "engineering/deployment-contract/fixtures/published-record-v1.valid.json"),
  ),
);
const repo = "vayada-marketplace/vayada";
const sourceRun = {
  id: 41001,
  run_attempt: 2,
  status: "completed",
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_sha: "1".repeat(40),
  head_repository: { full_name: repo },
  repository: { full_name: repo },
  path: ".github/workflows/build-coordinated-release.yml",
};
// Attempt 1 failed only after upload. Latest attempt 2 must never be consulted.
const publisherRun = {
  ...sourceRun,
  id: 42001,
  run_attempt: 1,
  conclusion: "failure",
  event: "workflow_run",
  path: ".github/workflows/publish-coordinated-release.yml",
};
const artifact = {
  id: 90211,
  name: record.publishedArtifactName,
  expired: false,
  workflow_run: { id: 42001 },
};

function run(script, overrides = {}, recordOverride = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vayada-publisher-retry-"));
  try {
    mkdirSync(join(directory, "fixture"));
    symlinkSync(join(root, "scripts"), join(directory, "scripts"));
    const contents = JSON.stringify({ ...record, ...recordOverride });
    for (const [name, value] of Object.entries({
      "manifest.json": manifest,
      "manifest.sha256": sha256(manifest),
      "published-record.json": contents,
      "published-record.sha256": sha256(contents),
      "prepare-only": "false",
    }))
      writeFileSync(join(directory, "fixture", name), value);
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      gh() {
        printf '%s\\n' "$*" >> "$CALLS"
        case "$*" in
          *"/runs/42002/artifacts?per_page=100"*) printf '%s' "$EXISTING" ;;
          *"/runs/41001/attempts/2") printf '%s' "$SOURCE_RUN" ;;
          *"/runs/42001/attempts/1") printf '%s' "$PUBLISHER_RUN" ;;
          *"/runs/41001/artifacts"*) echo '{"id":90210}' ;;
          *"/runs/42002 --jq .created_at") echo 2026-09-20T10:31:42Z ;;
          *"/actions/artifacts?per_page=100"*) printf '90211\\t%s\\n' "$ARTIFACT_NAME" ;;
          *"/actions/artifacts/90211") printf '%s' "$ARTIFACT" ;;
          *"/actions/artifacts/90211/zip"|*"/actions/artifacts/90210/zip") echo mocked-zip ;;
          *) echo "Unexpected API call: $*" >&2; return 1 ;;
        esac
      }
      unzip() { mkdir -p "$4"; cp fixture/* "$4/"; }
      date() { if test "$*" = '-u +%s'; then echo 1790000000; else echo 1800000000; fi; }
      ${script}
    `,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: repo,
          GITHUB_RUN_ID: "42002",
          GITHUB_RUN_ATTEMPT: "1",
          SOURCE_RUN_ID: "41001",
          SOURCE_RUN_ATTEMPT: "2",
          SOURCE_SHA: "1".repeat(40),
          SOURCE_EVENT: "push",
          RELEASES_ENABLED: "true",
          REDISPATCH_ARTIFACT_ID: "90211",
          GITHUB_OUTPUT: join(directory, "output"),
          CALLS: join(directory, "calls"),
          SOURCE_RUN: JSON.stringify(sourceRun),
          PUBLISHER_RUN: JSON.stringify(publisherRun),
          ARTIFACT: JSON.stringify(artifact),
          ARTIFACT_NAME: artifact.name,
          EXISTING: "",
          ...overrides,
        },
      },
    );
    const read = (path) => {
      try {
        return readFileSync(join(directory, path), "utf8");
      } catch {
        return "";
      }
    };
    return {
      ...result,
      output: read("output"),
      calls: read("calls"),
      candidates: read("release-work/candidates/90211/published-record.json"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const prepare = step(publish, "Download and validate exact source artifact");
test("historical publication redispatch preserves the original immutable identity after later reruns", () => {
  const result = run(prepare);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /runs\/42001\/attempts\/1/);
  assert.match(result.output, /mode=redispatch\npublished-artifact-id=90211/);
});
test("source validation uses the exact successful historical build attempt", () => {
  const result = run(prepare, { GITHUB_EVENT_NAME: "workflow_run" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls, /runs\/41001\/attempts\/2/);
  assert.match(result.output, /mode=publish/);
});
test("existing publication stops rerun before candidate download or replacement upload", () => {
  const result = run(prepare, {
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_RUN_ATTEMPT: "2",
    EXISTING: "90211",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /fresh workflow_dispatch on main.*published_artifact_id/);
  assert.equal(result.calls.trim().split("\n").length, 1);
});
test("exact-attempt trust failures and tampered identity fail closed", () => {
  for (const changes of [
    { id: 42002 },
    { run_attempt: 2 },
    { status: "in_progress" },
    { event: "push" },
    { head_branch: "other" },
    { path: "untrusted.yml" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "other/repo" } },
  ]) {
    const result = run(prepare, { PUBLISHER_RUN: JSON.stringify({ ...publisherRun, ...changes }) });
    assert.notEqual(result.status, 0, JSON.stringify(changes));
    assert.ok(!result.output.includes("mode=redispatch"));
  }
  for (const changes of [
    { run_attempt: 3 },
    { conclusion: "failure" },
    { id: 41002 },
    { event: "workflow_dispatch" },
    { head_sha: "2".repeat(40) },
  ]) {
    assert.notEqual(
      run(prepare, {
        GITHUB_EVENT_NAME: "workflow_run",
        SOURCE_RUN: JSON.stringify({ ...sourceRun, ...changes }),
      }).status,
      0,
    );
  }
  for (const changes of [
    { expired: true },
    { workflow_run: { id: 42002 } },
    { name: `${artifact.name}-wrong` },
  ])
    assert.notEqual(
      run(prepare, { ARTIFACT: JSON.stringify({ ...artifact, ...changes }) }).status,
      0,
    );
  assert.notEqual(run(prepare, {}, { manifestSha256: "0".repeat(64) }).status, 0);
  assert.notEqual(
    run(prepare, {}, { publisher: { ...record.publisher, runAttempt: 2 } }).status,
    0,
  );
});
test("baseline discovery accepts historical publishers and ignores invalid attempt metadata", () => {
  const script = step(build, "Download non-expired published baseline candidates");
  const valid = run(script);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.candidates).publisher.runAttempt, 1);
  for (const changes of [
    { run_attempt: 2 },
    { id: 42002 },
    { path: "untrusted.yml" },
    { status: "in_progress" },
    { head_branch: "other" },
    { event: "push" },
    { repository: { full_name: "other/repo" } },
  ]) {
    const invalid = run(script, { PUBLISHER_RUN: JSON.stringify({ ...publisherRun, ...changes }) });
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(invalid.candidates, "", JSON.stringify(changes));
  }
});
test("manual redispatch is permitted while disabled, but remains main-only", () => {
  const condition = publish.split("    if: >-\n")[1].split("    runs-on:")[0];
  assert.match(condition, /github.ref == 'refs\/heads\/main' &&/);
  assert.match(
    condition,
    /vars.COORDINATED_RELEASES_ENABLED == 'true' \|\| github.event_name == 'workflow_dispatch'/,
  );
  assert.ok(!publish.includes("overwrite:"));
});
