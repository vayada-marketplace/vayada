import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const guards = [
  ["api", "publish_private_creation_only", "private_creation_source_sha", "hotel-setup-creation"],
  [
    "marketplace-web",
    "publish_private_setup_only",
    "private_setup_source_sha",
    "hotel-setup-frontend",
  ],
].map(([name, flag, source, tag]) => {
  const workflow = parse(
    readFileSync(new URL(`../.github/workflows/deploy-next-${name}.yml`, import.meta.url), "utf8"),
  );
  const steps = workflow.jobs["build-and-push"].steps;
  const guard = steps.find((step) => step.id === "source");
  const image = steps.find((step) => step.id === "image");
  const checkout = steps.find((step) => step.name === "Checkout code");
  const dispatch = steps.find((step) => step.name === "Dispatch deploy to platform");
  assert.equal(guard.env.PRIVATE_ONLY, "${{ inputs." + flag + " }}");
  assert.equal(guard.env.SOURCE_SHA, "${{ inputs." + source + " }}");
  assert(steps.indexOf(guard) < steps.indexOf(checkout));
  assert(
    steps.indexOf(guard) < steps.findIndex((step) => step.name === "Configure AWS credentials"),
  );
  assert.equal(checkout.with.ref, "${{ steps.source.outputs.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(dispatch.if, "${{ !inputs." + flag + " }}");
  assert.equal(dispatch.with["event-type"], "app-image-published");
  assert.equal(JSON.parse(dispatch.with["client-payload"]).image_sha, "next-${{ github.sha }}");
  assert.equal(
    workflow.jobs["build-and-push"].if,
    "${{ github.event_name == 'workflow_dispatch' || vars.COORDINATED_RELEASES_ENABLED != 'true' }}",
  );
  assert(image.with.tags.includes(`'${tag}' || 'next'`));
  assert(image.with.tags.includes(`!inputs.${flag} && format(`));
  assert.equal(image.with.tags.trim().split("\n").length, 2);
  assert.equal(workflow.on.workflow_dispatch.inputs[flag].default, false);
  if (name === "api")
    assert(
      image.with["build-args"].includes("APPLICATION_RELEASE=${{ steps.source.outputs.sha }}"),
    );
  else
    assert.equal(
      image.with.labels.trim(),
      "org.opencontainers.image.revision=${{ steps.source.outputs.sha }}",
    );
  return guard;
});

const publisher = parse(
  readFileSync(
    new URL("../.github/workflows/publish-hotel-setup-bootstrap.yml", import.meta.url),
    "utf8",
  ),
);
assert.equal(publisher.on.workflow_dispatch.inputs.verify_automatic.default, false);
assert.equal(publisher.jobs.publish.if, "github.ref == 'refs/heads/main'");
const proof = publisher.jobs.publish.steps.find(
  (step) => step.name === "Verify both immutable source revisions and fixed CLI roots",
);
assert.equal(proof.env.VERIFY_AUTOMATIC, "${{ inputs.verify_automatic }}");
const directory = mkdtempSync(join(tmpdir(), "vay965-image-publication-"));
const sha = "a".repeat(40);
try {
  const defaults = {
    PRIVATE_ONLY: "true",
    SOURCE_SHA: "b".repeat(40),
    GITHUB_SHA: sha,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "vayada-marketplace/vayada",
  };
  const cases = [
    [{}, true],
    [{ SOURCE_SHA: "" }, true],
    [{ PRIVATE_ONLY: "false", SOURCE_SHA: "" }, true],
    [{ PRIVATE_ONLY: "", SOURCE_SHA: "", GITHUB_EVENT_NAME: "push" }, true],
    [{ PRIVATE_ONLY: "false", SOURCE_SHA: "", GITHUB_REF: "refs/heads/feature" }, true],
    [{ PRIVATE_ONLY: "false" }, false],
    [{ PRIVATE_ONLY: "unexpected" }, false],
    [{ GITHUB_REF: "refs/heads/feature" }, false],
    [{ GITHUB_REF: "refs/tags/main" }, false],
    [{ GITHUB_EVENT_NAME: "push" }, false],
    [{ GITHUB_REPOSITORY: "foreign/fork" }, false],
    [{ SOURCE_SHA: "main" }, false],
    [{ SOURCE_SHA: "$(touch unsafe)" }, false],
    [{ SOURCE_SHA: "b".repeat(39) }, false],
    [{ SOURCE_SHA: "B".repeat(40) }, false],
    [{ SOURCE_SHA: "", GITHUB_SHA: "invalid" }, false],
  ];
  for (const [publisherIndex, guard] of guards.entries())
    for (const [index, [changes, allowed]] of cases.entries()) {
      const env = { ...defaults, ...changes };
      const output = join(directory, `source-${publisherIndex}-${index}`);
      const result = spawnSync("bash", ["-c", guard.run], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, ...env, GITHUB_OUTPUT: output },
      });
      assert.equal(
        result.status === 0,
        allowed,
        `Publisher ${publisherIndex} source admission case ${index}`,
      );
      if (allowed)
        assert.equal(readFileSync(output, "utf8"), `sha=${env.SOURCE_SHA || env.GITHUB_SHA}\n`);
    }
  assert.throws(() => readFileSync(join(directory, "unsafe")));

  mkdirSync(join(directory, "engineering"));
  const repository = "269416271598.dkr.ecr.eu-west-1.amazonaws.com/vayada-next-api@";
  const primary = repository + "sha256:" + "a".repeat(64);
  const rollback = repository + "sha256:" + "b".repeat(64);
  writeFileSync(
    join(directory, "engineering/hotel-setup-bootstrap-image-manifest.json"),
    JSON.stringify({
      primary: { image: primary, source: sha },
      rollback: { image: rollback, source: sha },
    }),
  );
  // No Docker daemon or cloud access: execute the actual workflow shell against a bounded stub.
  const docker = join(directory, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == inspect ]]; then printf '%s' "$IMAGE_SOURCE"; fi
