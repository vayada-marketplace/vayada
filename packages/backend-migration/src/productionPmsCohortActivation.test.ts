import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  LIFECYCLE_CONTRACT_VERSION,
  summarizeCohortReadiness,
} from "./productionPmsCohortActivation.js";
import { runProductionPmsTransaction } from "./productionPmsMigration.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import {
  COHORT_READINESS_SQL,
  readyForActivation,
  type CohortReadiness,
} from "./productionPmsCohortReadiness.js";

const ready = (propertyId: string, lifecycleStatus: string, missing: string[] = []) =>
  ({
    propertyId,
    lifecycleStatus,
    ...Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g", "complete"].map((key) => [key, !missing.includes(key)]),
    ),
  }) as CohortReadiness;

describe("production PMS cohort activation", () => {
  it("is ready only with a complete profile and every criterion a-g", () => {
    expect(readyForActivation(ready("p1", "provisioning"))).toBe(true);
    for (const missing of ["a", "b", "c", "d", "e", "f", "g", "complete"])
      expect(readyForActivation(ready("p1", "provisioning", [missing]))).toBe(false);
  });

  it("counts active and provisioning cohort properties and what provisioning ones miss", () => {
    expect(
      summarizeCohortReadiness([
        ready("p1", "active", ["b"]), // an owner switched auto-open off after go-live
        ready("p2", "provisioning", ["c", "f"]),
        ready("p3", "provisioning", ["c"]),
        ready("p4", "suspended", ["a"]),
      ]),
    ).toEqual({
      cohortProperties: 4,
      active: 1,
      provisioning: 2,
      missing: { a: 0, b: 0, c: 2, d: 0, e: 0, f: 1, g: 0, complete: 0 },
    });
  });

  it("activates only carried cohort properties, and none without a cohort", () => {
    const hotel = (index: number) => `10000000-0000-4000-a000-00000000000${index}`;
    const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
      sourceDatabase: "pms",
      sourceTable,
      rowOrdinal: 1,
      data: { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...data },
    });
    const plan = (pmsHotelIds: string[] | null) =>
      buildProductionPmsPlan({
        sourceRunId: "run",
        snapshotAt: "2026-10-09T00:00:00.000Z",
        completedAt: "2026-10-09T00:00:00.000Z",
        rows: [1, 2, 3].map((index) => row("hotels", { id: hotel(index), timezone: "UTC" })),
        cohort: pmsHotelIds && { bookingHotelIds: [], pmsHotelIds, marketplaceHotelIds: [] },
        target: {
          // 1 cohort, 2 outside the cohort, 3 cohort in private quarantine.
          propertyLinks: [1, 2, 3].map((index) => ({
            sourceId: hotel(index),
            propertyId: `20000000-0000-4000-a000-00000000000${index}`,
            relationship: "operational_input",
            status: "active",
            migrationRunId: "run",
            migrationDisposition: index === 3 ? "private_quarantine" : "canonical",
            ownerStatus: "active",
          })),
          bookings: [],
          userIds: [],
          mediaIds: [],
          records: [],
          provenance: [],
        },
      });
    expect(plan([hotel(1), hotel(3)]).cohortPropertyIds).toEqual([
      "20000000-0000-4000-a000-000000000001",
    ]);
    expect(plan(null)).not.toHaveProperty("cohortPropertyIds");
  });

  it("locks cohort properties before writing and activates only after verification", async () => {
    const sql: string[] = [];
    const calls: string[] = [];
    const client = {
      async query(text: string) {
        sql.push(text);
        return { rows: [], rowCount: 0 };
      },
    };
    const plan = (writes: boolean) => ({
      sourceRunId: "run",
      checksum: "c".repeat(64),
      cohortPropertyIds: ["p1"],
      records: [],
      writes: writes ? [{ targetTable: "room_types" }] : [],
      provenance: [],
      blockers: [],
      parity: {},
      counts: {},
    });
    let builds = 0;
    const report = await runProductionPmsTransaction(
      client as never,
      { sourceRunId: "run", mode: "apply" },
      {
        readSnapshot: async () => ({ rows: [], snapshotAt: "x", completedAt: "y", cohort: null }),
        readPrerequisites: async () => ({
          propertyLinks: [],
          bookings: [],
          userIds: [],
          mediaIds: [],
        }),
        readTarget: async () => ({}) as never,
        buildPlan: () => (++builds === 3 ? plan(false) : plan(true)) as never,
        writeRecords: async () => {
          calls.push("write");
          sql.push("write");
          return { room_types: 1 };
        },
        writeProvenance: async () => 0,
        activateCohort: async (_client, input) => {
          calls.push(`activate:${input.propertyIds.join()}`);
          return {
            cohortProperties: 1,
            active: 1,
            provisioning: 0,
            activated: 1,
            missing: {} as never,
          };
        },
      },
    );
    expect(calls).toEqual(["write", "activate:p1"]);
    const lock = sql.findIndex((text) => text.includes("FOR NO KEY UPDATE"));
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sql.indexOf("write"));
    expect(report.activation).toMatchObject({ activated: 1 });
  });

  it("evaluates the producer's room and pricing gates as the native scheduler does", async () => {
    const scheduler = await readFile(
      join(import.meta.dirname, "../../../apps/api/src/jobs/pmsChannexScheduler.ts"),
      "utf8",
    );
    expect(scheduler.replace(/\s+/g, " ")).toContain(
      "physical_room.status<>'retired' AND ( physical_room.operational_label_status<>'verified' OR physical_room.room_number IS NULL )",
    );
    const worker = await readFile(
      join(import.meta.dirname, "../../../apps/api/src/jobs/pmsCalendarAutoOpenWorker.ts"),
      "utf8",
    );
    expect(worker.replace(/\s+/g, " ")).toContain(
      "pricing.pricingCurrencyRevision === null || pricing.optionalPricingAggregateRevision === null",
    );
    expect(COHORT_READINESS_SQL).toContain(
      "(room.operational_label_status <> 'verified' OR room.room_number IS NULL)",
    );
    const lifecycle = await readFile(
      join(import.meta.dirname, "../../domain-hotels/src/platformPropertyLifecycle.ts"),
      "utf8",
    );
    expect(lifecycle.replace(/\s+/g, " ")).toContain(
      `PLATFORM_PROPERTY_LIFECYCLE_CONTRACT_VERSION = "${LIFECYCLE_CONTRACT_VERSION}"`,
    );
  });
});
