#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { sha256, validateManifest, validatePublishedRecord } from "./lib.mjs";

const [manifestPath, recordPath, artifactId] = process.argv.slice(2);
if (!manifestPath || !recordPath || !artifactId) {
  throw new Error(
    "usage: dispatch-payload.mjs <manifest> <published-record> <published-artifact-id>",
  );
}
const manifestContents = readFileSync(manifestPath, "utf8");
const recordContents = readFileSync(recordPath, "utf8");
const manifest = validateManifest(JSON.parse(manifestContents));
const record = validatePublishedRecord(JSON.parse(recordContents));
if (manifest.manifestId !== record.manifestId) {
  throw new Error("manifest and published record identities differ");
}
if (sha256(manifestContents) !== record.manifestSha256) {
  throw new Error("published record does not bind manifest contents");
}
const publishedArtifactId = Number(artifactId);
if (!Number.isInteger(publishedArtifactId) || publishedArtifactId < 1) {
  throw new Error("published artifact ID must be positive");
}
console.log(
  JSON.stringify({
    event_type: "coordinated-release-published",
    client_payload: {
      schemaVersion: 1,
      manifestId: manifest.manifestId,
      manifestSha256: record.manifestSha256,
      publishedRecordSha256: sha256(recordContents),
      sourceSha: manifest.source.sha,
      repository: manifest.repository,
      workflowName: manifest.build.workflowName,
      workflowPath: manifest.build.workflowPath,
      runId: manifest.build.runId,
      runAttempt: manifest.build.runAttempt,
      publishedArtifactId,
      publishedArtifactName: record.publishedArtifactName,
      publisherRunId: record.publisher.runId,
      publisherRunAttempt: record.publisher.runAttempt,
      idempotencyKey: record.idempotencyKey,
    },
  }),
);
