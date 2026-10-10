import { describe, expect, it } from "vitest";

import {
  parseProductionMigrationCohort,
  writeProductionMigrationCohort,
} from "./productionMigrationCohort.js";

const RUN = `vay1351-${"a".repeat(24)}`;
const A = "11111111-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const input = {
  sourceRunId: RUN,
  bookingHotelIds: [B, A],
  pmsHotelIds: [A],
  marketplaceHotelIds: [],
  approvalProofSha256: "d".repeat(64),
};

describe("production migration cohort", () => {
  it("canonicalizes ID order into one stable cohort checksum", () => {
    const cohort = parseProductionMigrationCohort(input);
    expect(cohort.bookingHotelIds).toEqual([A, B]);
    expect(cohort.cohortSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseProductionMigrationCohort({ ...input, bookingHotelIds: [A, B] }).cohortSha256).toBe(
      cohort.cohortSha256,
    );
    expect(parseProductionMigrationCohort({ ...input, pmsHotelIds: [] }).cohortSha256).not.toBe(
      cohort.cohortSha256,
    );
  });

  it.each([
    ["an unknown key", { ...input, extra: true }],
    ["a missing ID set", { ...input, pmsHotelIds: undefined }],
    ["an empty Booking set", { ...input, bookingHotelIds: [] }],
    ["duplicate IDs", { ...input, pmsHotelIds: [A, A] }],
    ["an uppercase ID", { ...input, pmsHotelIds: [B.toUpperCase()] }],
    ["a malformed source run", { ...input, sourceRunId: "vay1351-latest" }],
    ["a malformed approval proof", { ...input, approvalProofSha256: "approved" }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseProductionMigrationCohort(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_COHORT" }),
    );
  });

  it("writes once, accepts the same cohort again and rejects a different one", async () => {
    const client = new FakeCohortTable();
    const cohort = parseProductionMigrationCohort(input);
    await writeProductionMigrationCohort(client as never, cohort);
    await writeProductionMigrationCohort(client as never, cohort);
    expect(client.rows.size).toBe(1);

    for (const other of [
      parseProductionMigrationCohort({ ...input, pmsHotelIds: [] }),
      parseProductionMigrationCohort({ ...input, approvalProofSha256: "e".repeat(64) }),
    ])
      await expect(writeProductionMigrationCohort(client as never, other)).rejects.toMatchObject({
        code: "COHORT_CONFLICT",
      });
  });
});

class FakeCohortTable {
  rows = new Map<string, Record<string, unknown>>();

  async query(sql: string, values: unknown[]) {
    if (sql.includes("INSERT")) {
      const [sourceRunId, cohortSha256, bookingHotelIds, pmsHotelIds, marketplaceHotelIds] = values;
      if (!this.rows.has(sourceRunId as string))
        this.rows.set(sourceRunId as string, {
          sourceRunId,
          cohortSha256,
          bookingHotelIds,
          pmsHotelIds,
          marketplaceHotelIds,
          approvalProofSha256: values[5],
        });
      return { rows: [] };
    }
    const row = this.rows.get(values[0] as string);
    return { rows: row ? [row] : [] };
  }
}
