#!/usr/bin/env node
// Daily drift check for the Cloudflare Web Analytics beacon that apps/landing pins with SRI, run
// by .github/workflows/cloudflare-beacon-drift.yml. Cloudflare cannot version-pin the beacon, so
// every Cloudflare release makes browsers refuse it on vayada.com until the pin is updated. On a
// mismatch this opens or updates one GitHub issue and exits 1; when the live file matches the pin
// again it closes that issue. It never changes the pin: see
// engineering/cloudflare-beacon-pin-runbook.md.
//
//   node scripts/ci/cloudflare-beacon-drift.mjs            # needs GITHUB_TOKEN, GITHUB_REPOSITORY
//   node scripts/ci/cloudflare-beacon-drift.mjs --dry-run  # prints the report, touches no issue
//
// EXPECTED_INTEGRITY (the workflow_dispatch input) replaces the pin to exercise the alert path.
// No dependencies on purpose: the job runs without `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js";
export const PIN_FILE = "apps/landing/lib/cloudflareAnalytics.ts";
export const FIXTURE_FILE = "tests/e2e/landing/fixtures/cloudflare-beacon.min.js";
export const RUNBOOK = "engineering/cloudflare-beacon-pin-runbook.md";
export const ISSUE_TITLE = "Cloudflare beacon changed: review and update the landing SRI pin";
export const MARKER = "<!-- cloudflare-beacon-drift -->";
const INTEGRITY = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
// Listed in the report so the reviewer sees at a glance how a new version sends data, loads code
// or keeps state. The landing guards cover sendBeacon and XHR only.
export const SURFACE = [
  ["navigator.sendBeacon", /sendBeacon/g],
  ["XMLHttpRequest", /XMLHttpRequest/g],
  ["fetch()", /\bfetch\s*\(/g],
  ["WebSocket / EventSource", /\b(?:WebSocket|EventSource)\b/g],
  [
    "new Image / workers / document.write",
    /\bnew\s+Image\b|\b(?:Shared)?Worker\b|\bserviceWorker\b|\bdocument\.write/g,
  ],
  ["eval / Function()", /\beval\s*\(|\bFunction\s*\(/g],
  ["createElement / importScripts", /\bcreateElement\s*\(|\bimportScripts\b/g],
  ["cookies / storage", /document\.cookie|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/g],
  ["postMessage", /\bpostMessage\b/g],
];
const MAX_LISTED = 40;
const MAX_STATEMENT = 300;

export function readPin(source) {
  const match = /const integrity = "(sha384-[^"]+)"/.exec(source);
  if (!match || !INTEGRITY.test(match[1])) throw new Error(`No sha384 integrity in ${PIN_FILE}`);
  return match[1];
}

export function integrityOf(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

// The beacon reports its version as `versions:{js:"2026.10.1"}`; the ETag carries it too. Only
// a plain version string is accepted: it goes into markdown and log lines unescaped.
export function beaconVersion(text) {
  return /\bjs:"([\w.+-]{1,40})"/.exec(text)?.[1] ?? "unknown";
}

export function surface(text) {
  const urls = text.match(/https?:\/\/[^\s"'`)]+|\/cdn-cgi\/[\w/.-]+/g) ?? [];
  return {
    urls: [...new Set(urls)].sort(),
    counts: SURFACE.map(([name, pattern]) => [name, text.match(pattern)?.length ?? 0]),
  };
}

// The file is one minified line, so diff it statement by statement (split on `;`): statements
// that only one version has, in file order, duplicates counted.
export function statementDiff(before, after) {
  const split = (text) =>
    text
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
  const only = (list, other) => {
    const left = new Map();
    for (const statement of other) left.set(statement, (left.get(statement) ?? 0) + 1);
    return list.filter((statement) => {
      const count = left.get(statement) ?? 0;
      left.set(statement, count - 1);
      return count <= 0;
    });
  };
  const a = split(before);
  const b = split(after);
  return { before: a.length, after: b.length, removed: only(a, b), added: only(b, a) };
}

const bytes = (n) => `${n.toLocaleString("en-US")} bytes`;

function statementList(summary, statements) {
  if (statements.length === 0) return "";
  const shown = statements
    .slice(0, MAX_LISTED)
    .map((s) => (s.length > MAX_STATEMENT ? `${s.slice(0, MAX_STATEMENT)} …` : s));
  const more =
    statements.length > MAX_LISTED ? `\n… and ${statements.length - MAX_LISTED} more` : "";
  // Longer than any backtick run in the vendor code, so nothing in it can end the code block.
  const longest = Math.max(0, ...(shown.join("").match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `<details><summary>${summary} (${statements.length})</summary>\n\n${fence}js\n${shown.join(";\n")}${more}\n${fence}\n\n</details>\n`;
}

// Everything the report says, from the pin, the committed copy and the live response. The body is
// deterministic for a given live file, so a daily rerun leaves an up-to-date issue untouched.
export function buildReport({ pin, override, fixture, live, repoUrl }) {
  const expected = override || pin;
  const liveIntegrity = integrityOf(live.bytes);
  const matches = liveIntegrity === expected;
  const liveText = live.bytes.toString("utf8");
  const fixtureText = fixture.toString("utf8");
  const liveVersion = beaconVersion(liveText);
  const summary = matches
    ? `Live beacon ${liveVersion} matches ${override ? "EXPECTED_INTEGRITY" : "the pin"} (${expected}).`
    : `Live beacon ${liveVersion} (${liveIntegrity}) does not match ${override ? "EXPECTED_INTEGRITY" : "the pin"} (${expected}).`;
  if (matches) return { matches, summary, liveIntegrity };

  const diff = statementDiff(fixtureText, liveText);
  const was = surface(fixtureText);
  const now = surface(liveText);
  const flag = (a, b) => (a === b ? "" : " ⚠️");
  const counts = was.counts
    .map(([name, n], i) => `| ${name} | ${n} | ${now.counts[i][1]}${flag(n, now.counts[i][1])} |`)
    .join("\n");
  const urls = [...new Set([...was.urls, ...now.urls])]
    .sort()
    .map((url) => {
      const before = was.urls.includes(url) ? "yes" : "no";
      const after = now.urls.includes(url) ? "yes" : "no";
      return `| \`${url.replaceAll("|", "\\|")}\` | ${before} | ${after}${flag(before, after)} |`;
    })
    .join("\n");
  const note = override
    ? "\n> [!NOTE]\n> **Test run.** The expected hash came from the workflow_dispatch input `expected_integrity`, not from the pin. A run without the input compares with the pin again.\n"
    : "";
  const body = `${MARKER}
<!-- live: ${liveIntegrity} -->
Cloudflare's live Web Analytics beacon no longer matches the SRI pin in \`${PIN_FILE}\`. Browsers refuse to run it, so Cloudflare analytics on vayada.com is off for visitors who accepted it until the pin is updated. It fails closed: nothing is sent. PR checks are unaffected because they use the committed copy.

**Next step:** follow [\`${RUNBOOK}\`](${repoUrl ?? ".."}/blob/main/${RUNBOOK}). Review the change before copying the hash.
${note}
| | committed copy | live |
|---|---|---|
| version (\`js:\`) | ${beaconVersion(fixtureText)} | ${liveVersion} |
| size | ${bytes(fixture.length)} | ${bytes(live.bytes.length)} |
| sha384 | \`${integrityOf(fixture)}\` | \`${liveIntegrity}\` |

Expected ${override ? "(workflow_dispatch input)" : `(pin in \`${PIN_FILE}\`)`}: \`${expected}\`. Live response: ETag \`${live.etag ?? "none"}\`, Last-Modified \`${live.lastModified ?? "none"}\`.

New pin, only after review:

\`\`\`
${liveIntegrity}
\`\`\`

### What changed

${diff.removed.length + diff.added.length === 0 ? "No statement differs from the committed copy." : `Statements split on \`;\`: ${diff.before} before, ${diff.after} now; ${diff.removed.length} removed, ${diff.added.length} added.`}

| network, code loading, storage | committed copy | live |
|---|---|---|
${counts}

| URL or path in the file | committed copy | live |
|---|---|---|
${urls}

${[statementList("Removed statements", diff.removed), statementList("Added statements", diff.added)].join("")}
Checked daily by [Cloudflare Beacon Drift](${repoUrl ?? ".."}/actions/workflows/cloudflare-beacon-drift.yml).
`;
  return { matches, summary, liveIntegrity, liveVersion, body };
}

export async function fetchBeacon({ fetchImpl = fetch, attempts = 3, delayMs = 5000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(BEACON_URL, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GET ${BEACON_URL}: HTTP ${response.status}`);
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export function githubClient({
  token,
  repository,
  api = "https://api.github.com",
  fetchImpl = fetch,
}) {
  const request = async (method, path, body) => {
    const response = await fetchImpl(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  return {
    // Open issues and pull requests; reconcile() keeps the ones this workflow opened.
    async openIssues() {
      const issues = [];
      for (let page = 1; ; page++) {
        const batch = await request("GET", `/issues?state=open&per_page=100&page=${page}`);
        issues.push(...batch.filter((issue) => !issue.pull_request));
        if (batch.length < 100) return issues;
      }
    },
    createIssue: (title, body) => request("POST", "/issues", { title, body }),
    updateIssue: (number, fields) => request("PATCH", `/issues/${number}`, fields),
    comment: (number, body) => request("POST", `/issues/${number}/comments`, { body }),
  };
}

// One open issue at a time: open it on the first mismatch, rewrite it when the report changes
// (with a comment when the live file changed again), close it once the live file matches the
// pin. A run against an EXPECTED_INTEGRITY override never closes anything. Only issues the
// workflow opened count: in this public repository anyone can file one quoting the marker.
export const BOT = "github-actions[bot]";
export async function reconcile({ client, report, override }) {
  const open = (await client.openIssues())
    .filter((issue) => issue.user?.login === BOT && issue.body?.includes(MARKER))
    .sort((a, b) => a.number - b.number);
  if (report.matches) {
    if (override) return "matches the override; issues left as they are";
    for (const issue of open) {
      await client.comment(
        issue.number,
        `The live beacon matches the pin on main again (\`${report.liveIntegrity}\`). Closing. Check that Deploy Landing finished and vayada.com loads the beacon (runbook step 5).`,
      );
      await client.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
    }
    return open.length
      ? `closed ${open.map((i) => `#${i.number}`).join(", ")}`
      : "no open drift issue";
  }
  const [issue] = open;
  if (!issue) return `opened #${(await client.createIssue(ISSUE_TITLE, report.body)).number}`;
  if (issue.body === report.body) return `#${issue.number} is up to date`;
  await client.updateIssue(issue.number, { body: report.body });
  if (!issue.body.includes(`<!-- live: ${report.liveIntegrity} -->`)) {
    await client.comment(
      issue.number,
      `The live beacon changed again: now ${report.liveVersion}, \`${report.liveIntegrity}\`. The description is updated.`,
    );
  }
  return `updated #${issue.number}`;
}

// Only main's pin is the real one. Elsewhere only a test run (EXPECTED_INTEGRITY) touches issues,
// so checking a pin-update branch cannot close the real issue before the fix ships.
export function touchesIssues({ dryRun, ref, override }) {
  return !dryRun && (ref === "refs/heads/main" || Boolean(override));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const override = process.env.EXPECTED_INTEGRITY?.trim() ?? "";
  if (override && !INTEGRITY.test(override)) {
    throw new Error("EXPECTED_INTEGRITY must be sha384-<base64>");
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_TOKEN } = process.env;
  const repoUrl =
    GITHUB_REPOSITORY && `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}`;
  const report = buildReport({
    pin: readPin(readFileSync(PIN_FILE, "utf8")),
    override,
    fixture: readFileSync(FIXTURE_FILE),
    live: await fetchBeacon(),
    repoUrl,
  });
  console.log(report.summary);
  // In Actions the report goes only to the run summary: vendor text on stdout could carry
  // workflow commands (::error:: and the like).
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    appendFileSync(stepSummary, `${report.summary}\n\n${report.body ?? ""}`);
  } else if (report.body) {
    console.log(`\n${report.body}`);
  }
  if (!touchesIssues({ dryRun, ref: GITHUB_REF, override })) {
    console.log("Issue: none changed (dry run, or not main without expected_integrity).");
  } else {
    if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
      throw new Error("needs GITHUB_TOKEN and GITHUB_REPOSITORY");
    }
    const client = githubClient({
      token: GITHUB_TOKEN,
      repository: GITHUB_REPOSITORY,
      api: process.env.GITHUB_API_URL,
    });
    const outcome = await reconcile({ client, report, override });
    console.log(`Issue: ${outcome}.`);
    if (stepSummary) appendFileSync(stepSummary, `\nIssue: ${outcome}.\n`);
  }
  if (!report.matches) {
    console.error(`::error::${report.summary} See ${RUNBOOK}.`);
    process.exitCode = 1;
  }
}

// Compare real paths so a symlinked invocation can never turn the CLI into a silent no-op.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
