import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COHORT_SCOPE_CATEGORIES,
  evaluateCohortScope,
  type ProductionParityCohortScopeEvidence,
} from "./productionParityCohortScope.js";

const COHORT = "c".repeat(64);
const PROOF = "a".repeat(64);
const PROPERTY = "13620000-0000-4000-8000-000000000001";

const scope = (
  violations: ProductionParityCohortScopeEvidence["violations"] = [],
): ProductionParityCohortScopeEvidence => ({
  cohortSha256: COHORT,
  approvalProofSha256: PROOF,
  cohortProperties: 2,
  nonCohortProperties: 3,
  violations,
});

describe("COHORT_SCOPE_VERIFIED", () => {
  it("is absent without a configured or stored cohort", () => {
    expect(evaluateCohortScope({}, null)).toEqual({ findings: [] });
    expect(evaluateCohortScope({}, undefined)).toEqual({ findings: [] });
  });

  it("passes a stored cohort that matches the configuration and has no violations", () => {
    const result = evaluateCohortScope(
      { cohortSha256: COHORT, cohortApprovalProofSha256: PROOF },
      scope(),
    );

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "pass",
        code: "COHORT_SCOPE_VERIFIED",
        actual: "2 cohort, 3 outside the cohort",
      }),
    ]);
    expect(result.summary).toMatchObject({ cohortProperties: 2, nonCohortProperties: 3 });
    expect(Object.values(result.summary!.violations)).toEqual(COHORT_SCOPE_CATEGORIES.map(() => 0));
  });

  it.each([
    ["a configured cohort that is not stored", { cohortSha256: COHORT }, null, "Missing"],
    ["a stored cohort that is not configured", {}, scope(), COHORT],
    ["a different stored cohort", { cohortSha256: "d".repeat(64) }, scope(), COHORT],
    [
      "a different approval proof",
      { cohortSha256: COHORT, cohortApprovalProofSha256: "e".repeat(64) },
      scope(),
      PROOF,
    ],
  ])("fails %s", (_case, config, evidence, actual) => {
    const { findings } = evaluateCohortScope(config, evidence);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "fail",
        targetObject: "platform.production_migration_cohorts",
        actual,
      }),
    ]);
  });

  it.each(COHORT_SCOPE_CATEGORIES)("fails a %s violation with hashed subjects only", (category) => {
    const result = evaluateCohortScope(
      { cohortSha256: COHORT },
      scope([
        { category, subjectId: PROPERTY },
        { category, subjectId: PROPERTY },
      ]),
    );
    const hashed = `sha256:${createHash("sha256").update(PROPERTY).digest("hex")}`;

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "fail",
        code: "COHORT_SCOPE_VERIFIED",
        targetObject: `cohort_scope.${category}`,
        expected: "0",
        actual: `1: ${hashed}`,
      }),
    ]);
    expect(result.summary!.violations[category]).toBe(1);
    expect(JSON.stringify(result)).not.toContain(PROPERTY);
  });
});
