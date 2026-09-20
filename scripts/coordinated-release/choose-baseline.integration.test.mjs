import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BUILD_WORKFLOW_NAME,
  BUILD_WORKFLOW_PATH,
  PUBLISH_WORKFLOW_NAME,
  PUBLISH_WORKFLOW_PATH,
  REPOSITORY,
  SERVICE_CONFIG,
  SERVICE_KEYS,
  assembleManifest,
  sha256,
  stableJson,
} from "./lib.mjs";

const SCRIPT = fileURLToPath(new URL("choose-baseline.mjs", import.meta.url));

function git(repository, ...args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repository, message) {
  writeFileSync(join(repository, "history.txt"), `${message}\n`, { flag: "a" });
  git(repository, "add", "history.txt");
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function manifest(sourceSha, runId, runAttempt = 1) {
  const imageRecords = Object.fromEntries(
    SERVICE_KEYS.map((service, index) => [
      service,
      {
        service,
        ecrRepository: SERVICE_CONFIG[service].ecrRepository,
        digest: `sha256:${String(index + 1).repeat(64)}`,
        imageSourceSha: sourceSha,
      },
    ]),
  );
  return assembleManifest({
    selection: { targetSha: sourceSha, affectedServices: SERVICE_KEYS, barriers: [] },
    imageRecords,
    baseline: null,
    build: { runId, runAttempt, event: "push" },
  });
}

function publishedRecord(releaseManifest, options = {}) {
  const publishedAt = options.publishedAt ?? new Date(Date.now() - 60_000);
  const producerRunAttempt = options.producerRunAttempt ?? releaseManifest.build.runAttempt;
  return {
    schemaVersion: 1,
    manifestId: releaseManifest.manifestId,
    manifestSha256: options.manifestSha256,
    candidateArtifactId: 9001,
    candidateArtifactName: `next-release-candidate-v1-${releaseManifest.build.runId}-${producerRunAttempt}`,
    producer: {
      repository: REPOSITORY,
      workflowName: BUILD_WORKFLOW_NAME,
      workflowPath: BUILD_WORKFLOW_PATH,
      runId: options.producerRunId ?? releaseManifest.build.runId,
      runAttempt: producerRunAttempt,
    },
    publisher: {
      repository: REPOSITORY,
      workflowName: PUBLISH_WORKFLOW_NAME,
      workflowPath: options.publisherWorkflowPath ?? PUBLISH_WORKFLOW_PATH,
      runId: 8001,
      runAttempt: 1,
    },
    publishedArtifactName: `next-release-published-v1-${releaseManifest.source.sha}-${releaseManifest.build.runId}-${releaseManifest.build.runAttempt}`,
    publishedAt: publishedAt.toISOString(),
    expiresAt: new Date(publishedAt.valueOf() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    retentionDays: 90,
    idempotencyKey: releaseManifest.manifestId,
  };
}

function writeCandidate(root, name, releaseManifest, recordOptions = {}, detachedHash = null) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const manifestContents = stableJson(releaseManifest);
  const record = publishedRecord(releaseManifest, {
    ...recordOptions,
    manifestSha256: sha256(manifestContents),
  });
  const recordContents = stableJson(record);
  writeFileSync(join(directory, "manifest.json"), manifestContents);
  writeFileSync(join(directory, "manifest.sha256"), `${sha256(manifestContents)}\n`);
  writeFileSync(join(directory, "published-record.json"), recordContents);
  writeFileSync(
    join(directory, "published-record.sha256"),
    `${detachedHash ?? sha256(recordContents)}\n`,
  );
}

function repository(context) {
  const path = mkdtempSync(join(tmpdir(), "vayada-release-baseline-"));
  context.after(() => rmSync(path, { recursive: true }));
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Release Test");
  git(path, "config", "user.email", "release-test@vayada.com");
  return path;
}

function choose(repositoryPath, candidates, targetSha, output) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--candidates", candidates, "--target", targetSha, "--output", output],
    { cwd: repositoryPath, encoding: "utf8" },
  );
}

test("baseline selection uses ancestry and the newest exact run attempt", (context) => {
  const repo = repository(context);
  const olderSha = commit(repo, "older");
  const newerSha = commit(repo, "newer");
  const targetSha = commit(repo, "target");
  const candidates = join(repo, "candidates");
  writeCandidate(candidates, "newer-attempt-1", manifest(newerSha, 2002, 1));
  writeCandidate(candidates, "older", manifest(olderSha, 9999, 1));
  writeCandidate(candidates, "newer-attempt-2", manifest(newerSha, 2002, 2));

  const output = join(repo, "chosen.json");
  const result = choose(repo, candidates, targetSha, output);
  assert.equal(result.status, 0, result.stderr);
  const chosen = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(chosen.source.sha, newerSha);
  assert.equal(chosen.build.runId, 2002);
  assert.equal(chosen.build.runAttempt, 2);
});

test("tampered, expired, divergent, and substituted publication records are ineligible", (context) => {
  const repo = repository(context);
  const sourceSha = commit(repo, "source");
  const targetSha = commit(repo, "target");
  git(repo, "switch", "-c", "divergent", sourceSha);
  const divergentSha = commit(repo, "divergent");
  git(repo, "switch", "main");
  const candidates = join(repo, "candidates");
  writeCandidate(candidates, "tampered-record", manifest(sourceSha, 3001), {}, "0".repeat(64));
  writeCandidate(candidates, "expired", manifest(sourceSha, 3002), {
    publishedAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  writeCandidate(candidates, "divergent", manifest(divergentSha, 3003));
  writeCandidate(candidates, "producer-substitution", manifest(sourceSha, 3004), {
    producerRunAttempt: 2,
  });
  writeCandidate(candidates, "publisher-substitution", manifest(sourceSha, 3005), {
    publisherWorkflowPath: ".github/workflows/untrusted.yml",
  });

  const output = join(repo, "chosen.json");
  const result = choose(repo, candidates, targetSha, output);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /published record hash does not match/);
  assert.match(result.stderr, /published record is expired/);
  assert.match(result.stderr, /manifest source is not an ancestor/);
  assert.match(result.stderr, /producer does not match manifest build/);
  assert.match(result.stderr, /publisher.workflowPath is invalid/);
  assert.match(result.stderr, /No verifiable non-expired published baseline/);
  assert.throws(() => readFileSync(output, "utf8"), /ENOENT/);
});
