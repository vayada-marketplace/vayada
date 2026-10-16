#!/usr/bin/env node
// Daily drift check for the Cloudflare Web Analytics beacon that apps/landing pins with SRI, run
// by .github/workflows/cloudflare-beacon-drift.yml. Cloudflare cannot version-pin the beacon, so
// every Cloudflare release makes browsers refuse it on vayada.com until the pin is updated. On a
// mismatch this writes a report for the reviewer to the run summary and exits 1, so the
// scheduled run fails. It never changes the pin: see engineering/cloudflare-beacon-pin-runbook.md.
//
//   node scripts/ci/cloudflare-beacon-drift.mjs
//   node scripts/ci/cloudflare-beacon-drift.mjs --record beacon.min.js > scripts/ci/cloudflare-beacon-reviewed.json
//
// EXPECTED_INTEGRITY (the workflow_dispatch input) replaces the pin to exercise the alert path.
// No dependencies on purpose: the job runs without `npm ci`.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BEACON_URL = "https://static.cloudflareinsights.com/beacon.min.js";
export const PIN_FILE = "apps/landing/lib/cloudflareAnalytics.ts";
// What the repository keeps of the reviewed beacon: hashes and counts, never the code itself,
// because this repository is public. Regenerated with --record whenever the pin changes.
export const RECORD_FILE = "scripts/ci/cloudflare-beacon-reviewed.json";
export const RUNBOOK = "engineering/cloudflare-beacon-pin-runbook.md";
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

// The file is one minified line, so it is compared statement by statement (split on `;`).
const statements = (text) =>
  text
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
export const fingerprint = (statement) =>
  createHash("sha256").update(statement).digest("base64url").slice(0, 12);

export function reviewRecord(bytes) {
  const text = bytes.toString("utf8");
  const { urls, counts } = surface(text);
  return {
    version: beaconVersion(text),
    size: bytes.length,
    integrity: integrityOf(bytes),
    counts: Object.fromEntries(counts),
    urls,
    statements: statements(text).map(fingerprint).join(" "),
  };
}

// Against the reviewed fingerprints: how many reviewed statements are gone and how many live
// statements are new, duplicates counted. Only counts: the report never quotes vendor code.
export function statementDiff(reviewed, text) {
  const left = new Map();
  for (const print of reviewed) left.set(print, (left.get(print) ?? 0) + 1);
  const live = statements(text);
  const added = live.filter((statement) => {
    const count = left.get(fingerprint(statement)) ?? 0;
    left.set(fingerprint(statement), count - 1);
    return count <= 0;
  }).length;
  const removed = [...left.values()].reduce((sum, count) => sum + Math.max(0, count), 0);
  return { before: reviewed.length, after: live.length, removed, added };
}

const bytes = (n) => `${n.toLocaleString("en-US")} bytes`;

