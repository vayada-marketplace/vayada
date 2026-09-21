import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sha256 } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workflow = readFileSync(
  join(root, ".github/workflows/publish-coordinated-release.yml"),
  "utf8",
);

test("publication window uses GitHub run creation, and dispatch rejects insufficient actual retention", () => {
  const directory = mkdtempSync(join(tmpdir(), "vayada-retention-"));
  try {
    const assignment = workflow.split("\n").find((line) => line.trim().startsWith("published_at="));
    const timestamp = spawnSync(
      "bash",
      [
        "-ec",
        `
      gh() {
        test "$*" = "api repos/owner/repo/actions/runs/123 --jq .created_at" || return 1
        echo 2026-09-20T10:31:42Z
      }
      ${assignment}
      printf '%s' "$published_at"
    `,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "123" },
      },
    );
    assert.equal(timestamp.status, 0, timestamp.stderr);
    assert.equal(timestamp.stdout, "2026-09-20T10:31:42Z");
    const manifest = readFileSync(
      join(root, "engineering/deployment-contract/fixtures/manifest-v1.valid.json"),
    );
    writeFileSync(join(directory, "manifest.json"), manifest);
    writeFileSync(join(directory, "manifest.sha256"), `${sha256(manifest)}  manifest.json\n`);
    mkdirSync(join(directory, "release-work/content"), { recursive: true });
    const recordPath = join(directory, "release-work/content/published-record.json");
    const prepare = spawnSync(
      process.execPath,
      [
        join(root, "scripts/coordinated-release/prepare-publication.mjs"),
        "--manifest",
        join(directory, "manifest.json"),
        "--manifest-hash",
        join(directory, "manifest.sha256"),
        "--candidate-artifact-id",
        "1",
        "--publisher-run-id",
        "123",
        "--publisher-run-attempt",
        "1",
        "--published-at",
        timestamp.stdout,
        "--output",
        recordPath,
        "--hash-output",
        join(directory, "record.sha256"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(JSON.parse(readFileSync(recordPath)).expiresAt, "2026-12-19T10:31:42.000Z");
    assert.match(
      workflow
        .split("      - name: Resolve published artifact identity\n")[1]
        .split("        run: |\n")[0],
      /GH_TOKEN: \$\{\{ github\.token \}\}/,
    );
    const step = workflow
      .split("      - name: Resolve published artifact identity\n")[1]
      .split("      - name:")[0]
      .split("        run: |\n")[1]
      .split("\n")
      .map((line) => line.slice(10))
      .join("\n");
    for (const [expiry, expired, valid] of [
      ["2026-12-19T10:31:42Z", false, true],
      ["2026-12-20T10:31:42Z", false, true],
      ["2026-12-19T10:31:30Z", false, false],
      ["invalid", false, false],
      ["2026-12-19T10:31:42Z", true, false],
    ]) {
      const result = spawnSync("bash", ["-c", `gh() { printf '%s' "$ARTIFACT_JSON"; }\n${step}`], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          MODE: "publish",
          NEW_ARTIFACT_ID: "1",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_OUTPUT: join(directory, "output"),
          ARTIFACT_JSON: JSON.stringify({ expired, expires_at: expiry }),
        },
      });
      assert.equal(result.status === 0, valid, `${expiry}: ${result.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
