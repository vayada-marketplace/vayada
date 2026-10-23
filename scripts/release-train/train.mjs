// The release train on GitHub (VAY-2311): the app half of what the coordinator's release-held.sh
// and release.sh did on a laptop. It opens this run's merge queue hold, settles main, prechecks
// the settled sha, waits for its coordinated publication, closes the hold, and hands the release
// identity to the platform's "Release train deploy" workflow, which admits, deploys and verifies.
//
// The hold closes as soon as the release is published: since VAY-2312 (vayada-platform #633) a
// later merge's automatic event no longer accepts an unadmitted release, so it cannot turn this
// release's deploy into a stale skip. Before #633 is live, run with keep_hold and close the hold by
// hand after the deploy is verified.
//
// A dry run changes nothing: no hold, no PR Checks dispatch, no waiting; it reads the current state
// and sends the platform a dry-run event.
import { mkdtempSync, appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHub } from "./github.mjs";
import {
  branchSha,
  closeHold,
  entriesThatCanMerge,
  holdMarker,
  openHold,
  queueEntries,
  settle,
} from "./hold.mjs";
import { precheck } from "./precheck.mjs";
import { downloadArtifact, readPublication, waitForPublication } from "./publish.mjs";

export const PLATFORM_EVENT = "release-train";

