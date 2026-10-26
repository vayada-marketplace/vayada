// The release precheck (VAY-2245, reuse VAY-2287): PR Checks green on the exact release sha.
// It reuses the merge queue's run when one exists for the sha (main fast-forwards to the commit
// the queue tested, and a queued entry runs every job), else dispatches a full run on main.
// Since VAY-2313 there is no compare against hand-kept test lists: green means every job of the
// run succeeded, and PR Checks' own tests pin that a queue run runs every job, that every
// api_postgres step's only condition is its shard, and the isolated precheck blocks.

const WORKFLOW = "pr-checks.yml";
// The PostgreSQL shards every run must have; the workflow may add more (pms-migrations).
const BASE_PG_LEGS = ["platform", "pms", "pricing", "hotel-setup"];
// Known infrastructure failures, matched only in the failed step's own log section.
const FLAKES =
  /toomanyrequests|Data limit exceeded|Docker pull failed|failed to pull image|NextFontGoogleFontFileReplacer|Failed to fetch font|Failed to fetch `[^`]+` from Google Fonts|npm error code (ECONNRESET|ETIMEDOUT|EAI_AGAIN)|npm error network/;
const RUNNER_LOSS =
  /The runner has received a shutdown signal|lost communication with the server|The hosted runner encountered an error/;

// Why a finished run's jobs are not a green precheck; empty when they are: every job succeeded
// (a skipped job counts against it), enough jobs ran, and every PostgreSQL shard ran on PG16 and
// PG17, as did the setup draft reset suite.
export function greenProblems(jobs, { minJobs = 22 } = {}) {
  const problems = [];
  const bad = jobs.filter((job) => job.conclusion !== "success");
  if (bad.length > 0)
    problems.push(
      `${bad.length} job(s) did not succeed: ${bad.map((job) => `${job.name} (${job.conclusion ?? job.status})`).join(", ")}`,
    );
  if (jobs.length < minJobs)
    problems.push(`only ${jobs.length} jobs ran (expected at least ${minJobs})`);
  const legs = (version) =>
    new Set(
      jobs
        .map((job) =>
          new RegExp(`^TypeScript API PostgreSQL Integration \\(PG${version}, ([a-z-]+)\\)$`).exec(
            job.name,
          ),
        )
        .filter(Boolean)
        .map((match) => match[1]),
    );
  const pg16 = legs(16);
  const pg17 = legs(17);
  for (const leg of new Set([...BASE_PG_LEGS, ...pg16, ...pg17]))
    for (const [version, found] of [
      [16, pg16],
      [17, pg17],
    ])
      if (!found.has(leg)) problems.push(`missing PG${version} ${leg} leg`);
  for (const version of [16, 17])
    if (!jobs.some((job) => job.name === `Setup Draft Reset PostgreSQL ${version} Integration`))
      problems.push(`missing PG${version} setup draft reset`);
  return problems;
}

// The failed run step's own log: from its "##[group]Run" line to its "Process completed" error.
export function failedSection(log) {
  let buffer = "";
  for (const line of log.split("\n")) {
    if (line.includes("##[group]Run ")) buffer = "";
    buffer += `${line}\n`;
    if (line.includes("##[error]Process completed with exit code")) return buffer;
  }
  return null;
}

// Whether one failed job failed only on a known infrastructure flake, and why.
export function classifyFailure({ job, annotations = [], log = null }) {
  if (job.conclusion !== "failure")
    return { infra: false, reason: `${job.name} (${job.conclusion})` };
  const step = job.steps?.find((item) => item.conclusion === "failure")?.name ?? "-";
  if (step === "Initialize containers" || step === "Set up job")
    return { infra: true, reason: `${job.name} (failed at "${step}")` };
  const lost = annotations.map((note) => RUNNER_LOSS.exec(note)).find(Boolean);
  if (lost) return { infra: true, reason: `${job.name} (runner: "${lost[0]}")` };
  if (log === null) return { infra: false, reason: `${job.name} (log unavailable)` };
  const section = failedSection(log.replace(/\x1b\[[0-9;]*m/g, ""));
  if (section === null)
    return { infra: false, reason: `${job.name} (no failed run step in the log, at "${step}")` };
  const flake = FLAKES.exec(section);
  if (flake) return { infra: true, reason: `${job.name} ("${flake[0]}" at "${step}")` };
  // 57P01 teardown race: vitest's only error is the terminated connection, and no test failed.
  const unhandled = section
    .split("Unhandled Error")
    .slice(1)
    .join("Unhandled Error")
    .split(/Test Files /)[0];
  if (
    unhandled.includes("terminating connection due to administrator command") &&
    /Errors +1 error/.test(section) &&
    !/(Tests|Test Files) +[0-9]+ failed/.test(section)
  )
    return {
      infra: true,
      reason: `${job.name} (57P01 teardown race is the only error, no failed test)`,
    };
  return { infra: false, reason: `${job.name} (failed at "${step}")` };
}

async function attemptJobs(gh, repo, run) {
  const result = await gh.get(
    `/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  return result.jobs;
}

