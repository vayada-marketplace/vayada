// The merge queue hold of a release (VAY-2241), as the coordinator's hold.sh does it: while an
// open issue carries the release-train-hold label, queued PRs wait in "Required Checks" instead
// of merging. The train opens its own hold (holds stack), settles, and closes it again.
import { HOLD_LABEL } from "../ci/pr-checks.mjs";

const GATE_FILES = new Set([".github/workflows/pr-checks.yml", "scripts/ci/pr-checks.mjs"]);

// The hold issue of one train run carries this line, so a rerun finds it instead of opening another.
export function holdMarker(runId) {
  return `release-train-run: ${runId}`;
}

export async function openHolds(gh, repo) {
  const issues = await gh.get(`/repos/${repo}/issues?state=open&labels=${HOLD_LABEL}&per_page=100`);
  return issues.filter((issue) => !issue.pull_request);
}

// Opens this run's hold, or returns it when a previous attempt already opened it. The create is
// sent once: a retried POST after a lost reply would stack a second hold.
export async function openHold(
  gh,
  repo,
  {
    reason,
    marker,
    now = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    findPolls = 6,
  },
) {
  const existing = (await openHolds(gh, repo)).find((issue) => issue.body?.includes(marker));
  if (existing) return { number: existing.number, url: existing.html_url, reused: true };
  const body = [
    "Merges to main are paused while this issue is open (VAY-2241). Queued PRs keep running their",
    "checks and wait in Required Checks for up to 120 min.",
    "",
    `Reason: ${reason}`,
    `Opened: ${now().toISOString()}`,
    marker,
    "",
    "Close this issue to resume merging.",
  ].join("\n");
  try {
    const issue = await gh.post(
      `/repos/${repo}/issues`,
      { title: `Merge queue hold: ${reason}`, body, labels: [HOLD_LABEL] },
      { retry: false },
    );
    // GitHub drops labels a token may not set; without the label the issue holds nothing.
    if (!issue.labels?.some((label) => (label.name ?? label) === HOLD_LABEL))
      await gh.post(`/repos/${repo}/issues/${issue.number}/labels`, { labels: [HOLD_LABEL] });
    return { number: issue.number, url: issue.html_url, reused: false };
  } catch (error) {
    // The issue may exist even though the reply was lost, and the labelled list shows a new issue
    // only after a few seconds: look for a minute before giving up.
    for (let poll = 0; poll < findPolls; poll += 1) {
      await sleep(10_000);
      const created = (await openHolds(gh, repo).catch(() => [])).find((issue) =>
        issue.body?.includes(marker),
      );
      if (created) return { number: created.number, url: created.html_url, reused: true };
    }
    throw error;
  }
}

export async function closeHold(gh, repo, number, note) {
  await gh.post(`/repos/${repo}/issues/${number}/comments`, { body: note });
  await gh.patch(`/repos/${repo}/issues/${number}`, { state: "closed" });
}

// Queue entries sorted by position; throws when the branch has no merge queue.
export async function queueEntries(gh, repo, branch = "main") {
  const [owner, name] = repo.split("/");
  const data = await gh.graphql(
    `query($owner: String!, $name: String!, $branch: String!) {
      repository(owner: $owner, name: $name) {
        mergeQueue(branch: $branch) {
          entries(first: 100) {
            nodes { position state headCommit { oid } pullRequest { number title } }
          }
        }
      }
    }`,
    { owner, name, branch },
  );
  const queue = data?.repository?.mergeQueue;
  if (!queue) throw new Error(`${branch} has no merge queue`);
  return [...queue.entries.nodes].sort((a, b) => a.position - b.position);
}

// Queued PRs that edit the hold gate run their own copy of it, so a hold cannot stop them.
export async function gateEditors(gh, repo, entries) {
  const editors = [];
  for (const entry of entries) {
    const files = await gh.get(
      `/repos/${repo}/pulls/${entry.pullRequest.number}/files?per_page=100`,
    );
    if (files.some((file) => GATE_FILES.has(file.filename))) editors.push(entry.pullRequest.number);
  }
  return editors;
}

