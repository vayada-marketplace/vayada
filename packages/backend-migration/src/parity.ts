import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

import { type MigrationEnvironment } from "./runner.js";

export type ParityCheckSeverity = "fail" | "warn";

export type ParityFinding = {
  severity: ParityCheckSeverity;
  code: string;
  owner: string;
  targetObject: string;
  message: string;
  expected: string;
  actual: string;
  suggestedAction?: string;
};

export type ParityReport = {
  runId: string;
  environment: string;
  fixtureCase: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed";
  summary: {
    failures: number;
    warnings: number;
  };
  findings: ParityFinding[];
};

export type ParityConfig = {
  connectionString: string;
  fixtureCase: string;
  fixturesDir: string;
  environment: MigrationEnvironment;
};

type ExpectedTarget = {
  counts: Record<string, number>;
  idStability: Record<string, string[]>;
  uniquenessChecks: string[];
};

async function checkRowCounts(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, expectedCount] of Object.entries(expected.counts)) {
    const [schema, table] = tableRef.split(".");
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM "${schema}"."${table}"`,
    );
    const actual = parseInt(result.rows[0].count, 10);
    if (actual !== expectedCount) {
      findings.push({
        severity: "fail",
        code: "ROW_COUNT_MISMATCH",
        owner: "Identity/auth",
        targetObject: tableRef,
        message: `Row count mismatch for ${tableRef}`,
        expected: String(expectedCount),
        actual: String(actual),
        suggestedAction: "Check fixture source rows and transform logic.",
      });
    }
  }
}

async function checkIdStability(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, ids] of Object.entries(expected.idStability)) {
    const [schema, table] = tableRef.split(".");
    for (const id of ids) {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM "${schema}"."${table}" WHERE id = $1) AS exists`,
        [id],
      );
      if (!result.rows[0].exists) {
        findings.push({
          severity: "fail",
          code: "ID_STABILITY_VIOLATION",
          owner: "Identity/auth",
          targetObject: tableRef,
          message: `Source ID ${id} not found in ${tableRef} — ID was not preserved`,
          expected: `Row with id = ${id}`,
          actual: "Row not found",
          suggestedAction: "Verify the ETL transform preserves source primary key values.",
        });
      }
    }
  }
}

async function checkUniqueness(client: pg.Client, findings: ParityFinding[]): Promise<void> {
  // (provider, provider_user_id) uniqueness — partial (only where provider_user_id IS NOT NULL)
  const extIdDupes = await client.query<{ count: string }>(`
    SELECT count(*)::text FROM (
      SELECT provider, provider_user_id
      FROM identity.external_identities
      WHERE provider_user_id IS NOT NULL
      GROUP BY provider, provider_user_id
      HAVING count(*) > 1
    ) AS dupes
  `);
  if (parseInt(extIdDupes.rows[0].count, 10) > 0) {
    findings.push({
      severity: "fail",
      code: "UNIQUENESS_VIOLATION",
      owner: "Identity/auth",
      targetObject: "identity.external_identities",
      message: "Duplicate (provider, provider_user_id) pairs found",
      expected: "0 duplicate pairs",
      actual: `${extIdDupes.rows[0].count} duplicate pair(s)`,
      suggestedAction: "Deduplicate source external identity rows before migration.",
    });
  }

  // (organization_id, user_id) uniqueness in memberships
  const membershipDupes = await client.query<{ count: string }>(`
    SELECT count(*)::text FROM (
      SELECT organization_id, user_id
      FROM identity.organization_memberships
      GROUP BY organization_id, user_id
      HAVING count(*) > 1
    ) AS dupes
  `);
  if (parseInt(membershipDupes.rows[0].count, 10) > 0) {
    findings.push({
      severity: "fail",
      code: "UNIQUENESS_VIOLATION",
      owner: "Identity/auth",
      targetObject: "identity.organization_memberships",
      message: "Duplicate (organization_id, user_id) pairs found in memberships",
      expected: "0 duplicate pairs",
      actual: `${membershipDupes.rows[0].count} duplicate pair(s)`,
      suggestedAction: "Deduplicate membership rows before migration.",
    });
  }
}

export async function runParityChecks(config: ParityConfig): Promise<ParityReport> {
  const startedAt = new Date().toISOString();
  const runId = `${config.environment}-${config.fixtureCase}-${Date.now()}`;
  const findings: ParityFinding[] = [];

  const expectedPath = join(
    config.fixturesDir,
    "cases",
    config.fixtureCase,
    "expected-target.json",
  );
  const expected: ExpectedTarget = JSON.parse(await readFile(expectedPath, "utf8"));

  const client = new pg.Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    await checkRowCounts(client, expected, findings);
    await checkIdStability(client, expected, findings);
    await checkUniqueness(client, findings);
  } finally {
    await client.end();
  }

  const finishedAt = new Date().toISOString();
  const failures = findings.filter((f) => f.severity === "fail").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;

  return {
    runId,
    environment: config.environment,
    fixtureCase: config.fixtureCase,
    startedAt,
    finishedAt,
    status: failures > 0 ? "failed" : "passed",
    summary: { failures, warnings },
    findings,
  };
}
