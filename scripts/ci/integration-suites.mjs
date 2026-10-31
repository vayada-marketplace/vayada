#!/usr/bin/env node
// Where each PostgreSQL test file runs (VAY-2111, VAY-2427).
//
//   node scripts/ci/integration-suites.mjs nightly   # the nightly groups as JSON, one database each
//
// PR Checks (pr-checks.yml, api_postgres) names the files it runs. Every other
// `apps/api/src/**/*.integration.test.ts` file, and every other `*.test.ts` file that reads
// TEST_DATABASE_URL (its PostgreSQL part skips itself without one, VAY-2407), runs in the nightly
// job on main, unless NOT_IN_CI says why it cannot. The backend packages' database test files have
// no nightly run: PR Checks runs each of them in full, or PACKAGE_NOT_IN_CI says why not (VAY-2427).
// integration-suites.test.mjs holds the contract; the frontend job runs it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const WORKFLOW_FILE = ".github/workflows/pr-checks.yml";
export const API_WORKSPACE = "vayada-api";
export const API_DIR = "apps/api";
export const API_SOURCE_DIR = `${API_DIR}/src`;
export const PACKAGES_DIR = "packages";
const INTEGRATION_FILE = /\.integration\.test\.ts$/;
const TEST_FILE = /\.test\.ts$/;

// Files that no CI run executes, each with the reason and the ticket that takes the file off the
// list. A file here still runs in PR Checks where a step names it with a `-t` filter.
export const NOT_IN_CI = {
  "src/domains/pmsInventoryMaterializationRepository.integration.test.ts":
    "VAY-2384: 'keeps provision availability current when an unrelated room awaits materialization' fails on main. PR Checks run the restricted Channex login and added-room cases with -t filters.",
};

// Package test files with a PostgreSQL part that PR Checks does not run in full, as
// `packages/<dir>/src/...`, each with the reason and the ticket that takes the file off the list.
export const PACKAGE_NOT_IN_CI = {};

// Nightly groups that cannot share a database with other files. Each gets its own database,
// migrated unless `migrate: false`, passed as TEST_DATABASE_URL unless `envName` says otherwise.
export const ISOLATED_GROUPS = [
  {
    name: "guest-reviews",
    reason:
      "drop and rebuild the pms, hotel_catalog, platform (and identity) schemas in beforeEach",
    migrate: false,
    files: [
      "src/domains/pmsGuestReviews.integration.test.ts",
      "src/domains/pmsReviewReplies.integration.test.ts",
      "src/jobs/channexReviews.test.ts",
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

// The integration files under `base` and every other test file there that reads a
// *TEST_DATABASE_URL, as `src/...` (the form pr-checks.yml uses), sorted.
function databaseTestFiles(base) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        INTEGRATION_FILE.test(entry.name) ||
        (TEST_FILE.test(entry.name) && readFileSync(path, "utf8").includes("TEST_DATABASE_URL"))
      ) {
        found.push(`src/${relative(base, path).split("\\").join("/")}`);
      }
    }
  };
  walk(base);
  return found.sort();
}

// Every apps/api integration file and every other test file that reads TEST_DATABASE_URL.
export function integrationFiles(root = ROOT) {
  return databaseTestFiles(join(root, API_SOURCE_DIR));
}

// The same files in every backend package: { workspace, path, file } with the package's npm name,
// `packages/<dir>/src/...` and the `src/...` form its PR Checks commands use.
export function packageDatabaseFiles(root = ROOT) {
  const found = [];
  for (const entry of readdirSync(join(root, PACKAGES_DIR), { withFileTypes: true })) {
    const dir = `${PACKAGES_DIR}/${entry.name}`;
    const source = join(root, dir, "src");
    if (!entry.isDirectory() || !existsSync(source)) continue;
    const files = databaseTestFiles(source);
    if (files.length === 0) continue;
    const manifest = join(root, dir, "package.json");
    const { name: workspace } = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8"))
      : {};
    if (!workspace) throw new Error(`${dir} has database test files but no package.json name`);
    for (const file of files) found.push({ workspace, path: `${dir}/${file}`, file });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// The commands of a step's `run` block: continuation lines joined and shell comment lines
// dropped, then one command per line and per `&&`, `||` or `;` chain link (a step may chain a
// backend-migration and an api run).
function commandsOf(step) {
  const text = String(step.run ?? "")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  return text.split(/\n|&&|\|\||;/).filter((line) => line.trim() !== "");
}

const workspaceOf = (command) => /(?:--workspace|-w)[= ](\S+)/.exec(command)?.[1];
const hasTestFilter = (command) => /(?:^|\s)(?:-t|--testNamePattern)(?:[\s=]|$)/.test(command);
const filesOf = (command) =>
  command.split(/\s+/).filter((token) => TEST_FILE.test(token) && token.startsWith("src/"));
const DATABASE_ENV = /\b[A-Z0-9_]*TEST_DATABASE_URL\b/g;
// The test database URLs a step's env or the command sets. Without the one a file reads, its
// PostgreSQL part skips itself (TARGET_DATABASE_URL alone only migrates).
const databaseEnvsOf = (env, command) =>
  new Set([
    ...Object.keys(env).filter((name) => name.endsWith("TEST_DATABASE_URL")),
    ...[...command.matchAll(/\b([A-Z0-9_]*TEST_DATABASE_URL)=/g)].map((match) => match[1]),
  ]);

// The *TEST_DATABASE_URL names a test file reads, so a step setting another one does not count.
export function databaseEnvNames(text) {
  return new Set(text.match(DATABASE_ENV) ?? []);
}

// Reads the names from `<dir>/<file>`; a file without any accepts every test database URL.
export const repoEnvNames =
  (dir, root = ROOT) =>
  (file) => {
    const path = join(root, dir, file);
    return existsSync(path) ? databaseEnvNames(readFileSync(path, "utf8")) : new Set();
  };

// The files of one workspace that PR Checks runs with a database: `full` when a command of that
// workspace names the file without a `-t` filter and sets a test database URL the file reads,
// `filteredOnly` when every such command filters by test name.
export function prChecksCoverage(
  workflowText,
  workspace = API_WORKSPACE,
  envNamesOf = () => new Set(),
) {
  const full = new Set();
  const filtered = new Set();
  for (const job of Object.values(parse(workflowText).jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const env = { ...job.env, ...step.env };
      for (const command of commandsOf(step)) {
        const set = databaseEnvsOf(env, command);
        if (workspaceOf(command) !== workspace || set.size === 0) continue;
        for (const file of filesOf(command)) {
          const reads = envNamesOf(file);
          if (reads.size > 0 && ![...reads].some((name) => set.has(name))) continue;
          (hasTestFilter(command) ? filtered : full).add(file);
        }
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
  const coverage = prChecksCoverage(workflowText, API_WORKSPACE, repoEnvNames(API_DIR, root));
  return nightlyGroups({ files: integrationFiles(root), coverage });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command] = process.argv.slice(2);
  if (command !== "nightly") {
    console.error("usage: node scripts/ci/integration-suites.mjs nightly");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(nightlyGroupsFromRepo(), null, 2)}\n`);
}
