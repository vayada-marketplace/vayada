import { describe, expect, it } from "vitest";

import {
  createPgPmsPricingReadModel,
  type PmsPricingReadClient,
  type PmsPricingReadPool,
} from "./domains/pmsPricingReadModel.js";

const propertyId = "30000000-0000-4000-8000-000000000001";
const roomTypeId = "40000000-0000-4000-8000-000000000001";
const planId = "50000000-0000-4000-8000-000000000001";
const now = "2026-08-03T12:00:00.000Z";

function currencyRow() {
  return {
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: "2",
    createdAt: now,
    updatedAt: now,
  };
}

function planRow(overrides: Partial<{ amountDecimal: string; roomTypeId: string }> = {}) {
  return {
    propertyId,
    roomTypeId: overrides.roomTypeId ?? roomTypeId,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: "3",
    sourceRoomFactsRevision: "4",
    amountDecimal: overrides.amountDecimal ?? "1234567890123.45",
    currency: "EUR",
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function fakePool(
  overrides: { amountDecimal?: string; published?: unknown[]; closedRoomIds?: string[] } = {},
) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const rawQuery = async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values });
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT 1 FROM pms.pricing_v2_heads")) {
      const rows = overrides.published ? [{ "?column?": 1 }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT room_type_id::text")) {
      const rows = (overrides.closedRoomIds ?? []).map((id) => ({ roomTypeId: id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM pms.pricing_v2_heads head")) {
      const rows = overrides.published ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("WITH pricing_currency")) {
      return {
        rows: [
          {
            pricingCurrency: currencyRow(),
            flexibleRatePlans: [planRow({ amountDecimal: overrides.amountDecimal })],
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM pms.property_pricing_settings")) {
      return { rows: [currencyRow()], rowCount: 1 };
    }
    if (sql.includes("FROM pms.rate_plans")) {
      return {
        rows: [planRow({ amountDecimal: overrides.amountDecimal })],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected pricing read query: ${sql}`);
  };
  const query = rawQuery as PmsPricingReadPool["query"];
  const client: PmsPricingReadClient = { query, release() {} };
  const pool: PmsPricingReadPool = {
    query,
    async connect() {
      return client;
    },
  };
  return { pool, calls };
}

describe("PMS pricing read model", () => {
  it("captures currency and plans in one repeatable-read transaction", async () => {
    const { pool, calls } = fakePool();
    const read = createPgPmsPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });

    await expect(read.getPricingSourceSnapshot(propertyId)).resolves.toMatchObject({
      propertyId,
      pricingCurrency: { pricingCurrencyRevision: 2 },
      flexibleRatePlans: [{ flexibleRatePlanRevision: 3 }],
      capturedAt: now,
    });
    expect(calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.filter(({ sql }) => sql.includes("WITH pricing_currency"))).toHaveLength(1);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("reads flexible plans from the publication once the property has one", async () => {
    const closedRoom = "40000000-0000-4000-8000-000000000002";
    const published = (roomType: string) => ({
      roomTypeId: roomType,
      currency: "EUR",
      sourceRoomFactsRevision: "4",
      pricingRevision: 9,
      publishedAt: now,
      offer: {
        id: planId,
        meal: { kind: "room_only" },
        price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "16000" } } },
      },
      terms: { cancellation: { kind: "flexible", terms: planRow().cancellationTerms } },
    });
    const { pool, calls } = fakePool({
      published: [published(roomTypeId), published(closedRoom)],
      closedRoomIds: [closedRoom],
    });
    const read = createPgPmsPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });

    const snapshot = await read.getPricingSourceSnapshot(propertyId);
    expect(snapshot?.flexibleRatePlans).toEqual([
      expect.objectContaining({
        roomTypeId,
        flexibleRatePlanRevision: 9,
        baseAmount: { amountDecimal: "160.00", currency: "EUR" },
      }),
    ]);
    // A published offer in another currency than the property's is a missing plan.
    const other = fakePool({ published: [{ ...published(roomTypeId), currency: "CHF" }] });
    const otherRead = createPgPmsPricingReadModel({
      connectionString: "test",
      pool: other.pool,
      now: () => new Date(now),
    });
    expect((await otherRead.getPricingSourceSnapshot(propertyId))?.flexibleRatePlans).toEqual([]);
    // Every read shares the snapshot's repeatable-read transaction.
    expect(calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("fails closed and rolls back malformed database money", async () => {
    const { pool, calls } = fakePool({ amountDecimal: "12.345" });
    const read = createPgPmsPricingReadModel({
      connectionString: "test",
      pool,
      now: () => new Date(now),
    });

    await expect(read.getPricingSourceSnapshot(propertyId)).rejects.toThrow(
      "PMS flexible pricing plan row failed contract validation",
    );
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

describe("published flexible rate plans", () => {
  const flexibleTerms = {
    type: "free_until_days_before_arrival",
    freeCancellationDeadlineDays: 7,
    afterDeadlinePenalty: "full_booking_amount",
    noShowPenalty: "full_booking_amount",
  };
  const offer = (id: string, base: unknown, meal = "room_only", kind = "independent") =>
    kind === "independent"
      ? { id, meal: { kind: meal }, price: { kind, calendar: { base } } }
      : { id, meal: { kind: meal }, price: { kind, parentId: planId } };
  const row = (roomType: string, published: unknown, cancellation: unknown, currency = "EUR") => ({
    roomTypeId: roomType,
    currency,
    sourceRoomFactsRevision: "4",
    pricingRevision: 7,
    publishedAt: now,
    offer: published,
    terms: { cancellation },
  });
  function model(rows: unknown[]) {
    const pool: PmsPricingReadPool = {
      async query(text: string) {
        expect(text).toContain("pms.pricing_v2_heads");
        return { rows, rowCount: rows.length } as never;
      },
      async connect() {
        throw new Error("plan reads need no transaction");
      },
    };
    return createPgPmsPricingReadModel({ connectionString: "unused", pool });
  }

  it("maps the first refundable independent offer of each room", async () => {
    const otherRoom = "40000000-0000-4000-8000-000000000002";
    const read = model([
      // Non-refundable and linked offers are not the room's flexible plan.
      row(
        roomTypeId,
        offer("60000000-0000-4000-8000-000000000001", { mode: "flat", amountMinor: "9000" }),
        { kind: "non_refundable" },
      ),
      row(roomTypeId, offer("60000000-0000-4000-8000-000000000002", null, "room_only", "linked"), {
        kind: "flexible",
        terms: flexibleTerms,
      }),
      row(
        roomTypeId,
        offer(planId, { mode: "occupancy", amountsMinor: ["12550", "15000"] }, "half_board"),
        { kind: "flexible", terms: flexibleTerms },
      ),
      row(
        otherRoom,
        offer(
          "60000000-0000-4000-8000-000000000003",
          { mode: "per_person", unitMinor: "8000" },
          "breakfast",
        ),
        { kind: "flexible", terms: flexibleTerms },
        "JPY",
      ),
    ]);
    const plans = await read.listFlexibleRatePlans(propertyId);
    expect(plans).toEqual([
      {
        contractVersion: "pms-pricing.v1",
        propertyId,
        roomTypeId,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: 7,
        sourceRoomFactsRevision: 4,
        baseAmount: { amountDecimal: "125.50", currency: "EUR" },
        cancellationTerms: flexibleTerms,
        createdAt: now,
        updatedAt: now,
      },
      expect.objectContaining({
        roomTypeId: otherRoom,
        mealPlan: "breakfast",
        baseAmount: { amountDecimal: "8000.00", currency: "JPY" },
      }),
    ]);
    expect(await read.getFlexibleRatePlan(propertyId, otherRoom)).toMatchObject({
      roomTypeId: otherRoom,
    });
  });

  it("has no plan for unpublished rooms, missing base prices or non-UUID offer ids", async () => {
    const read = model([
      row(roomTypeId, offer("flex", { mode: "flat", amountMinor: "10000" }), {
        kind: "flexible",
        terms: flexibleTerms,
      }),
      row(roomTypeId, offer(planId, null), { kind: "flexible", terms: flexibleTerms }),
    ]);
    expect(await read.listFlexibleRatePlans(propertyId)).toEqual([]);
    expect(await read.getFlexibleRatePlan(propertyId, roomTypeId)).toBeNull();
  });
});
