import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const REPOSITORY = "vayada-marketplace/vayada";
export const BUILD_WORKFLOW_NAME = "Build coordinated next release";
export const BUILD_WORKFLOW_PATH = ".github/workflows/build-coordinated-release.yml";
export const PUBLISH_WORKFLOW_NAME = "Publish coordinated next release";
export const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-coordinated-release.yml";

export const SERVICE_CONFIG = Object.freeze(
  JSON.parse(
    readFileSync(
      new URL("../../deployment/coordinated-release/services.json", import.meta.url),
      "utf8",
    ),
  ),
);
export const SERVICE_REPOSITORIES = Object.freeze(
  Object.fromEntries(
    Object.entries(SERVICE_CONFIG).map(([service, config]) => [service, config.ecrRepository]),
  ),
);

export const SERVICE_KEYS = Object.freeze(Object.keys(SERVICE_REPOSITORIES));

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const MANIFEST_ID = /^vayada-release\/v1\/([0-9a-f]{40})\/([1-9][0-9]*)\/([1-9][0-9]*)$/;
const BARRIER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const BARRIER_KINDS = new Set(["migration", "backfill", "application"]);

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      fail(`invalid argument near ${argv[index] ?? "end of arguments"}`);
    }
    result.set(argv[index].slice(2), argv[index + 1]);
  }
  return result;
}

