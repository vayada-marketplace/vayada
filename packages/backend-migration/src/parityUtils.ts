import type pg from "pg";

import type { ExpectedTarget, ParityFinding } from "./parityTypes.js";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addInvalidFixtureConfigFinding(
  findings: ParityFinding[],
  targetObject: string,
  message: string,
  expected: string,
  actual: string,
): void {
  findings.push({
    severity: "fail",
    code: "INVALID_FIXTURE_CONFIG",
    owner: "Parity harness",
    targetObject,
    message,
    expected,
    actual,
    suggestedAction: "Fix expected-target.json before running parity checks.",
  });
}

export function parseTableRef(
  tableRef: string,
  findings: ParityFinding[],
): { schema: string; table: string } | null {
  const parts = tableRef.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !SAFE_IDENTIFIER.test(parts[0]) ||
    !SAFE_IDENTIFIER.test(parts[1])
  ) {
    findings.push({
      severity: "fail",
      code: "INVALID_FIXTURE_CONFIG",
      owner: "Parity harness",
      targetObject: tableRef,
      message: `Malformed table reference "${tableRef}" in expected-target.json — expected "schema.table"`,
      expected: "schema.table",
      actual: tableRef,
      suggestedAction: `Fix the table reference in expected-target.json.`,
    });
    return null;
  }
  return { schema: parts[0], table: parts[1] };
}

export function validateExpectedTargetConfig(
  expected: unknown,
  findings: ParityFinding[],
): expected is ExpectedTarget {
  if (!isRecord(expected)) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json",
      "expected-target.json must contain a JSON object",
      "object",
      Array.isArray(expected) ? "array" : typeof expected,
    );
    return false;
  }

  if (!isRecord(expected["counts"])) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.counts",
      "expected-target.json counts must be an object keyed by schema.table",
      "Record<schema.table, non-negative integer>",
      Array.isArray(expected["counts"]) ? "array" : typeof expected["counts"],
    );
  } else {
    for (const [tableRef, count] of Object.entries(expected["counts"])) {
      parseTableRef(tableRef, findings);
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        addInvalidFixtureConfigFinding(
          findings,
          `expected-target.json.counts.${tableRef}`,
          `Invalid expected row count for ${tableRef}`,
          "non-negative integer",
          JSON.stringify(count),
        );
      }
    }
  }

  if (!isRecord(expected["idStability"])) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.idStability",
      "expected-target.json idStability must be an object keyed by schema.table",
      "Record<schema.table, string[]>",
      Array.isArray(expected["idStability"]) ? "array" : typeof expected["idStability"],
    );
  } else {
    for (const [tableRef, ids] of Object.entries(expected["idStability"])) {
      parseTableRef(tableRef, findings);
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
        addInvalidFixtureConfigFinding(
          findings,
          `expected-target.json.idStability.${tableRef}`,
          `Invalid ID stability list for ${tableRef}`,
          "string[]",
          JSON.stringify(ids),
        );
      }
    }
  }

  const uniquenessChecks = expected["uniquenessChecks"];
  if (
    uniquenessChecks !== undefined &&
    (!Array.isArray(uniquenessChecks) ||
      !uniquenessChecks.every((check) => typeof check === "string"))
  ) {
    addInvalidFixtureConfigFinding(
      findings,
      "expected-target.json.uniquenessChecks",
      "expected-target.json uniquenessChecks must be an array of strings when present",
      "string[]",
      JSON.stringify(uniquenessChecks),
    );
  }

  for (const extensionKey of ["identityChecks", "catalogPublicProfileChecks"]) {
    const extension = expected[extensionKey];
    if (extension !== undefined && !isRecord(extension)) {
      addInvalidFixtureConfigFinding(
        findings,
        `expected-target.json.${extensionKey}`,
        `expected-target.json ${extensionKey} must be an object when present`,
        "object",
        Array.isArray(extension) ? "array" : typeof extension,
      );
    }
  }

  return findings.every((finding) => finding.code !== "INVALID_FIXTURE_CONFIG");
}

export async function checkRowCounts(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, expectedCount] of Object.entries(expected.counts)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text FROM "${ref.schema}"."${ref.table}"`,
    );
    const actual = parseInt(result.rows[0].count, 10);
    if (actual !== expectedCount) {
      findings.push({
        severity: "fail",
        code: "ROW_COUNT_MISMATCH",
        owner: "Parity harness",
        targetObject: tableRef,
        message: `Row count mismatch for ${tableRef}`,
        expected: String(expectedCount),
        actual: String(actual),
        suggestedAction: "Check fixture source rows and transform logic.",
      });
    }
  }
}

export async function checkIdStability(
  client: pg.Client,
  expected: ExpectedTarget,
  findings: ParityFinding[],
): Promise<void> {
  for (const [tableRef, ids] of Object.entries(expected.idStability)) {
    const ref = parseTableRef(tableRef, findings);
    if (!ref) continue;

    for (const id of ids) {
      const result = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM "${ref.schema}"."${ref.table}" WHERE id = $1) AS exists`,
        [id],
      );
      if (!result.rows[0].exists) {
        findings.push({
          severity: "fail",
          code: "ID_STABILITY_VIOLATION",
          owner: "Parity harness",
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
