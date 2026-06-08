import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ParityFinding } from "../../parityTypes.js";
import { checkIdentityOrganizationLinksParity } from "./parity.js";

describe("checkIdentityOrganizationLinksParity", () => {
  it("reports invalid uniqueness check keys before running database checks", async () => {
    const query = vi.fn(async () => {
      throw new Error("unexpected query");
    });
    const findings: ParityFinding[] = [];

    await checkIdentityOrganizationLinksParity({
      client: { query } as unknown as pg.Client,
      expected: {
        counts: {},
        idStability: {},
        uniquenessChecks: ["source_external_identites"],
      },
      findings,
    });

    expect(query).not.toHaveBeenCalled();
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "fail",
        code: "INVALID_FIXTURE_CONFIG",
        owner: "Parity harness",
        targetObject: "expected-target.json",
        actual: "source_external_identites",
      }),
    ]);
  });
});
