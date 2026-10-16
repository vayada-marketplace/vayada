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

// Rewrites the pin and the comment block above it, which says what merging confirms.
export function pinSource(source, { integrity, version, lastModified }) {
  const pattern = /^(?:\/\/[^\n]*\n)+(const integrity = ")sha384-[^"]+(";)$/m;
  if (!pattern.test(source)) throw new Error("no commented `const integrity` line to update");
  const day = Number.isNaN(Date.parse(lastModified ?? ""))
    ? "date unknown"
    : new Date(lastModified).toISOString().slice(0, 10);
  return source.replace(
    pattern,
    `// Beacon ${version} (${day}), pinned by Cloudflare Beacon Drift. Merging confirmed the review:\n// XHR and sendBeacon only. Vendor changes fail closed.\n$1${integrity}$2`,
  );
}

// The pull request text. It is also the commit message, so a pull request opened by hand from
// the branch gets the same description.
export function fixText({ report, branch, repoUrl, override }) {
  const title = `${override ? "[test] " : ""}Landing: pin Cloudflare beacon ${report.liveVersion} (automated; merging deploys landing)`;
  const runs = `${repoUrl}/actions/workflows/pr-checks.yml?query=${encodeURIComponent(`branch:${branch}`)}`;
  const body = `Prepared by [Cloudflare Beacon Drift](${repoUrl}/actions/workflows/cloudflare-beacon-drift.yml) (VAY-2226). It sets the live beacon's sha384 in \`apps/landing/lib/cloudflareAnalytics.ts\` and regenerates \`scripts/ci/cloudflare-beacon-reviewed.json\`. The alert issue links here.

- **Review before merging** (runbook step 2): the tables below, plus a local diff of the two versions. Close this pull request if the new version uses a transport or endpoint the landing guards do not cover.
- **Merging deploys the landing site** (Deploy Landing → ECR → App Runner). Then check vayada.com (runbook step 5).
- **PR Checks** were started on this branch by the workflow, because pull requests and pushes made with GITHUB_TOKEN start none: [runs](${runs}).

${report.body
  .split("\n")
  .filter((line) => !line.startsWith("<!--"))
  .join("\n")}`;
  return { title, body };
}

export async function prepareFix({ git, base, baseSha, changes, report, repoUrl, override }) {
  const branch = fixBranch(base);
  const { title, body } = fixText({ report, branch, repoUrl, override });
  const exists = Boolean(await git.getRef(branch));
  let stale = !exists;
  for (const [path, content] of Object.entries(changes)) {
    if (!stale) stale = (await git.getFile(path, branch)) !== content;
  }
  if (stale) {
    const sha = await git.commit({ baseSha, changes, message: `${title}\n\n${body}` });
    await git.setRef(branch, sha, exists);
    await git.dispatch("pr-checks.yml", branch);
  }
  let pull = await git.openPull(branch);
  if (!pull) {
    try {
      pull = await git.createPull({ head: branch, base, title, body });
    } catch (error) {
      // 403: Actions may not open pull requests in this repository.
      if (error.status !== 403 && error.status !== 422) throw error;
    }
  } else if (pull.user?.login === BOT && (pull.title !== title || pull.body !== body)) {
    await git.updatePull(pull.number, { title, body });
  }
  const line = pull
    ? `**Prepared fix:** #${pull.number} sets the new pin; PR Checks run on its branch. Review it, then merge it: **merging deploys the landing site**.`
    : `**Prepared fix:** branch \`${branch}\` sets the new pin; PR Checks run on it. GitHub Actions may not open pull requests here, so [open the pull request](${repoUrl}/compare/${base}...${branch}?expand=1) (or \`gh pr create --base ${base} --head ${branch} --fill\`), review it, then merge it: **merging deploys the landing site**.`;
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