export function readOptions(env) {
  const flag = (name, fallback) => {
    const value = (env[name] ?? "").trim();
    if (value === "") return fallback;
    if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
    return value === "true";
  };
  const sha = (env.TRAIN_SHA ?? "").trim();
  if (sha && !/^[0-9a-f]{40}$/.test(sha))
    throw new Error("TRAIN_SHA must be a full 40-character sha");
  const admission = (env.TRAIN_ADMISSION ?? "pr").trim();
  if (!["pr", "push"].includes(admission)) throw new Error("TRAIN_ADMISSION must be pr or push");
  const summary = (env.TRAIN_SUMMARY ?? "").trim();
  if (!summary) throw new Error("TRAIN_SUMMARY is required");
  return {
    repo: env.GITHUB_REPOSITORY,
    platformRepo: env.TRAIN_PLATFORM_REPO || "vayada-marketplace/vayada-platform",
    runId: env.GITHUB_RUN_ID,
    runUrl: `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    ref: env.GITHUB_REF,
    sha: sha || null,
    summary,
    dryRun: flag("TRAIN_DRY_RUN", true),
    keepHold: flag("TRAIN_KEEP_HOLD", false),
    admission,
  };
}

// The repository_dispatch payload: GitHub allows at most 10 top-level client_payload keys.
export function platformPayload(options, sha, identity) {
  return {
    schemaVersion: 1,
    release: {
      sha,
      artifactId: identity.artifactId,
      manifestId: identity.manifestId,
      manifestSha256: identity.manifestSha256,
      publishedRecordSha256: identity.publishedRecordSha256,
    },
    summary: options.summary,
    dryRun: options.dryRun,
    admission: options.admission,
    appRun: { id: Number(options.runId), url: options.runUrl },
  };
}

export function renderSummary(options, steps, identity) {
  const lines = [
    `## Release train${options.dryRun ? " (dry run)" : ""}`,
    "",
    `${options.summary}`,
    "",
    "| Step | Result | Detail |",
    "| --- | --- | --- |",
    ...steps.map(
      (step) => `| ${step.name} | ${step.status} | ${step.detail.replaceAll("|", "\\|")} |`,
    ),
  ];
  if (identity) {
    lines.push(
      "",
      "### Release identity",
      "",
      `- sha: \`${identity.sha}\``,
      `- published artifact: \`${identity.artifactId}\` (${identity.artifactName})`,
      `- manifest sha256: \`${identity.manifestSha256}\``,
      `- published record sha256: \`${identity.publishedRecordSha256}\``,
      "",
      "| Service | Digest |",
      "| --- | --- |",
      ...Object.entries(identity.digests).map(([key, digest]) => `| ${key} | \`${digest}\` |`),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runTrain(
  options,
  { gh, platform, sleep, now, log, workdir, download = downloadArtifact },
) {
  const steps = [];
  const record = (name, status, detail) => {
    steps.push({ name, status, detail });
    log(`${name}: ${status} - ${detail}`);
  };
  const { repo, dryRun } = options;
  if (!dryRun && options.ref !== "refs/heads/main")
    throw new Error("a real release runs only from main");
  let hold = null;
  let identity = null;
  try {
    if (dryRun) {
      record("hold", "skipped", "dry run: would open a release-train-hold issue");
    } else {
      hold = await openHold(gh, repo, {
        reason: `release train ${options.runId}: ${options.summary}`,
        marker: holdMarker(options.runId),
      });
      record(
        "hold",
        "done",
        `#${hold.number}${hold.reused ? " (reused from an earlier attempt)" : ""} ${hold.url}`,
      );
    }

    let sha;
    if (dryRun) {
      const main = await branchSha(gh, repo);
      const merging = await entriesThatCanMerge(gh, repo, await queueEntries(gh, repo));
      sha = options.sha ?? main;
      record(
        "settle",
        "skipped",
        `dry run: main at ${main.slice(0, 9)}; queue entries that could still merge: ${merging.map((n) => `#${n}`).join(" ") || "none"}`,
      );
    } else {
      sha = await settle(gh, repo, { sleep, now, log });
      if (options.sha && options.sha !== sha)
        throw new Error(
          `main settled at ${sha.slice(0, 9)}, not the requested ${options.sha.slice(0, 9)}`,
        );
      record("settle", "done", `main settled at ${sha}`);
    }

    const check = await precheck(gh, repo, sha, { dispatch: !dryRun, sleep, now, log });
    if (check.status === "failed")
      throw new Error(`precheck: ${check.detail}${check.url ? ` ${check.url}` : ""}`);
    record(
      "precheck",
      check.status === "green" ? "done" : "skipped",
      `${check.detail}${check.url ? ` ${check.url}` : ""}`,
    );

    const { build, publication } = await waitForPublication(gh, repo, sha, {
      wait: !dryRun,
      sleep,
      now,
      log,
    });
    if (!publication) {
      record(
        "publication",
        "missing",
        `dry run: no publication of ${sha.slice(0, 9)} yet (build ${build ? `${build.status} ${build.conclusion ?? ""}` : "not started"})`,
      );
      return { ok: true, steps, identity };
    }
    await download(gh, repo, publication.artifactId, workdir);
    identity = {
      sha,
      artifactId: publication.artifactId,
      artifactName: publication.name,
      ...readPublication(workdir, sha),
    };
    record(
      "publication",
      "done",
      `artifact ${publication.artifactId} (publish run ${publication.runId})`,
    );

    if (!dryRun) {
      const main = await branchSha(gh, repo);
      if (main !== sha) throw new Error(`main moved to ${main.slice(0, 9)} under the hold`);
      if (options.keepHold) {
        record(
          "hold close",
          "skipped",
          `keep_hold: close #${hold.number} after the deploy is verified`,
        );
      } else {
        await closeHold(
          gh,
          repo,
          hold.number,
          `Release ${sha.slice(0, 9)} is published; the platform deploys it (${options.runUrl}). Merging resumes.`,
        );
        record("hold close", "done", `#${hold.number} closed at publish (VAY-2312)`);
        hold = null;
      }
    }

    // A repeated event is harmless: the platform side is idempotent per release.
    await platform.post(`/repos/${options.platformRepo}/dispatches`, {
      event_type: PLATFORM_EVENT,
      client_payload: platformPayload(options, sha, identity),
    });
    record(
      "platform",
      "done",
      `sent ${PLATFORM_EVENT}${dryRun ? " (dry run)" : ""} to ${options.platformRepo}; see its "Release train deploy" run`,
    );
    return { ok: true, steps, identity };
  } catch (error) {
    record("stopped", "failed", error.message);
    if (hold && !options.keepHold) {
      try {
        await closeHold(
          gh,
          repo,
          hold.number,
          `Release train ${options.runUrl} stopped before any deploy: ${error.message}`,
        );
        record("hold close", "done", `#${hold.number} closed: stopped before any deploy`);
      } catch (closeError) {
        record("hold close", "failed", `close #${hold.number} by hand: ${closeError.message}`);
      }
    }
    return { ok: false, steps, identity };
  }
}

async function main() {
  const options = readOptions(process.env);
  const log = (line) => console.log(line);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const gh = createGitHub({ token: process.env.GH_TOKEN, log });
  const platform = createGitHub({ token: process.env.PLATFORM_DISPATCH_TOKEN, log });
  const workdir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "release-train-"));
  const result = await runTrain(options, { gh, platform, sleep, now: Date.now, log, workdir });
  const summary = renderSummary(options, result.steps, result.identity);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else console.log(summary);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
