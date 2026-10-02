import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/deploy-next-api.yml", import.meta.url), "utf8"),
);
const steps = workflow.jobs["build-and-push"].steps;
const guard = steps.find((step) => step.id === "source");
const dispatch = steps.find((step) => step.name === "Dispatch deploy to platform");
assert.equal(dispatch.if, "${{ !inputs.publish_private_creation_only }}");
const tags = steps.find((step) => step.id === "image").with.tags;
assert(tags.includes("!inputs.publish_private_creation_only && format("));
assert(tags.includes("'hotel-setup-creation' || 'next'"));
assert.equal(workflow.on.workflow_dispatch.inputs.publish_private_creation_only.default, false);
const directory = mkdtempSync(join(tmpdir(), "vay965-image-guard-"));
try {
  for (const [privateOnly, source, allowed] of [
    ["true", "a".repeat(40), true],
    ["false", "", true],
    ["", "", true],
    ["false", "a".repeat(40), false],
    ["true", "main", false],
    ["true", "$(touch unsafe)", false],
    ["true", "a".repeat(39), false],
  ]) {
    const output = join(directory, `${privateOnly}-${source.length}-${allowed}`);
    const result = spawnSync("bash", ["-e", "-c", guard.run], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PRIVATE_ONLY: privateOnly,
        SOURCE_SHA: source,
        GITHUB_SHA: "b".repeat(40),
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status === 0, allowed);
    if (allowed) assert.equal(readFileSync(output, "utf8"), `sha=${source || "b".repeat(40)}\n`);
  }
} finally {
  rmSync(directory, { recursive: true });
}
console.log("Private image publication guard passed");