if [[ "$1" == run ]]; then
  printf '%s\\n' "$*" >> "$DOCKER_LOG"
  [[ "\${!#}" != "\${MISSING_CLI:-}" ]] || exit 9
fi
`,
  );
  chmodSync(docker, 0o700);
  const cliRoot = "/app/apps/api/dist/cli/";
  for (const [index, [automatic, missing, source, allowed]] of [
    ["false", "", sha, true],
    ["true", "", sha, true],
    ["true", cliRoot + "hotelSetupAutomaticProvisioning.js", sha, false],
    ["true", cliRoot + "hotelSetupCreationPreflight.js", sha, false],
    ["true", cliRoot + "hotelSetupPropertyPreflight.js", sha, false],
    ["true", "", "b".repeat(40), false],
  ].entries()) {
    const log = join(directory, `docker-${index}`);
    const result = spawnSync("bash", ["-c", proof.run], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        VERIFY_AUTOMATIC: automatic,
        IMAGE_SOURCE: source,
        MISSING_CLI: missing,
        DOCKER_LOG: log,
      },
    });
    assert.equal(result.status === 0, allowed, `Bundled proof roots case ${index}`);
    if (allowed) {
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls.length, automatic === "true" ? 4 : 2);
      if (automatic === "true") {
        assert(
          calls.some(
            (call) => call.includes(primary) && call.endsWith("hotelSetupAutomaticProvisioning.js"),
          ),
        );
        assert(
          calls.some(
            (call) => call.includes(rollback) && call.endsWith("hotelSetupCreationPreflight.js"),
          ),
        );
        assert(
          calls.some(
            (call) => call.includes(rollback) && call.endsWith("hotelSetupPropertyPreflight.js"),
          ),
        );
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true });
}
console.log("Private image publication: 32 source-boundary and 6 bundled-root cases passed");