async function gatePassed(gh, repo, sha) {
  const result = await gh.get(
    `/repos/${repo}/commits/${sha}/check-runs?check_name=Required%20Checks&per_page=20`,
  );
  return result.check_runs.some(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
}

// Entries that can still merge despite the hold: from the front of the queue, every entry that is
// MERGEABLE/LOCKED or whose "Required Checks" already passed (it read "no hold" just before the
// hold opened). The first entry still waiting at the gate blocks everything behind it.
export async function entriesThatCanMerge(gh, repo, entries) {
  const merging = [];
  for (const entry of entries) {
    const ready =
      entry.state === "MERGEABLE" ||
      entry.state === "LOCKED" ||
      (await gatePassed(gh, repo, entry.headCommit.oid));
    if (!ready) break;
    merging.push(entry.pullRequest.number);
  }
  return merging;
}

class SettleStop extends Error {}

export async function branchSha(gh, repo, branch = "main") {
  return (await gh.get(`/repos/${repo}/commits/${branch}`)).sha;
}

export async function holdIsOpen(gh, repo, number) {
  const issue = await gh.get(`/repos/${repo}/issues/${number}`);
  return (
    issue.state === "open" && issue.labels?.some((label) => (label.name ?? label) === HOLD_LABEL)
  );
}

// Waits until this run's hold `hold` (an issue number) pauses the queue and the queue settled: no
// entry can still merge and main stayed at one sha for two reads a minute apart. Returns that sha:
// the release sha nothing can move while held.
//
// The hold is read by number: GitHub's labelled-issue list lags a new issue by seconds (the first
// real run, 2026-10-23, read it 0.3 s after opening and found nothing). The merge queue's gate
// reads that list, so the hold pauses merging only once the list shows it; the two-minute floor
// counts from then, for entries whose Required Checks read "no hold" just before.
export async function settle(
  gh,
  repo,
  {
    hold,
    sleep,
    now,
    log,
    pollMs = 60_000,
    maxPolls = 90,
    notBeforeMs = 120_000,
    visiblePollMs = 5_000,
    visibleWaitMs = 120_000,
  },
) {
  if (!(await holdIsOpen(gh, repo, hold))) throw new Error(`hold #${hold} is not open`);
  const waitUntil = now() + visibleWaitMs;
  let holds = await openHolds(gh, repo);
  while (!holds.some((issue) => issue.number === hold)) {
    if (now() >= waitUntil)
      throw new Error(
        `hold #${hold} did not appear in the release-train-hold list within ${visibleWaitMs / 1000} s`,
      );
    await sleep(visiblePollMs);
    holds = await openHolds(gh, repo);
  }
  const notBefore =
    Math.max(now(), ...holds.map((issue) => Date.parse(issue.created_at))) + notBeforeMs;
  const editors = await gateEditors(gh, repo, await queueEntries(gh, repo));
  if (editors.length > 0)
    throw new Error(
      `queued PR(s) ${editors.map((n) => `#${n}`).join(" ")} edit the hold gate; dequeue them first`,
    );
  let previous = null;
  let previousClean = false;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    let merging;
    let sha;
    try {
      if (!(await holdIsOpen(gh, repo, hold)))
        throw new SettleStop(`hold #${hold} was closed while settling`);
      merging = await entriesThatCanMerge(gh, repo, await queueEntries(gh, repo));
      sha = await branchSha(gh, repo);
    } catch (error) {
      if (error instanceof SettleStop) throw error;
      // A failed read proves nothing: start the two clean reads over.
      log(`settle read failed (${error.message}); reading again`);
      previousClean = false;
      await sleep(pollMs);
      continue;
    }
    const clean = merging.length === 0;
    if (clean && previousClean && sha === previous && now() >= notBefore) return sha;
    if (!clean)
      log(
        `waiting for queue entries that can still merge: ${merging.map((n) => `#${n}`).join(" ")}`,
      );
    previous = sha;
    previousClean = clean;
    await sleep(pollMs);
  }
  throw new Error(
    `the queue did not settle within ${Math.round((maxPolls * pollMs) / 60_000)} min`,
  );
}
