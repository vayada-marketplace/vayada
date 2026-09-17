#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import {
  PUBLISH_WORKFLOW_NAME,
  PUBLISH_WORKFLOW_PATH,
  REPOSITORY,
  parseArgs,
  requiredOption,
  sha256,
  stableJson,
  validateManifest,
  validatePublishedRecord,
} from "./lib.mjs";

const options = parseArgs(process.argv.slice(2));
const manifestPath = requiredOption(options, "manifest");
const manifestContents = readFileSync(manifestPath, "utf8");
const manifest = validateManifest(JSON.parse(manifestContents));
const expectedHash = readFileSync(requiredOption(options, "manifest-hash"), "utf8")
  .trim()
  .split(/\s+/)[0];
const actualHash = sha256(manifestContents);
if (expectedHash !== actualHash) {
  throw new Error(`candidate manifest hash mismatch: ${expectedHash} != ${actualHash}`);
}
const candidateArtifactId = Number(requiredOption(options, "candidate-artifact-id"));
const publisherRunId = Number(requiredOption(options, "publisher-run-id"));
const publisherRunAttempt = Number(requiredOption(options, "publisher-run-attempt"));
const publishedAt = new Date(requiredOption(options, "published-at"));
if (!Number.isFinite(publishedAt.valueOf())) throw new Error("published-at is invalid");
const expiresAt = new Date(publishedAt.valueOf() + 90 * 24 * 60 * 60 * 1000);
const record = {
  schemaVersion: 1,
  manifestId: manifest.manifestId,
  manifestSha256: actualHash,
  candidateArtifactId,
  candidateArtifactName: `next-release-candidate-v1-${manifest.build.runId}-${manifest.build.runAttempt}`,
  producer: {
    repository: REPOSITORY,
    workflowName: manifest.build.workflowName,
    workflowPath: manifest.build.workflowPath,
    runId: manifest.build.runId,
    runAttempt: manifest.build.runAttempt,
  },
  publisher: {
    repository: REPOSITORY,
    workflowName: PUBLISH_WORKFLOW_NAME,
    workflowPath: PUBLISH_WORKFLOW_PATH,
    runId: publisherRunId,
    runAttempt: publisherRunAttempt,
  },
  publishedArtifactName: `next-release-published-v1-${manifest.source.sha}-${manifest.build.runId}-${manifest.build.runAttempt}`,
  publishedAt: publishedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  retentionDays: 90,
  idempotencyKey: manifest.manifestId,
};
validatePublishedRecord(record);
const contents = stableJson(record);
writeFileSync(requiredOption(options, "output"), contents);
writeFileSync(requiredOption(options, "hash-output"), `${sha256(contents)}\n`);
console.log(record.publishedArtifactName);
