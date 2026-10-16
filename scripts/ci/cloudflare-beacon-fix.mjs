// The pull request half of Cloudflare Beacon Drift (VAY-2226). On drift it commits the live
// beacon's hash and a fresh reviewed record to one branch, starts PR Checks there, and opens or
// updates one pull request. A person reviews and merges; merging deploys the landing site. When
// the live file matches the pin again, the branch and its open pull request go away.
//
// Two GitHub rules shape this:
// - Pushes and pull requests made with GITHUB_TOKEN start no workflows, so PR Checks would never
//   run on the branch. workflow_dispatch is the exception: the job dispatches PR Checks on the
//   branch after each push, and its checks land on the branch's head commit.
// - Actions may open pull requests only when the repository allows it (Settings → Actions →
//   "Allow GitHub Actions to create and approve pull requests"). Otherwise the branch stays ready
//   and the issue links the page that opens the pull request; the commit message is its body.
//
// No dependencies, and no imports from the drift script: it passes in everything needed.

export const BOT = "github-actions[bot]";
export const FIX_BRANCH_PREFIX = "automation/cloudflare-beacon-pin-";
export const fixBranch = (base) => `${FIX_BRANCH_PREFIX}${base.replace(/[^\w.-]+/g, "-")}`;

// "2026.10.1" < "2026.10.2"; anything without numbers compares as not older.
export function isOlder(version, than) {
  const parts = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
  const [a, b] = [parts(version), parts(than)];
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

// Rewrites the pin and the comment block above it.
export function pinSource(source, { integrity, version, lastModified }) {
  const pattern = /^(?:\/\/[^\n]*\n)+(const integrity = ")sha384-[^"]+(";)$/m;
  if (!pattern.test(source)) throw new Error("no commented `const integrity` line to update");
  const day = Number.isNaN(Date.parse(lastModified ?? ""))
    ? "date unknown"
    : new Date(lastModified).toISOString().slice(0, 10);
  return source.replace(
    pattern,
    `// Beacon ${version} (Cloudflare, ${day}), pinned via Cloudflare Beacon Drift after review:\n// XHR and sendBeacon only. Vendor changes fail closed.\n$1${integrity}$2`,
  );
}

const report = (body) =>
  body
    .split("\n")
    .filter((line) => !line.startsWith("<!--"))
    .join("\n");

// The pull request text. It is also the commit message, so a pull request opened by hand from
// the branch gets the same description.
export function fixText({ report: drift, branch, repoUrl, override }) {
  const title = `${override ? "[test] " : ""}Landing: pin Cloudflare beacon ${drift.liveVersion} (automated; merging deploys landing)`;
  const runs = `${repoUrl}/actions/workflows/pr-checks.yml?query=${encodeURIComponent(`branch:${branch}`)}`;
  const body = `Prepared by [Cloudflare Beacon Drift](${repoUrl}/actions/workflows/cloudflare-beacon-drift.yml) (VAY-2226). It sets the live beacon's sha384 in \`apps/landing/lib/cloudflareAnalytics.ts\` and regenerates \`scripts/ci/cloudflare-beacon-reviewed.json\`. The alert issue links here.

- **Review before merging** (runbook step 2): the tables below, plus a local diff of the two versions. Close this pull request if the new version uses a transport or endpoint the landing guards do not cover.
- **Merging deploys the landing site** (Deploy Landing → ECR → App Runner). Then check vayada.com (runbook step 5).
- **PR Checks** were started on this branch by the workflow, because pull requests and pushes made with GITHUB_TOKEN start none: [runs](${runs}). They never run Cloudflare's new file (the consent spec uses a stub), so they are not the review.

${report(drift.body)}`;
  return { title, body };
}

export async function prepareFix({
  git,
  base,
  baseSha,
  changes,
  report: drift,
  repoUrl,
  override,
}) {
  // Branch names may hold shell and markdown characters; this one goes into both.
  if (!/^[\w./-]+$/.test(base)) throw new Error(`unexpected branch name ${JSON.stringify(base)}`);
  const branch = fixBranch(base);
  const { title, body } = fixText({ report: drift, branch, repoUrl, override });
  const ref = await git.getRef(branch);
  let stale = !ref;
  for (const [path, content] of Object.entries(changes)) {
    if (!stale) stale = (await git.getFile(path, branch)) !== content;
  }
  let pull = await git.openPull(branch);
  let head = ref?.object?.sha;
  if (stale) {
    head = await git.commit({ baseSha, changes, message: `${title}\n\n${body}` });
    await git.setRef(branch, head, Boolean(ref));
    // Whoever reviews an open pull request must see that its branch now pins a different file.
    if (pull) {
      await git.comment(
        pull.number,
        `The live beacon changed again, so this branch now pins **${drift.liveVersion}** (\`${drift.liveIntegrity}\`). Review this report, not the earlier one:\n\n${report(drift.body)}`,
      );
    }
  }
  if (stale || !(await git.checksRan(branch, head))) await git.dispatch("pr-checks.yml", branch);
  let rejected = null;
  if (!pull) {
    // A pull request someone closed without merging stays closed for this exact commit.
    rejected = await git.closedPull(branch, head);
    if (!rejected) {
      try {
        pull = await git.createPull({ head: branch, base, title, body });
      } catch (error) {
        if (error.status !== 403) throw error; // 403: Actions may not open pull requests here.
      }
    }
  } else if (pull.user?.login === BOT && (pull.title !== title || pull.body !== body)) {
    await git.updatePull(pull.number, { title, body });
  }
  const merge = "Review it, then merge it: **merging deploys the landing site**.";
  const line = pull
    ? `**Prepared fix:** #${pull.number} sets the new pin; PR Checks run on its branch. ${merge}`
    : rejected
      ? `**Prepared fix:** #${rejected.number} was closed without merging. The branch \`${branch}\` is kept: reopen #${rejected.number}, or update the pin by hand (runbook step 3).`
      : `**Prepared fix:** branch \`${branch}\` sets the new pin; PR Checks run on it. GitHub Actions may not open pull requests here, so [open the pull request](${repoUrl}/compare/${base}...${branch}?expand=1) (or \`gh pr create --base ${base} --head ${branch} --fill\`). ${merge}`;
  return { branch, pushed: stale, pull: pull?.number ?? null, line };
}

// The live file matches the pin again (the fix was merged, or Cloudflare went back).
export async function dropFix({ git, base, liveIntegrity }) {
  const branch = fixBranch(base);
  if (!(await git.getRef(branch))) return "no fix branch";
  const pull = await git.openPull(branch);
  if (pull) {
    await git.comment(
      pull.number,
      `The live beacon matches the pin on ${base} again (\`${liveIntegrity}\`), so this update is not needed. Closing.`,
    );
    await git.updatePull(pull.number, { state: "closed" });
  }
  await git.deleteRef(branch);
  return pull ? `closed #${pull.number} and deleted ${branch}` : `deleted ${branch}`;
}
