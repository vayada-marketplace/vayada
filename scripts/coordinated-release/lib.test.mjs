import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SERVICE_KEYS,
  assembleManifest,
  parseNameStatus,
  selectAffectedServices,
  validateManifest,
  validatePublishedRecord,
  workspaceSnapshot,
} from "./lib.mjs";

const ROOT = new URL("../../", import.meta.url);
const SERVICES = JSON.parse(
  readFileSync(new URL("deployment/coordinated-release/services.json", ROOT)),
);

function snapshot(overrides = {}) {
  const entries = [
    ["apps/api", "vayada-api", ["@vayada/backend-auth"]],
    ["apps/pms-web", "pms", ["@vayada/domain-booking"]],
    ["apps/booking-web", "booking-web", ["@vayada/domain-hotels"]],
    ["apps/booking-admin", "booking-admin", ["@vayada/domain-booking"]],
    [
      "apps/marketplace-web",
      "marketplace",
      ["@vayada/domain-marketplace", "@vayada/domain-hotels"],
    ],
    ["apps/vayada-admin", "admin", ["@vayada/domain-hotels"]],
    ["packages/backend-auth", "@vayada/backend-auth", []],
    ["packages/backend-migration", "@vayada/backend-migration", ["@vayada/domain-booking"]],
    ["packages/domain-booking", "@vayada/domain-booking", ["@vayada/domain-hotels"]],
    ["packages/domain-hotels", "@vayada/domain-hotels", []],
    ["packages/domain-marketplace", "@vayada/domain-marketplace", []],
  ].map(([path, name, dependencies]) => ({
    path,
    packageJson: {
      name,
      dependencies: Object.fromEntries(
        (overrides[path] ?? dependencies).map((dependency) => [dependency, "*"]),
      ),
    },
  }));
  return workspaceSnapshot(entries);
}

function select(changes, options = {}) {
  return selectAffectedServices({
    changes,
    oldSnapshot: options.oldSnapshot ?? snapshot(),
    newSnapshot: options.newSnapshot ?? snapshot(),
    serviceConfig: SERVICES,
    baselineAvailable: options.baselineAvailable ?? true,
  }).affectedServices;
}

test("valid shared manifest fixture is executable on the producer", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("engineering/deployment-contract/fixtures/manifest-v1.valid.json", ROOT)),
  );
  assert.equal(validateManifest(manifest), manifest);
});

test("untrusted repository fixture is rejected", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "engineering/deployment-contract/fixtures/manifest-v1.invalid-wrong-repository.json",
        ROOT,
      ),
    ),
  );
  assert.throws(() => validateManifest(manifest), /repository is not trusted/);
});

test("valid shared published record fixture is executable on the producer", () => {
  const record = JSON.parse(
    readFileSync(
      new URL("engineering/deployment-contract/fixtures/published-record-v1.valid.json", ROOT),
    ),
  );
  assert.equal(validatePublishedRecord(record), record);
});

test("manifest rejects mutable image identity and unknown barrier kinds", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("engineering/deployment-contract/fixtures/manifest-v1.valid.json", ROOT)),
  );
  manifest.services["next-target-backend"].imageTag = "next-latest";
  assert.throws(() => validateManifest(manifest), /keys must be exactly/);
  delete manifest.services["next-target-backend"].imageTag;
  manifest.barriers[0].kind = "automatic-backfill";
  assert.throws(() => validateManifest(manifest), /kind is invalid/);
});

test("published record retention is content-bound to exactly 90 days", () => {
  const record = JSON.parse(
    readFileSync(
      new URL("engineering/deployment-contract/fixtures/published-record-v1.valid.json", ROOT),
    ),
  );
  record.expiresAt = "2026-12-15T06:00:00.000Z";
  assert.throws(() => validatePublishedRecord(record), /exactly 90 days/);
});

test("transitive workspace inputs select every actual consumer", () => {
  assert.deepEqual(select([{ status: "M", paths: ["packages/domain-hotels/src/x.ts"] }]), [
    "next-target-backend",
    "next-pms-frontend",
    "next-booking-frontend",
    "next-booking-admin",
    "next-marketplace-frontend",
    "next-marketplace-admin",
  ]);
});

test("old and new dependency graphs are both considered", () => {
  const oldSnapshot = snapshot();
  const newSnapshot = snapshot({ "apps/pms-web": [] });
  assert.ok(
    select([{ status: "M", paths: ["packages/domain-hotels/package.json"] }], {
      oldSnapshot,
      newSnapshot,
    }).includes("next-pms-frontend"),
  );

  const addedSnapshot = snapshot({
    "apps/marketplace-web": ["@vayada/domain-marketplace", "@vayada/domain-hotels"],
  });
  assert.ok(
    select([{ status: "M", paths: ["packages/domain-hotels/package.json"] }], {
      oldSnapshot,
      newSnapshot: addedSnapshot,
    }).includes("next-marketplace-frontend"),
  );
});

test("renamed and deleted paths remain build inputs", () => {
  const changes = parseNameStatus(
    "R100\tpackages/domain-hotels/src/old.ts\tpackages/domain-hotels/src/new.ts\nD\tapps/api/src/removed.ts\n",
  );
  const selected = select(changes);
  assert.ok(selected.includes("next-target-backend"));
  assert.ok(selected.includes("next-booking-frontend"));
});

test("root lock, config, Docker ignore, and release workflow select all services", () => {
  for (const path of [
    "package-lock.json",
    "package.json",
    "tsconfig.base.json",
    ".dockerignore",
    ".github/workflows/build-coordinated-release.yml",
    "scripts/coordinated-release/plan.mjs",
  ]) {
    assert.deepEqual(select([{ status: "M", paths: [path] }]), SERVICE_KEYS);
  }
});

test("API migrations, startup, and copied runtime fixtures select the API", () => {
  for (const path of [
    "packages/backend-migration/migrations/9999_example.sql",
    "scripts/start-next-api.sh",
    "scripts/c1-rehearsal-replay-fixtures.mjs",
    "engineering/fixtures/c1-staging-rehearsal-replay/manifest.json",
  ]) {
    assert.deepEqual(select([{ status: "M", paths: [path] }]), ["next-target-backend"]);
  }
});

test("unknown workspace inputs fail conservatively by selecting all services", () => {
  assert.deepEqual(
    select([{ status: "A", paths: ["packages/new-build-input/file.ts"] }]),
    SERVICE_KEYS,
  );
});

test("missing baseline triggers a complete rebuild", () => {
  assert.deepEqual(select([], { baselineAvailable: false }), SERVICE_KEYS);
});

test("assembly carries unchanged images into an exact six-service manifest", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("engineering/deployment-contract/fixtures/manifest-v1.valid.json", ROOT)),
  );
  const sourceSha = "2".repeat(40);
  const imageRecords = {
    "next-target-backend": {
      service: "next-target-backend",
      ecrRepository: "vayada-next-api",
      digest: `sha256:${"1".repeat(64)}`,
      imageSourceSha: sourceSha,
    },
  };
  const manifest = assembleManifest({
    selection: {
      targetSha: sourceSha,
      affectedServices: ["next-target-backend"],
      barriers: baseline.barriers,
    },
    imageRecords,
    baseline,
    build: { runId: 50001, runAttempt: 1, event: "push" },
  });
  assert.deepEqual(Object.keys(manifest.services), SERVICE_KEYS);
  assert.equal(manifest.services["next-target-backend"].imageSourceSha, sourceSha);
  assert.deepEqual(
    manifest.services["next-booking-frontend"],
    baseline.services["next-booking-frontend"],
  );
});
