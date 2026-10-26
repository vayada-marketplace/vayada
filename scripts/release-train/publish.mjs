// The coordinated build and publication of the release sha: "Build coordinated next release" runs on
// the push to main, then "Publish coordinated next release" (workflow_run) uploads the immutable
// manifest and record as next-release-published-v1-<sha>-<buildRun>-<attempt>.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILD = "Build coordinated next release";
const PUBLISH = "Publish coordinated next release";

export function artifactPrefix(sha) {
  return `next-release-published-v1-${sha}-`;
}

async function runsFor(gh, repo, sha) {
  return (await gh.get(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`)).workflow_runs;
}

// The newest published artifact of the sha. When two merges land seconds apart, a workflow_run
// publish run reports the newer main sha as its head even when it published the older build, so
// the artifact name decides, never the run's head_sha alone (release.sh fix of 2026-10-23).
export async function findPublication(gh, repo, sha) {
  const publishes = (await runsFor(gh, repo, sha)).filter(
    (run) => run.name === PUBLISH && run.status === "completed" && run.conclusion === "success",
  );
  const found = [];
  for (const run of publishes) {
    const { artifacts } = await gh.get(
      `/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=50`,
    );
    for (const artifact of artifacts)
      if (artifact.name.startsWith(artifactPrefix(sha)) && !artifact.expired)
        found.push({
          runId: run.id,
          artifactId: artifact.id,
          name: artifact.name,
          createdAt: artifact.created_at,
        });
  }
  return found.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1) ?? null;
}

// Waits for the build of the sha and its publication; a failed build stops at once.
export async function waitForPublication(
  gh,
  repo,
  sha,
  { waitMin = 45, wait = true, sleep, now, log },
) {
  const deadline = now() + waitMin * 60_000;
  let reported = null;
  for (;;) {
    const build = (await runsFor(gh, repo, sha))
      .filter((run) => run.name === BUILD)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      .at(-1);
    const state = build
      ? `${build.status}${build.conclusion ? ` ${build.conclusion}` : ""}`
      : "not started";
    if (state !== reported) log(`build of ${sha.slice(0, 9)}: ${state}`);
    reported = state;
    if (build?.status === "completed" && build.conclusion !== "success")
      throw new Error(
        `the coordinated build of ${sha.slice(0, 9)} ended ${build.conclusion}: ${build.html_url}`,
      );
    if (build?.conclusion === "success") {
      const publication = await findPublication(gh, repo, sha);
      if (publication) return { build, publication };
    }
    if (!wait) return { build: build ?? null, publication: null };
    if (now() >= deadline)
      throw new Error(`no publication of ${sha.slice(0, 9)} after ${waitMin} min`);
    await sleep(20_000);
  }
}

export async function downloadArtifact(gh, repo, artifactId, directory) {
  const zip = join(directory, "artifact.zip");
  writeFileSync(
    zip,
    await gh.get(`/repos/${repo}/actions/artifacts/${artifactId}/zip`, { raw: true }),
  );
  execFileSync("unzip", ["-o", "-q", zip, "-d", directory]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The release identity the platform deploy takes: the exact manifest and record bytes' hashes.
export function readPublication(directory, sha) {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const recordBytes = readFileSync(join(directory, "published-record.json"));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.source?.sha !== sha)
    throw new Error(`the publication's manifest is for ${manifest.source?.sha}, not ${sha}`);
  return {
    manifest,
    manifestId: manifest.manifestId,
    manifestSha256: sha256(manifestBytes),
    publishedRecordSha256: sha256(recordBytes),
    digests: Object.fromEntries(
      Object.entries(manifest.services).map(([key, image]) => [key, image.digest]),
    ),
  };
}
