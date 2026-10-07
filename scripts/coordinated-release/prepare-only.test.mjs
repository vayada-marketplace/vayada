import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const build = readFileSync(
  new URL("../../.github/workflows/build-coordinated-release.yml", import.meta.url),
  "utf8",
);
const publish = readFileSync(
  new URL("../../.github/workflows/publish-coordinated-release.yml", import.meta.url),
  "utf8",
);
const step = build
  .split("      - name: Build and push immutable service image\n")[1]
  .split("      - name:")[0]
  .split("        run: |\n")[1]
  .split("\n")
  .map((line) => line.slice(10))
  .join("\n");

test("preparation builds never write legacy tags and never overwrite an existing preparation", () => {
  const source = "1".repeat(40);
  for (const [prepare, result] of [
    [true, "missing"],
    [true, "exists"],
    [true, "denied"],
    [false, "missing"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "vayada-prepare-test-"));
    try {
      const run = spawnSync(
        "bash",
        [
          "-c",
          `
        aws() {
          case "$LOOKUP" in
            exists) return 0 ;;
            missing) echo ImageNotFoundException >&2; return 1 ;;
            denied) echo AccessDenied >&2; return 1 ;;
          esac
        }
        docker() { printf '%s\\n' "$@"; }
        ${step}
      `,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            LOOKUP: result,
            PREPARE_ONLY: String(prepare),
            AWS_ACCOUNT_ID: "123456789012",
            AWS_REGION: "eu-west-1",
            ECR_REPOSITORY: "api",
            SERVICE: "next-target-backend",
            APP_PATH: "apps/api",
            GITHUB_SHA: source,
            IMAGE_TAG: `${prepare ? "next-prepare-" : "next-"}${source}`,
          },
        },
      );
      assert.equal(run.status, result === "denied" ? 1 : 0, run.stderr);
      if (prepare && result !== "missing") {
        assert.equal(run.stdout, "");
      } else if (prepare) {
        assert.match(run.stdout, /:next-prepare-/);
        assert.ok(!run.stdout.includes(":next-latest"));
        assert.ok(!run.stdout.includes(`:next-${source}`));
      } else {
        assert.match(run.stdout, /:next-latest/);
        assert.ok(run.stdout.includes(`:next-${source}`));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("preparation remains manual, main-only and cannot dispatch even with activation enabled", () => {
  assert.ok(build.includes('test "$SOURCE_REF" = refs/heads/main'));
  assert.ok(build.includes("github.event_name == 'workflow_dispatch' && inputs.prepare_only"));
  assert.ok(build.includes('echo "$PREPARE_ONLY" > release-work/candidate/prepare-only'));
  assert.ok(publish.includes('prepare_only="$(cat release-work/content/prepare-only)"'));
  assert.ok(publish.includes('true) test "$SOURCE_EVENT" = workflow_dispatch'));
  assert.match(
    publish,
    /Dispatch immutable release identity to platform\n\s+if: \$\{\{ vars.COORDINATED_RELEASES_ENABLED == 'true' && steps.prepare.outputs.prepare-only != 'true' \}\}/,
  );
});