export function requiredOption(options, name) {
  const value = options.get(name);
  if (!value) fail(`--${name} is required`);
  return value;
}

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(object(value, name)).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${name} keys must be exactly [${wanted.join(", ")}], got [${actual.join(", ")}]`);
  }
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) fail(`${name} must be positive`);
}

function sha(value, name) {
  if (typeof value !== "string" || !SHA.test(value)) {
    fail(`${name} must be a lowercase 40-character SHA`);
  }
}

function hash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail(`${name} must be a lowercase SHA-256 hash`);
  }
}

export function manifestId(sourceSha, runId, runAttempt) {
  sha(sourceSha, "sourceSha");
  positiveInteger(runId, "runId");
  positiveInteger(runAttempt, "runAttempt");
  return `vayada-release/v1/${sourceSha}/${runId}/${runAttempt}`;
}

export function validateBarrier(value, name = "barrier") {
  exactKeys(
    value,
    ["id", "kind", "introducedAt", "requiredCheckpointManifestId", "evidenceRequirement"],
    name,
  );
  if (typeof value.id !== "string" || !BARRIER_ID.test(value.id)) {
    fail(`${name}.id is invalid`);
  }
  if (!BARRIER_KINDS.has(value.kind)) fail(`${name}.kind is invalid`);
  sha(value.introducedAt, `${name}.introducedAt`);
  if (
    value.requiredCheckpointManifestId !== null &&
    (typeof value.requiredCheckpointManifestId !== "string" ||
      !MANIFEST_ID.test(value.requiredCheckpointManifestId))
  ) {
    fail(`${name}.requiredCheckpointManifestId is invalid`);
  }
  if (typeof value.evidenceRequirement !== "string" || value.evidenceRequirement.length === 0) {
    fail(`${name}.evidenceRequirement must not be empty`);
  }
  return value;
}

export function validateBarrierDeclaration(value, name = "barrier declaration") {
  exactKeys(value, ["id", "kind", "requiredCheckpointManifestId", "evidenceRequirement"], name);
  validateBarrier({ ...value, introducedAt: "0".repeat(40) }, name);
  return value;
}

export function validateManifest(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "manifestId",
      "repository",
      "source",
      "build",
      "previousManifestId",
      "previousSourceSha",
      "compatibility",
      "barriers",
      "services",
    ],
    "manifest",
  );
  if (value.schemaVersion !== 1) fail("manifest.schemaVersion must be 1");
  if (value.repository !== REPOSITORY) fail("manifest.repository is not trusted");

  exactKeys(value.source, ["sha", "branch"], "manifest.source");
  sha(value.source.sha, "manifest.source.sha");
  if (value.source.branch !== "main") fail("manifest.source.branch must be main");

  exactKeys(
    value.build,
    ["workflowName", "workflowPath", "runId", "runAttempt", "event"],
    "manifest.build",
  );
  if (value.build.workflowName !== BUILD_WORKFLOW_NAME) {
    fail("manifest.build.workflowName is not allowlisted");
  }
  if (value.build.workflowPath !== BUILD_WORKFLOW_PATH) {
    fail("manifest.build.workflowPath is not allowlisted");
  }
  positiveInteger(value.build.runId, "manifest.build.runId");
  positiveInteger(value.build.runAttempt, "manifest.build.runAttempt");
  if (!new Set(["push", "workflow_dispatch"]).has(value.build.event)) {
    fail("manifest.build.event is not allowlisted");
  }
  const expectedId = manifestId(value.source.sha, value.build.runId, value.build.runAttempt);
  if (value.manifestId !== expectedId) {
    fail(`manifest.manifestId must equal ${expectedId}`);
  }

  if ((value.previousManifestId === null) !== (value.previousSourceSha === null)) {
    fail("previous manifest identity and source SHA must both be null or both be set");
  }
  if (value.previousManifestId !== null) {
    if (
      typeof value.previousManifestId !== "string" ||
      !MANIFEST_ID.test(value.previousManifestId)
    ) {
      fail("manifest.previousManifestId is invalid");
    }
    sha(value.previousSourceSha, "manifest.previousSourceSha");
    if (!value.previousManifestId.includes(`/${value.previousSourceSha}/`)) {
      fail("manifest.previousManifestId does not bind previousSourceSha");
    }
  }

  exactKeys(
    value.compatibility,
    ["mode", "apiBackwardCompatible", "frontendBackwardCompatible"],
    "manifest.compatibility",
  );
  if (
    value.compatibility.mode !== "ordinary" ||
    value.compatibility.apiBackwardCompatible !== true ||
    value.compatibility.frontendBackwardCompatible !== true
  ) {
    fail("manifest v1 only permits ordinary backward-compatible releases");
  }

  if (!Array.isArray(value.barriers)) fail("manifest.barriers must be an array");
  const barrierIds = new Set();
  for (const [index, barrier] of value.barriers.entries()) {
    validateBarrier(barrier, `manifest.barriers[${index}]`);
    if (barrierIds.has(barrier.id)) fail(`duplicate barrier ${barrier.id}`);
    barrierIds.add(barrier.id);
  }

  exactKeys(value.services, SERVICE_KEYS, "manifest.services");
  for (const service of SERVICE_KEYS) {
    const image = value.services[service];
    exactKeys(image, ["ecrRepository", "digest", "imageSourceSha"], `manifest.services.${service}`);
    if (image.ecrRepository !== SERVICE_REPOSITORIES[service]) {
      fail(`manifest.services.${service}.ecrRepository is not allowlisted`);
    }
    if (typeof image.digest !== "string" || !DIGEST.test(image.digest)) {
      fail(`manifest.services.${service}.digest is invalid`);
    }
    sha(image.imageSourceSha, `manifest.services.${service}.imageSourceSha`);
  }
  return value;
}

function validateWorkflow(value, name, expectedName, expectedPath) {
  exactKeys(value, ["repository", "workflowName", "workflowPath", "runId", "runAttempt"], name);
  if (value.repository !== REPOSITORY) fail(`${name}.repository is not trusted`);
  if (value.workflowName !== expectedName) fail(`${name}.workflowName is invalid`);
  if (value.workflowPath !== expectedPath) fail(`${name}.workflowPath is invalid`);
  positiveInteger(value.runId, `${name}.runId`);
  positiveInteger(value.runAttempt, `${name}.runAttempt`);
}

export function validatePublishedRecord(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "manifestId",
      "manifestSha256",
      "candidateArtifactId",
      "candidateArtifactName",
      "producer",
      "publisher",
      "publishedArtifactName",
      "publishedAt",
      "expiresAt",
      "retentionDays",
      "idempotencyKey",
    ],
    "published record",
  );
  if (value.schemaVersion !== 1) fail("published record schemaVersion must be 1");
  if (typeof value.manifestId !== "string" || !MANIFEST_ID.test(value.manifestId)) {
    fail("published record manifestId is invalid");
  }
  hash(value.manifestSha256, "published record manifestSha256");
  positiveInteger(value.candidateArtifactId, "candidateArtifactId");
  validateWorkflow(value.producer, "producer", BUILD_WORKFLOW_NAME, BUILD_WORKFLOW_PATH);
  validateWorkflow(value.publisher, "publisher", PUBLISH_WORKFLOW_NAME, PUBLISH_WORKFLOW_PATH);
  const candidateName = `next-release-candidate-v1-${value.producer.runId}-${value.producer.runAttempt}`;
  if (value.candidateArtifactName !== candidateName) {
    fail(`candidateArtifactName must equal ${candidateName}`);
  }
  const match = MANIFEST_ID.exec(value.manifestId);
  const publishedName = `next-release-published-v1-${match[1]}-${match[2]}-${match[3]}`;
  if (value.publishedArtifactName !== publishedName) {
    fail(`publishedArtifactName must equal ${publishedName}`);
  }
  if (value.idempotencyKey !== value.manifestId) {
    fail("idempotencyKey must equal manifestId");
  }
  if (value.retentionDays !== 90) fail("retentionDays must be 90");
  const publishedAt = Date.parse(value.publishedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(publishedAt) || !Number.isFinite(expiresAt)) {
    fail("publication timestamps must be ISO date-times");
  }
  const expectedExpiry = publishedAt + 90 * 24 * 60 * 60 * 1000;
  if (Math.abs(expiresAt - expectedExpiry) > 1000) {
    fail("expiresAt must be exactly 90 days after publishedAt");
  }
  return value;
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseNameStatus(text) {
  const changes = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const [status, ...paths] = line.split("\t");
    if (!status || paths.length === 0) fail(`invalid git name-status line: ${line}`);
    const kind = status[0];
    if (!new Set(["A", "C", "D", "M", "R", "T", "U"]).has(kind)) {
      fail(`unsupported git change status: ${status}`);
    }
    changes.push({ status: kind, paths });
  }
  return changes;
}

export function workspaceSnapshot(entries) {
  const byName = new Map();
  const byPath = new Map();
  for (const entry of entries) {
    if (!entry?.path || !entry.packageJson?.name) continue;
    const dependencies = Object.keys({
      ...(entry.packageJson.dependencies ?? {}),
      ...(entry.packageJson.devDependencies ?? {}),
      ...(entry.packageJson.optionalDependencies ?? {}),
    });
    const workspace = { path: entry.path, name: entry.packageJson.name, dependencies };
    byName.set(workspace.name, workspace);
    byPath.set(workspace.path, workspace);
  }
  return { byName, byPath };
}

function dependencyClosure(snapshot, rootPath) {
  const root = snapshot.byPath.get(rootPath);
  if (!root) return new Set([rootPath]);
  const paths = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const workspace = pending.pop();
    if (paths.has(workspace.path)) continue;
    paths.add(workspace.path);
    for (const name of workspace.dependencies) {
      const dependency = snapshot.byName.get(name);
      if (dependency && !paths.has(dependency.path)) pending.push(dependency);
    }
  }
  return paths;
}

function workspaceForPath(snapshot, path) {
  let match = null;
  for (const workspacePath of snapshot.byPath.keys()) {
    if (
      (path === workspacePath || path.startsWith(`${workspacePath}/`)) &&
      (!match || workspacePath.length > match.length)
    ) {
      match = workspacePath;
    }
  }
  return match;
}

const GLOBAL_INPUTS = new Set([
  ".dockerignore",
  ".npmrc",
  ".nvmrc",
  "package.json",
  "package-lock.json",
]);

const API_RUNTIME_INPUTS = [
  "scripts/start-next-api.sh",
  "scripts/c1-rehearsal-replay-fixtures.mjs",
  "engineering/fixtures/c1-staging-rehearsal-replay/",
  "packages/backend-migration/",
];

function matchesPrefix(path, prefix) {
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
}

export function selectAffectedServices({
  changes,
  oldSnapshot,
  newSnapshot,
  serviceConfig,
  baselineAvailable = true,
}) {
  const selected = new Set();
  const reasons = Object.fromEntries(SERVICE_KEYS.map((key) => [key, []]));
  const select = (services, reason) => {
    for (const service of services) {
      selected.add(service);
      if (!reasons[service].includes(reason)) reasons[service].push(reason);
    }
  };
  if (!baselineAvailable) {
    select(SERVICE_KEYS, "complete rebuild: no verifiable baseline");
    return { affectedServices: SERVICE_KEYS, reasons };
  }

  const closures = {};
  for (const service of SERVICE_KEYS) {
    const appPath = serviceConfig[service].appPath;
    closures[service] = new Set([
      ...dependencyClosure(oldSnapshot, appPath),
      ...dependencyClosure(newSnapshot, appPath),
    ]);
  }
  closures["next-target-backend"] = new Set([
    ...closures["next-target-backend"],
    ...dependencyClosure(oldSnapshot, "packages/backend-migration"),
    ...dependencyClosure(newSnapshot, "packages/backend-migration"),
  ]);

  for (const change of changes) {
    for (const path of change.paths) {
      const reason = `${change.status}:${path}`;
      if (
        GLOBAL_INPUTS.has(path) ||
        /^tsconfig(?:\.[^.]+)?\.json$/.test(path) ||
        path.startsWith("deployment/coordinated-release/") ||
        path.startsWith("scripts/coordinated-release/") ||
        path === BUILD_WORKFLOW_PATH
      ) {
        select(SERVICE_KEYS, reason);
        continue;
      }
      if (API_RUNTIME_INPUTS.some((prefix) => matchesPrefix(path, prefix))) {
        select(["next-target-backend"], reason);
      }
      let knownWorkspace = false;
      for (const snapshot of [oldSnapshot, newSnapshot]) {
        const workspace = workspaceForPath(snapshot, path);
        if (!workspace) continue;
        knownWorkspace = true;
        for (const service of SERVICE_KEYS) {
          if (closures[service].has(workspace)) select([service], reason);
        }
      }
      for (const service of SERVICE_KEYS) {
        const appPath = serviceConfig[service].appPath;
        if (path === appPath || path.startsWith(`${appPath}/`)) {
          select([service], reason);
          knownWorkspace = true;
        }
      }
      if (path.startsWith("packages/") && !knownWorkspace) {
        select(SERVICE_KEYS, `${reason}: unknown workspace input`);
      }
      if (
        path.startsWith(".github/actions/") ||
        (path.startsWith(".github/workflows/") && /coordinated|release/.test(path))
      ) {
        select(SERVICE_KEYS, `${reason}: release pipeline input`);
      }
    }
  }
  return { affectedServices: SERVICE_KEYS.filter((key) => selected.has(key)), reasons };
}

export function assembleManifest({ selection, imageRecords, baseline, build }) {
  const services = {};
  const affected = new Set(selection.affectedServices);
  for (const service of SERVICE_KEYS) {
    if (affected.has(service)) {
      const image = imageRecords[service];
      if (!image) fail(`missing image record for ${service}`);
      exactKeys(
        image,
        ["service", "ecrRepository", "digest", "imageSourceSha"],
        `image record ${service}`,
      );
      if (image.service !== service) fail(`image record service mismatch for ${service}`);
      services[service] = {
        ecrRepository: image.ecrRepository,
        digest: image.digest,
        imageSourceSha: image.imageSourceSha,
      };
    } else {
      if (!baseline?.services?.[service]) {
        fail(`baseline does not contain unchanged service ${service}`);
      }
      services[service] = baseline.services[service];
    }
  }
  const value = {
    schemaVersion: 1,
    manifestId: manifestId(selection.targetSha, build.runId, build.runAttempt),
    repository: REPOSITORY,
    source: { sha: selection.targetSha, branch: "main" },
    build: {
      workflowName: BUILD_WORKFLOW_NAME,
      workflowPath: BUILD_WORKFLOW_PATH,
      runId: build.runId,
      runAttempt: build.runAttempt,
      event: build.event,
    },
    previousManifestId: baseline?.manifestId ?? null,
    previousSourceSha: baseline?.source?.sha ?? null,
    compatibility: {
      mode: "ordinary",
      apiBackwardCompatible: true,
      frontendBackwardCompatible: true,
    },
    barriers: selection.barriers,
    services,
  };
  return validateManifest(value);
}
