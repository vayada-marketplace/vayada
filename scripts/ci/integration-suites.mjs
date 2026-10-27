#!/usr/bin/env node
// Where each apps/api PostgreSQL integration file runs (VAY-2111).
//
//   node scripts/ci/integration-suites.mjs nightly   # the nightly groups as JSON, one database each
//
// PR Checks (pr-checks.yml, api_postgres) names the files it runs. Every other
// `apps/api/src/**/*.integration.test.ts` file runs in the nightly job on main, unless NOT_IN_CI
// says why it cannot. integration-suites.test.mjs holds the contract; the frontend job runs it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const WORKFLOW_FILE = ".github/workflows/pr-checks.yml";
export const API_WORKSPACE = "vayada-api";
export const API_SOURCE_DIR = "apps/api/src";
const INTEGRATION_FILE = /\.integration\.test\.ts$/;

// Files that no CI run executes, each with the reason and the ticket that takes the file off the
// list. A file here still runs in PR Checks where a step names it with a `-t` filter.
export const NOT_IN_CI = {
  "src/domains/pmsInventoryMaterializationRepository.integration.test.ts":
    "VAY-2384: 'keeps provision availability current when an unrelated room awaits materialization' fails on main. PR Checks run the restricted Channex login and added-room cases with -t filters.",
};

// Nightly groups that cannot share a database with other files. Each gets its own database,
// migrated unless `migrate: false`, passed as TEST_DATABASE_URL unless `envName` says otherwise.
export const ISOLATED_GROUPS = [
  {
    name: "guest-reviews",
    reason: "drop and rebuild the pms, identity, hotel_catalog and platform schemas in beforeEach",
    migrate: false,
    files: [
      "src/domains/pmsGuestReviews.integration.test.ts",
      "src/domains/pmsReviewReplies.integration.test.ts",
    ],
  },
  {
    name: "bank-transfer-booking",
    reason: "shares the email queue with every other suite in its database (VAY-2239)",
    files: ["src/domains/financeBankTransferBooking.integration.test.ts"],
  },
  {
    name: "airbnb-import",
    reason: "the suite accepts only a database named vay1009_import_test",
    database: "vay1009_import_test",
    files: ["src/airbnbImportSourceRepository.integration.test.ts"],
  },
  {
    name: "growth-telemetry",
    reason:
      "wants an empty database through GROWTH_TEST_DATABASE_URL and rolls its own schema back",
    migrate: false,
    envName: "GROWTH_TEST_DATABASE_URL",
    files: ["src/platform/growthTelemetry.integration.test.ts"],
  },
];

// The remaining files run in alphabetical chunks of this size, one database per chunk, so one
// suite's leftovers cannot reach the whole run.
export const DEFAULT_GROUP_SIZE = 12;

// Every apps/api integration file, as `src/...` (the form pr-checks.yml uses), sorted.
export function integrationFiles(root = ROOT) {
  const base = join(root, API_SOURCE_DIR);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (INTEGRATION_FILE.test(entry.name)) {
        found.push(`src/${relative(base, path).split("\\").join("/")}`);
      }
    }
  };
  walk(base);
  return found.sort();
}

// The commands of a step's `run` block: continuation lines joined, then one command per line
// and per `&&`, `||` or `;` chain link (a step may chain a backend-migration and an api run).
function commandsOf(step) {
  const text = String(step.run ?? "").replace(/\\\n\s*/g, " ");
  return text.split(/\n|&&|\|\||;/).filter((line) => line.trim() !== "");
}

const runsApi = (command) => /(?:--workspace|-w)[= ]vayada-api\b/.test(command);
const hasTestFilter = (command) => /(?:^|\s)-t(?:\s|$)/.test(command);
const filesOf = (command) =>
  command.split(/\s+/).filter((token) => INTEGRATION_FILE.test(token) && token.startsWith("src/"));

// The integration files PR Checks runs: `full` when a vayada-api command names the file without
// a `-t` filter, `filteredOnly` when every command naming it filters by test name.
export function prChecksCoverage(workflowText) {
  const full = new Set();
  const filtered = new Set();
  for (const job of Object.values(parse(workflowText).jobs ?? {})) {
    for (const step of job.steps ?? []) {
      for (const command of commandsOf(step)) {
        if (!runsApi(command)) continue;
        for (const file of filesOf(command)) (hasTestFilter(command) ? filtered : full).add(file);
      }
    }
  }
  const filteredOnly = new Set([...filtered].filter((file) => !full.has(file)));
  return { full, filteredOnly };
}

// The nightly groups: the isolated groups, then the other files PR Checks does not fully run, in
// alphabetical chunks. Files in NOT_IN_CI and files PR Checks runs in full stay out.
export function nightlyGroups({ files, coverage }) {
  const skip = new Set([...coverage.full, ...Object.keys(NOT_IN_CI)]);
  const isolated = new Set(ISOLATED_GROUPS.flatMap((group) => group.files));
  const groups = ISOLATED_GROUPS.map((group) => ({
    ...group,
    files: group.files.filter((file) => !skip.has(file)),
  })).filter((group) => group.files.length > 0);
  const rest = files.filter((file) => !skip.has(file) && !isolated.has(file));
  for (let index = 0; index * DEFAULT_GROUP_SIZE < rest.length; index += 1) {
    groups.push({
      name: `default-${index + 1}`,
      files: rest.slice(index * DEFAULT_GROUP_SIZE, (index + 1) * DEFAULT_GROUP_SIZE),
    });
  }
  return groups;
}

export function nightlyGroupsFromRepo(root = ROOT) {
  const workflowText = readFileSync(join(root, WORKFLOW_FILE), "utf8");
  return nightlyGroups({ files: integrationFiles(root), coverage: prChecksCoverage(workflowText) });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command] = process.argv.slice(2);
  if (command !== "nightly") {
    console.error("usage: node scripts/ci/integration-suites.mjs nightly");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(nightlyGroupsFromRepo(), null, 2)}\n`);
}
