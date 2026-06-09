import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ParityFinding } from "../../parityTypes.js";
import { checkPlatformJobsEventsAuditParity } from "./parity.js";

describe("checkPlatformJobsEventsAuditParity", () => {
  it("reports missing platform expected-target config before running database checks", async () => {
    const query = vi.fn(async () => {
      throw new Error("unexpected query");
    });
    const findings: ParityFinding[] = [];

    await checkPlatformJobsEventsAuditParity({
      client: { query } as unknown as pg.Client,
      expected: {
        counts: {},
        idStability: {},
        uniquenessChecks: [],
      },
      findings,
    });

    expect(query).not.toHaveBeenCalled();
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLATFORM_EXPECTED_COUNT_MISSING",
          targetObject: "expected-target.json.counts.platform.domain_events",
        }),
        expect.objectContaining({
          code: "PLATFORM_EXPECTED_ID_STABILITY_MISSING",
          targetObject: "expected-target.json.idStability.platform.product_audit_events",
        }),
      ]),
    );
  });
});
