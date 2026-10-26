import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = new URL("../../", import.meta.url);
const SCRIPT = fileURLToPath(new URL("dispatch-payload.mjs", import.meta.url));
const MANIFEST = fileURLToPath(
  new URL("engineering/deployment-contract/fixtures/manifest-v1.valid.json", ROOT),
);
const PUBLISHED_RECORD = fileURLToPath(
  new URL("engineering/deployment-contract/fixtures/published-record-v1.valid.json", ROOT),
);

test("dispatch uses a compact envelope with the exact published release identity", () => {
  const payload = JSON.parse(
    execFileSync(process.execPath, [SCRIPT, MANIFEST, PUBLISHED_RECORD, "123456"], {
      encoding: "utf8",
    }),
  );

  assert.equal(payload.event_type, "coordinated-release-published");
  assert.ok(
    Object.keys(payload.client_payload).length <= 10,
    "GitHub repository_dispatch accepts at most 10 top-level client_payload properties",
  );
  assert.deepEqual(payload.client_payload, {
    schemaVersion: 2,
    publishedArtifactId: 123456,
    release: {
      manifestId: "vayada-release/v1/1111111111111111111111111111111111111111/41001/2",
      manifestSha256: "d4b12732362a7022b5d9778b0cecf8308c3a183f7c626da0574fb52edd5741d6",
      publishedRecordSha256: "10cc9744f41be016b7127aa1284f0d113c0307e99dd634783efd924f8db3bf61",
      sourceSha: "1111111111111111111111111111111111111111",
      repository: "vayada-marketplace/vayada",
      build: {
        workflowName: "Build coordinated next release",
        workflowPath: ".github/workflows/build-coordinated-release.yml",
        runId: 41001,
        runAttempt: 2,
      },
      publishedArtifactName:
        "next-release-published-v1-1111111111111111111111111111111111111111-41001-2",
      publisher: {
        runId: 42001,
        runAttempt: 1,
      },
      idempotencyKey: "vayada-release/v1/1111111111111111111111111111111111111111/41001/2",
    },
  });
});
