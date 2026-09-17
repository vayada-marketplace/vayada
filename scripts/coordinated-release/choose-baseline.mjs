#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseArgs,
  requiredOption,
  sha256,
  stableJson,
  validateManifest,
  validatePublishedRecord,
} from "./lib.mjs";

function files(root, name) {
  const matches = [];
  if (!existsSync(root)) return matches;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) matches.push(...files(path, name));
    else if (entry === name) matches.push(path);
  }
  return matches;
}

function ancestor(left, right) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", left, right], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function loadCandidate(manifestPath, targetSha) {
  try {
    const directory = dirname(manifestPath);
    const recordPath = join(directory, "published-record.json");
    const manifestHashPath = join(directory, "manifest.sha256");
    const recordHashPath = join(directory, "published-record.sha256");
    if (!existsSync(recordPath) || !existsSync(manifestHashPath) || !existsSync(recordHashPath)) {
      throw new Error("publication record or detached hash is missing");
    }
    const manifestContents = readFileSync(manifestPath, "utf8");
    const recordContents = readFileSync(recordPath, "utf8");
    const manifest = validateManifest(JSON.parse(manifestContents));
    const record = validatePublishedRecord(JSON.parse(recordContents));
    const declaredManifestHash = readFileSync(manifestHashPath, "utf8").trim().split(/\s+/)[0];
    const declaredRecordHash = readFileSync(recordHashPath, "utf8").trim().split(/\s+/)[0];
    const actualManifestHash = sha256(manifestContents);
    const actualRecordHash = sha256(recordContents);
    if (
      declaredManifestHash !== actualManifestHash ||
      record.manifestSha256 !== actualManifestHash
    ) {
      throw new Error("manifest hash does not match the publication record");
    }
    if (declaredRecordHash !== actualRecordHash) {
      throw new Error("published record hash does not match its detached hash");
    }
    if (record.manifestId !== manifest.manifestId) {
      throw new Error("publication record references another manifest");
    }
    if (
      record.producer.runId !== manifest.build.runId ||
      record.producer.runAttempt !== manifest.build.runAttempt
    ) {
      throw new Error("publication record producer does not match manifest build");
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new Error("published record is expired");
    }
    if (!ancestor(manifest.source.sha, targetSha)) {
      throw new Error("manifest source is not an ancestor of the target");
    }
    return { manifest, record, manifestPath };
  } catch (error) {
    console.error(`::warning::Ignoring baseline candidate ${manifestPath}: ${error.message}`);
    return null;
  }
}

function newer(left, right) {
  if (left.manifest.source.sha === right.manifest.source.sha) {
    if (left.manifest.build.runId !== right.manifest.build.runId) {
      return left.manifest.build.runId > right.manifest.build.runId ? left : right;
    }
    return left.manifest.build.runAttempt >= right.manifest.build.runAttempt ? left : right;
  }
  if (ancestor(left.manifest.source.sha, right.manifest.source.sha)) return right;
  if (ancestor(right.manifest.source.sha, left.manifest.source.sha)) return left;
  throw new Error(
    `published baseline sources diverge: ${left.manifest.source.sha} and ${right.manifest.source.sha}`,
  );
}

const options = parseArgs(process.argv.slice(2));
const candidatesPath = requiredOption(options, "candidates");
const targetSha = requiredOption(options, "target");
const output = requiredOption(options, "output");
const candidates = files(candidatesPath, "manifest.json")
  .map((path) => loadCandidate(path, targetSha))
  .filter(Boolean);
if (candidates.length === 0) {
  console.error("::warning::No verifiable non-expired published baseline was found");
  process.exit(0);
}
const chosen = candidates.reduce(newer);
writeFileSync(output, stableJson(chosen.manifest));
console.log(`Selected baseline ${chosen.manifest.manifestId}`);
