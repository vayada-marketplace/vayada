import { describe, expect, it, vi } from "vitest";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { createPgChannexManagementPlanPort } from "./channexManagementPlans.js";

describe("target Channex management plans", () => {
  it("builds enable and idempotent disable actions from target state", async () => {
    let db = new FakePool("enable");
    let port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const enabled = await port.plan(job("enable"));
    expect(enabled.requests).toMatchObject([
      {
        method: "GET",
        path: "/api/v1/properties",
        capture: { kind: "property_list", title: "Hotel [Vayada:property-1]" },
      },
      {
        method: "POST",
        path: "/api/v1/properties",
        body: { property: { title: "Hotel [Vayada:property-1]" } },
        capture: { kind: "property" },
      },
    ]);
    expect(enabled.checkpoint).toEqual(expect.any(Function));
    await enabled.checkpoint?.({
      ok: true,
      externalPropertyId: "external-1",
      connectionStatus: "connected",
    });
    expect(db.sql()).toContain("hotel_catalog.properties");
    expect(db.sql()).toContain("pms.channel_connections");
    // prettier-ignore
    expect(db.sql()).toMatch(/BEGIN[\s\S]*channel_binding_claims[\s\S]*channel_connections[\s\S]*COMMIT/);

    db = new FakePool("disconnected");
    port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    await expect(port.plan(job("disable"))).resolves.toMatchObject({ requests: [] });
  });

  it("preserves provider identity when truncating long Unicode titles", async () => {
    const db = new FakePool("unicode");
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: db,
      bookingRevisionHandoff: vi.fn(),
    });
    const plan = await port.plan(job("enable"));
    const capture = plan.requests[0]?.capture;
    expect(capture?.kind).toBe("property_list");
    if (capture?.kind !== "property_list") throw new Error("Expected property lookup");
    const { title } = capture;
    expect(Array.from(title)).toHaveLength(255);
    expect(title).toMatch(/\[Vayada:property-1\]$/);
    expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it.each([
    ["historical", "sync_bookings", "Channex binding claim is not active"],
    ["retained", "enable", "A retained Channex binding claim requires audited repair"],
  ] as const)("fails closed for %s binding evidence", async (mode, operation, message) => {
    const port = createPgChannexManagementPlanPort({
      connectionString: "postgresql://target",
      pool: new FakePool(mode),
      bookingRevisionHandoff: vi.fn(),
    });

    await expect(port.plan(job(operation))).rejects.toThrow(message);
  });
});

type Mode =
  | "enable"
  | "unicode"
  | "disconnected"
  | "connected"
  | "historical"
  | "retained"
  | "provision"
  | "multi_room"
  | "ari"
  | "ari_rate_gated"
  | "ari_disabled";