// Every failed job of the latest attempt failed on a known flake ("Required Checks" only reports).
async function infraOnly(gh, repo, run, log) {
  const failed = (await attemptJobs(gh, repo, run)).filter(
    (job) => job.name !== "Required Checks" && !["success", "skipped"].includes(job.conclusion),
  );
  if (failed.length === 0) return false;
  let infra = true;
  for (const job of failed) {
    let annotations = [];
    let text = null;
    try {
      annotations = (await gh.get(`/repos/${repo}/check-runs/${job.id}/annotations`)).map(
        (note) => note.message,
      );
    } catch {}
    try {
      text = (await gh.get(`/repos/${repo}/actions/jobs/${job.id}/logs`, { raw: true })).toString(
        "utf8",
      );
    } catch {}
    const verdict = classifyFailure({ job, annotations, log: text });
    log(`  ${verdict.infra ? "infra" : "REAL"}: ${verdict.reason}`);
    infra &&= verdict.infra;
  }
  return infra;
}

// Returns { status: "green" | "failed" | "would-dispatch", url, detail }.
export async function precheck(
  gh,
  repo,
  sha,
  {
    ref = "main",
    reuse = true,
    reuseMaxMin = 360,
    waitMin = 75,
    minJobs = 22,
    dispatch = true,
    sleep,
    now,
    log,
  },
) {
  const runUrl = (run) => run.html_url ?? `https://github.com/${repo}/actions/runs/${run.id}`;
  const green = async (run) => {
    const problems = greenProblems(await attemptJobs(gh, repo, run), { minJobs });
    for (const problem of problems) log(`  ${problem}`);
    return problems.length === 0;
  };

  if (reuse) {
    const { workflow_runs: runs } = await gh.get(
      `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=merge_group&head_sha=${sha}&status=success&per_page=20`,
    );
    const candidate = runs
      .filter((run) => run.conclusion === "success" && run.head_sha === sha)
      .sort((a, b) => Date.parse(a.run_started_at) - Date.parse(b.run_started_at))
      .at(-1);
    if (candidate) {
      // run_started_at: when the latest attempt started (updated_at moves with later edits).
      const age = Math.round((now() - Date.parse(candidate.run_started_at)) / 60_000);
      if (age > reuseMaxMin) {
        log(
          `newest green merge queue run ${runUrl(candidate)} started ${age} min ago (limit ${reuseMaxMin})`,
        );
      } else {
        log(
          `reuse: merge queue run ${runUrl(candidate)} (attempt ${candidate.run_attempt}, started ${age} min ago)`,
        );
        if (await green(candidate))
          return {
            status: "green",
            url: runUrl(candidate),
            detail: "merge queue run reused, nothing dispatched",
          };
        log("  not reusable");
      }
    }
  }
  if (!dispatch)
    return { status: "would-dispatch", url: null, detail: "no reusable merge queue run" };

  // workflow_dispatch runs the branch tip only, so the sha must be the tip (held and settled).
  const tip = (await gh.get(`/repos/${repo}/commits/${ref}`)).sha;
  if (tip !== sha)
    return {
      status: "failed",
      url: null,
      detail: `${ref} is at ${tip.slice(0, 9)}, not ${sha.slice(0, 9)}`,
    };
  const since = new Date(now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  // Sent once: a retried dispatch could start a second run, and the newer one cancels the first.
  await gh.post(
    `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
    { ref },
    { retry: false },
  );
  let run = null;
  for (let poll = 0; poll < 30 && !run; poll += 1) {
    await sleep(10_000);
    const { workflow_runs: runs } = await gh.get(
      `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=${ref}&head_sha=${sha}&created=%3E%3D${since}&per_page=10`,
    );
    run = runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1) ?? null;
  }
  if (!run)
    return {
      status: "failed",
      url: null,
      detail: `no dispatched PR Checks run found for ${sha.slice(0, 9)}`,
    };
  log(`run ${runUrl(run)}`);

  let reran = false;
  for (;;) {
    const deadline = now() + waitMin * 60_000;
    for (;;) {
      run = await gh.get(`/repos/${repo}/actions/runs/${run.id}`);
      if (run.status === "completed") break;
      if (now() >= deadline)
        return { status: "failed", url: runUrl(run), detail: `not finished after ${waitMin} min` };
      await sleep(30_000);
    }
    log(`attempt ${run.run_attempt}: ${run.conclusion}`);
    if (run.conclusion === "success") {
      if (await green(run)) return { status: "green", url: runUrl(run), detail: "dispatched run" };
      return {
        status: "failed",
        url: runUrl(run),
        detail: "success reported, but not every job ran green",
      };
    }
    if (reran)
      return { status: "failed", url: runUrl(run), detail: "failed again after one rerun" };
    if (!(await infraOnly(gh, repo, run, log)))
      return {
        status: "failed",
        url: runUrl(run),
        detail: "failed (not only known infrastructure flakes)",
      };
    const before = run.run_attempt;
    await gh.post(`/repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, {}, { retry: false });
    for (let poll = 0; poll < 12 && run.run_attempt <= before; poll += 1) {
      await sleep(15_000);
      run = await gh.get(`/repos/${repo}/actions/runs/${run.id}`);
    }
    if (run.run_attempt <= before)
      return { status: "failed", url: runUrl(run), detail: "could not rerun the failed jobs" };
    log(`rerunning the failed jobs once (attempt ${run.run_attempt})`);
    reran = true;
  }
}
