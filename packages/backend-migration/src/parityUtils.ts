import type pg from "pg";

import type { ExpectedTarget, ParityFinding } from "./parityTypes.js";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
