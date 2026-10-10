import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  COHORT_SCOPE_CATEGORIES,
  cohortActivationViolations,
  evaluateCohortScope,
  type ProductionParityCohortScopeEvidence,
} from "./productionParityCohortScope.js";
import type { CohortReadiness } from "./productionPmsCohortReadiness.js";

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

  it("reports cohort lifecycle counts, and fails only a lifecycle that disagrees with readiness", () => {
    const readiness = (propertyId: string, lifecycleStatus: string, ready: boolean) =>
      ({
        propertyId,
        lifecycleStatus,
        ...Object.fromEntries(
          ["a", "b", "c", "d", "e", "f", "g", "complete"].map((key) => [key, ready || key !== "f"]),
        ),
      }) as CohortReadiness;
    expect(
      cohortActivationViolations([
        readiness("ready-active", "active", true),
        readiness("missing-provisioning", "provisioning", false),
        readiness("ready-suspended", "suspended", true),
        readiness("missing-active", "active", false),
        readiness("ready-provisioning", "provisioning", true),
      ]),
    ).toEqual([
      { category: "cohortActiveNotReady", subjectId: "missing-active" },
      { category: "cohortReadyNotActive", subjectId: "ready-provisioning" },
    ]);
    const missing = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 1, g: 0, complete: 0 };
    const result = evaluateCohortScope(
      { cohortSha256: COHORT },
      { ...scope(), readiness: { cohortProperties: 2, active: 1, provisioning: 1, missing } },
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ severity: "pass", actual: "2 cohort, 3 outside the cohort" }),
      expect.objectContaining({
        severity: "pass",
        targetObject: "hotel_catalog.properties",
        actual: "1 active, 1 provisioning; missing a=0 b=0 c=0 d=0 e=0 f=1 g=0 complete=0",
      }),
    ]);
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