// Everything the report says, from the pin, the reviewed record and the live response. The body
// is deterministic for a given live file.
export function buildReport({ pin, override, record, live, repoUrl }) {
  const expected = override || pin;
  const liveIntegrity = integrityOf(live.bytes);
  const matches = liveIntegrity === expected;
  const liveText = live.bytes.toString("utf8");
  const liveVersion = beaconVersion(liveText);
  const summary = matches
    ? `Live beacon ${liveVersion} matches ${override ? "EXPECTED_INTEGRITY" : "the pin"} (${expected}).`
    : `Live beacon ${liveVersion} (${liveIntegrity}) does not match ${override ? "EXPECTED_INTEGRITY" : "the pin"} (${expected}).`;
  if (matches) return { matches, summary, liveIntegrity };

  const diff = statementDiff(record.statements.split(" ").filter(Boolean), liveText);
  const now = surface(liveText);
  const flag = (a, b) => (a === b ? "" : " ⚠️");
  // A row added to SURFACE after the record was made has no reviewed count: flag it if used.
  const counts = now.counts
    .map(([name, n]) => {
      const before = record.counts[name];
      return `| ${name} | ${before ?? "not recorded"} | ${n}${flag(before ?? 0, n)} |`;
    })
    .join("\n");
  const urls = [...new Set([...record.urls, ...now.urls])]
    .sort()
    .map((url) => {
      const before = record.urls.includes(url) ? "yes" : "no";
      const after = now.urls.includes(url) ? "yes" : "no";
      return `| \`${url.replaceAll("|", "\\|")}\` | ${before} | ${after}${flag(before, after)} |`;
    })
    .join("\n");
  // A test run can miss its input while the live file still matches the real pin. Then nothing
  // is broken, and the report must not say so or ask for a new pin.
  const drifted = liveIntegrity !== pin;
  const intro = drifted
    ? `Cloudflare's live Web Analytics beacon no longer matches the SRI pin in \`${PIN_FILE}\`. Browsers refuse to run it, so Cloudflare analytics on vayada.com is off for visitors who accepted it until the pin is updated. It fails closed: nothing is sent. PR checks are unaffected: the consent spec uses a stub beacon.

**Next step:** follow [\`${RUNBOOK}\`](${repoUrl ?? ".."}/blob/main/${RUNBOOK}). Review the change before copying the hash.`
    : `The live beacon still matches the SRI pin in \`${PIN_FILE}\`: nothing is broken. It only differs from the hash this test run was given.`;
  const newPin = drifted
    ? `New pin, only after review:\n\n\`\`\`\n${liveIntegrity}\n\`\`\`\n\n`
    : "";
  const note = override
    ? "\n> [!NOTE]\n> **Test run.** The expected hash came from the workflow_dispatch input `expected_integrity`, not from the pin. A run without the input compares with the pin again.\n"
    : "";
  const body = `${MARKER}
<!-- live: ${liveIntegrity} -->
${intro}
${note}
| | reviewed | live |
|---|---|---|
| version (\`js:\`) | ${record.version} | ${liveVersion} |
| size | ${bytes(record.size)} | ${bytes(live.bytes.length)} |
| sha384 | \`${record.integrity}\` | \`${liveIntegrity}\` |

Expected ${override ? "(workflow_dispatch input)" : `(pin in \`${PIN_FILE}\`)`}: \`${expected}\`. Live response: ETag \`${live.etag ?? "none"}\`, Last-Modified \`${live.lastModified ?? "none"}\`.

${newPin}### What changed

${diff.removed + diff.added === 0 ? "No statement differs from the reviewed version." : `Statements split on \`;\`: ${diff.before} reviewed, ${diff.after} now; ${diff.removed} reviewed statements are gone and ${diff.added} are new. The report never quotes vendor code; runbook step 2 shows how to diff the two versions locally.`}

| network, code loading, storage | reviewed | live |
|---|---|---|
${counts}

| URL or path in the file | reviewed | live |
|---|---|---|
${urls}

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

async function main() {
  const recordIndex = process.argv.indexOf("--record");
  if (recordIndex !== -1) {
    const file = process.argv[recordIndex + 1];
    if (!file) throw new Error("usage: --record <downloaded beacon.min.js>");
    console.log(JSON.stringify(reviewRecord(readFileSync(file)), null, 2));
    return;
  }
  const override = process.env.EXPECTED_INTEGRITY?.trim() ?? "";
  if (override && !INTEGRITY.test(override)) {
    throw new Error("EXPECTED_INTEGRITY must be sha384-<base64>");
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  const repoUrl =
    GITHUB_REPOSITORY && `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}`;
  const report = buildReport({
    pin: readPin(readFileSync(PIN_FILE, "utf8")),
    override,
    record: JSON.parse(readFileSync(RECORD_FILE, "utf8")),
    live: await fetchBeacon(),
    repoUrl,
  });
  console.log(report.summary);
  // In Actions the report goes only to the run summary: vendor text on stdout could carry
  // workflow commands (::error:: and the like).
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary}\n\n${report.body ?? ""}`);
  } else if (report.body) {
    console.log(`\n${report.body}`);
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
