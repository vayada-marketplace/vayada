#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  SERVICE_KEYS,
  parseArgs,
  parseNameStatus,
  requiredOption,
  selectAffectedServices,
  stableJson,
  validateBarrierDeclaration,
  validateManifest,
  workspaceSnapshot,
} from "./lib.mjs";

function git(parameters, options = {}) {
  return execFileSync("git", parameters, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "inherit"],
  }).trim();
}

function gitSucceeds(parameters) {
  try {
    execFileSync("git", parameters, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function loadSnapshot(ref) {
  if (!ref) return workspaceSnapshot([]);
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", "apps", "packages"])
    .split("\n")
    .filter((path) => /^(apps|packages)\/[^/]+\/package\.json$/.test(path));
  const entries = files.map((path) => ({
    path: path.slice(0, -"/package.json".length),
    packageJson: JSON.parse(git(["show", `${ref}:${path}`])),
  }));
  return workspaceSnapshot(entries);
}

function loadBaseline(path, targetSha) {
  if (!path) return { baseline: null, reason: "baseline artifact was not found" };
  try {
    const baseline = validateManifest(JSON.parse(readFileSync(path, "utf8")));
    if (!gitSucceeds(["cat-file", "-e", `${baseline.source.sha}^{commit}`])) {
      return { baseline: null, reason: "baseline source commit is unavailable" };
    }
    if (!gitSucceeds(["merge-base", "--is-ancestor", baseline.source.sha, targetSha])) {
      return { baseline: null, reason: "baseline source is not an ancestor of target" };
    }
    for (const [service, image] of Object.entries(baseline.services)) {
      if (!gitSucceeds(["cat-file", "-e", `${image.imageSourceSha}^{commit}`])) {
        return {
          baseline: null,
          reason: `baseline image source for ${service} is unavailable`,
        };
      }
      if (
        !gitSucceeds(["merge-base", "--is-ancestor", image.imageSourceSha, baseline.source.sha])
      ) {
        return {
          baseline: null,
          reason: `baseline image source for ${service} is not an ancestor of the baseline`,
        };
      }
    }
    return { baseline, reason: null };
  } catch (error) {
    return { baseline: null, reason: `baseline is unverifiable: ${error.message}` };
  }
}

function barrierChanges(commit) {
  const output = git([
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-M",
    commit,
    "--",
    "deployment/coordinated-release/barriers",
  ]);
  return output ? parseNameStatus(output) : [];
}

function collectBarriers(baseline, targetSha) {
  const barriers = new Map((baseline?.barriers ?? []).map((item) => [item.id, item]));
  const range = baseline ? `${baseline.source.sha}..${targetSha}` : targetSha;
  const commits = git([
    "rev-list",
    "--reverse",
    range,
    "--",
    "deployment/coordinated-release/barriers",
  ])
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    for (const change of barrierChanges(commit)) {
      if (change.status === "D" || change.status === "R") {
        throw new Error(
          `release barrier declarations are append-only; ${change.status}:${change.paths.join(" -> ")} at ${commit}`,
        );
      }
      for (const path of change.paths) {
        if (!path.endsWith(".json")) {
          throw new Error(`unknown release barrier input ${path}`);
        }
        const declaration = validateBarrierDeclaration(
          JSON.parse(git(["show", `${commit}:${path}`])),
          path,
        );
        const barrier = { ...declaration, introducedAt: commit };
        const existing = barriers.get(barrier.id);
        if (existing && stableJson(existing) !== stableJson(barrier)) {
          throw new Error(`release barrier ${barrier.id} was modified after introduction`);
        }
        barriers.set(barrier.id, barrier);
      }
    }
  }
  return [...barriers.values()].sort((left, right) => left.id.localeCompare(right.id));
}

const options = parseArgs(process.argv.slice(2));
const targetSha = requiredOption(options, "target");
const output = requiredOption(options, "output");
const servicesPath = requiredOption(options, "services");
if (!gitSucceeds(["cat-file", "-e", `${targetSha}^{commit}`])) {
  throw new Error(`target ${targetSha} is not a commit`);
}

const serviceConfig = JSON.parse(readFileSync(servicesPath, "utf8"));
if (Object.keys(serviceConfig).sort().join("\0") !== [...SERVICE_KEYS].sort().join("\0")) {
  throw new Error("service config must define exactly the six managed services");
}

const { baseline, reason: baselineReason } = loadBaseline(options.get("baseline"), targetSha);
if (baselineReason) console.error(`::warning::${baselineReason}; rebuilding all services`);
const changes = baseline
  ? parseNameStatus(git(["diff", "--name-status", "-M", baseline.source.sha, targetSha]))
  : [];
const selected = selectAffectedServices({
  changes,
  oldSnapshot: loadSnapshot(baseline?.source.sha),
  newSnapshot: loadSnapshot(targetSha),
  serviceConfig,
  baselineAvailable: baseline !== null,
});
const plan = {
  schemaVersion: 1,
  targetSha,
  baselineAccepted: baseline !== null,
  baselineReason,
  previousManifestId: baseline?.manifestId ?? null,
  previousSourceSha: baseline?.source.sha ?? null,
  affectedServices: selected.affectedServices,
  reasons: selected.reasons,
  barriers: collectBarriers(baseline, targetSha),
};
writeFileSync(output, stableJson(plan));
if (options.get("accepted-baseline") && baseline) {
  writeFileSync(options.get("accepted-baseline"), stableJson(baseline));
}
console.log(stableJson(plan));