class FakePool {
  private calls: string[] = [];
  constructor(
    private readonly mode: Mode,
    private readonly rateOverrides: Record<string, unknown> = {},
  ) {}
  sql() {
    return this.calls.join("\n");
  }
  async end() {}
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async query<T>(text: string) {
    this.calls.push(text);
    let rows: unknown[] = [];
    if (text.includes("pms.channel_binding_claims")) {
      if (this.mode === "historical")
        rows = [
          {
            externalPropertyId: "external-1",
            claimExternalPropertyId: "external-1",
            claimState: "historical",
          },
        ];
      else if (this.mode === "retained")
        rows = [
          {
            externalPropertyId: null,
            claimExternalPropertyId: "external-1",
            claimState: "historical",
          },
        ];
      else if (!["disconnected", "enable", "unicode"].includes(this.mode))
        rows = [
          {
            externalPropertyId: "external-1",
            claimExternalPropertyId: "external-1",
            claimState: "active",
          },
        ];
      else rows = [{ externalPropertyId: null, claimExternalPropertyId: null, claimState: null }];
    } else if (text.includes("WITH pricing_currency"))
      rows = [
        {
          pricingCurrency: {
            propertyId: pricingPropertyId,
            currency: "EUR",
            pricingCurrencyRevision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          flexibleRatePlans: [
            {
              propertyId: pricingPropertyId,
              roomTypeId: pricingRoomId,
              flexibleRatePlanId: pricingPlanId,
              flexibleRatePlanRevision: 1,
              sourceRoomFactsRevision: 1,
              amountDecimal: Number(this.rateOverrides.rate ?? 100).toFixed(2),
              currency: "EUR",
              cancellationTerms: {
                type: "free_until_days_before_arrival",
                freeCancellationDeadlineDays: 1,
                afterDeadlinePenalty: "full_booking_amount",
                noShowPenalty: "full_booking_amount",
              },
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
      ];
    else if (text.includes("FROM pms.property_pricing_settings"))
      rows = [{ currency: "EUR", pricingCurrencyRevision: 1, optionalPricingAggregateRevision: 0 }];
    else if (text.includes("hotel_catalog.properties"))
      rows = text.includes("same_day_booking_policies")
        ? [
            {
              timezone: "Asia/Makassar",
              enabled: this.mode !== "ari_disabled",
              cutoffLocalTime: "18:00",
            },
          ]
        : [{ title: this.mode === "unicode" ? "😀".repeat(300) : "Hotel", currency: "EUR" }];
    else if (text.includes("count(unit.id)")) {
      rows = [
        {
          roomTypeId: "room-1",
          name: "Deluxe",
          currency: "EUR",
          countOfRooms: 2,
          adults: 1,
          children: 0,
        },
      ];
      if (this.mode === "multi_room") {
        rows.push({ ...rows[0]!, roomTypeId: "room-2" });
      }
    } else if (
      text.includes("FROM pms.rate_plans plan") &&
      (this.mode === "provision" || this.mode === "multi_room")
    ) {
      const rooms =
        this.mode === "multi_room"
          ? [
              { roomTypeId: "room-1", roomTypeName: "Deluxe", ratePlanId: "rate-1" },
              { roomTypeId: "room-2", roomTypeName: "Deluxe", ratePlanId: "rate-2" },
            ]
          : [{ roomTypeId: "room-1", roomTypeName: "Deluxe", ratePlanId: "rate-1" }];
      rows = rooms.flatMap((room) =>
        [
          ["direct", "Standard"],
          ["booking_com", "BDC Standard"],
          ["airbnb", "Airbnb Standard"],
        ].map(([channel, channelLabel]) => ({
          ...room,
          name: "Flexible",
          currency: "EUR",
          sellMode: "per_room",
          baseRate: 100,
          channel,
          channelLabel,
          markupPercent: 0,
          defaultOccupancy: 1,
          externalRoomTypeId: null,
          ...this.rateOverrides,
        })),
      );
    } else if (text.includes("FROM pms.inventory_days"))
      rows = [
        {
          stayDate: this.mode === "ari_disabled" ? "2026-08-15" : "2026-08-14",
          available: this.mode === "ari_rate_gated" ? 0 : 2,
          externalRoomTypeId: "external-room",
          externalRatePlanId: "external-rate",
          roomTypeId: pricingRoomId,
          ratePlanId: pricingPlanId,
          roomFactsRevision: 1,
          planActive: true,
          datePrice: null,
          channel: "airbnb",
          markupPercent: 10,
          ...this.rateOverrides,
        },
      ];
    return { rows: rows as T[] };
  }
}

function job(operationType: ChannexManagementJob["input"]["operationType"]): ChannexManagementJob {
  return {
    jobId: "job-1",
    propertyId: ["sync_ari", "update_markups"].includes(operationType)
      ? pricingPropertyId
      : "property-1",
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "command-1", idempotencyKey: "key-1", operationType },
  };
}

const pricingPropertyId = "15270000-0000-4000-8000-000000000001";
const pricingRoomId = "15270000-0000-4000-8000-000000000002";
const pricingPlanId = "15270000-0000-4000-8000-000000000003";
const timestamp = "2026-08-14T10:00:00Z";
