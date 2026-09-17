import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SERVICE_CONFIG, SERVICE_KEYS, assembleManifest, stableJson } from "./lib.mjs";

const SCRIPT = fileURLToPath(new URL("plan.mjs", import.meta.url));
const SERVICES = fileURLToPath(
  new URL("../../deployment/coordinated-release/services.json", import.meta.url),
);

function git(repository, ...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function commit(repository, message) {
  git(repository, "add", ".");
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function baselineManifest(sourceSha) {
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
    selection: {
      targetSha: sourceSha,
      affectedServices: SERVICE_KEYS,
      barriers: [],
    },
    imageRecords,
    baseline: null,
    build: { runId: 1001, runAttempt: 1, event: "push" },
  });
}

test("an intermediate barrier survives coalescing and deletion fails closed", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "vayada-release-plan-"));
  context.after(() => rmSync(repository, { recursive: true }));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Release Test");
  git(repository, "config", "user.email", "release-test@vayada.com");
  for (const [service, config] of Object.entries(SERVICE_CONFIG)) {
    write(
      join(repository, config.appPath, "package.json"),
      stableJson({ name: `fixture-${service}`, private: true }),
    );
  }
  const baselineSha = commit(repository, "baseline");
  const baselinePath = join(repository, "baseline.json");
  writeFileSync(baselinePath, stableJson(baselineManifest(baselineSha)));

  const barrierPath = join(
    repository,
    "deployment/coordinated-release/barriers/booking-ledger-backfill.json",
  );
  write(
    barrierPath,
    stableJson({
      id: "booking-ledger-backfill",
      kind: "backfill",
      requiredCheckpointManifestId: null,
      evidenceRequirement: "Operator acknowledgment with the completed backfill run URL",
    }),
  );
  const barrierSha = commit(repository, "introduce release barrier");
  write(join(repository, "docs/ordinary.md"), "later ordinary work\n");
  const targetSha = commit(repository, "later ordinary work");

  const output = join(repository, "plan.json");
  const acceptedBaseline = join(repository, "accepted-baseline.json");
  execFileSync(
    process.execPath,
    [
      SCRIPT,
      "--target",
      targetSha,
      "--services",
      SERVICES,
      "--baseline",
      baselinePath,
      "--accepted-baseline",
      acceptedBaseline,
      "--output",
      output,
    ],
    { cwd: repository, stdio: "pipe" },
  );
  const plan = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(plan.baselineAccepted, true);
  assert.deepEqual(plan.barriers, [
    {
      id: "booking-ledger-backfill",
      kind: "backfill",
      requiredCheckpointManifestId: null,
      evidenceRequirement: "Operator acknowledgment with the completed backfill run URL",
      introducedAt: barrierSha,
    },
  ]);

  rmSync(barrierPath);
  const deletedTarget = commit(repository, "delete release barrier");
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--target",
      deletedTarget,
      "--services",
      SERVICES,
      "--baseline",
      baselinePath,
      "--output",
      output,
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release barrier declarations are append-only/);
});
