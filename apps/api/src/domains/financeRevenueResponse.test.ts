import { describe, expect, it } from "vitest";

// prettier-ignore
import { composeFinanceRevenueResponse, type FinanceRevenueResponseInput } from "./financeRevenueResponse.js";

const ROOM = "11280000-0000-4000-8000-000000000010";
const ROOM_TWO = "11280000-0000-4000-8000-000000000011";
const ROOM_THREE = "11280000-0000-4000-8000-000000000012";

describe("Finance Revenue response", () => {
  it("composes decimal-safe metrics and stable breakdowns without private identities", () => {
    const result = composeFinanceRevenueResponse(input());
    expect(result).toMatchObject({
      contractVersion: "pms-financials.v1",
      propertyId: "11280000-0000-4000-8000-000000000001",
      currency: "EUR",
      timeZone: "Europe/Berlin",
      generatedAt: "2026-08-04T14:00:00.000Z",
      sourceFreshness: {
        pmsPricing: "2026-08-04T09:00:00.000Z",
        bookingRevenueThrough: "2026-08-03",
        bookingAddonRevenueThrough: "2026-08-03",
        bookingAddonRevenueAt: "2026-08-04T13:00:00.000Z",
      },
      summary: {
        grossRoom: metric("350.0000", "270.0000", "3.3750"),
        otaCommission: metric("30.0000", "30.0000", null),
        netRoom: metric("320.0000", "240.0000", "3.0000"),
        upsell: metric("25.0000", "15.0000", "1.5000"),
        nights: { value: 4, absoluteChange: 3, percentChange: "3.0000" },
        adr: metric("87.5000", "7.5000", "0.0938"),
        attachRate: { value: "0.6667", absoluteChange: "-0.3333", percentChange: "-0.3333" },
      },
    });
    expect(result.channels).toEqual([
      channel("booking_com", "200.0000", "30.0000", "170.0000", "0.5714"),
      channel("direct", "100.0000", "0.0000", "100.0000", "0.2857"),
      channel("unknown", "50.0000", "0.0000", "50.0000", "0.1429"),
    ]);
    expect(result.directSources).toEqual([
      { source: "email", revenue: money("100.0000"), share: "1.0000" },
    ]);
    expect(result.upsells).toEqual([
      { ownership: "property", revenue: money("20.0000") },
      { ownership: "partner", revenue: money("5.0000") },
    ]);
    expect(result.roomTypes).toEqual([
      { roomTypeId: ROOM, nights: 3, revenue: money("300.0000"), adr: money("100.0000") },
      { roomTypeId: ROOM_TWO, nights: 1, revenue: money("50.0000"), adr: money("50.0000") },
    ]);
    expect(result.incompleteEvidence).toEqual([
      { code: "ota_commission_missing", count: 1 },
      {
        code: "room_revenue_currency_mismatch",
        count: 1,
        amount: { amount: "9.0000", currency: "USD" },
      },
      { code: "addon_fulfillment_missing", count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/guest|bookingId|provider|secret/i);
  });

  it("returns a successful zero state and rejects an impossible attach numerator", () => {
    const empty = input();
    empty.rooms.rows = [];
    empty.rooms.eligibleBookings = { current: 0, comparison: 0 };
    empty.rooms.incompleteEvidence = [];
    empty.addOns.rows = [];
    empty.addOns.fulfilledBookings = { current: 0, comparison: 0 };
    empty.addOns.incompleteEvidence = [];
    const result = composeFinanceRevenueResponse(empty);
    expect(result.summary.grossRoom).toEqual(metric("0.0000", "0.0000", null));
    expect(result.summary.attachRate).toEqual({
      value: "0.0000",
      absoluteChange: "0.0000",
      percentChange: null,
    });
    expect(result.channels).toEqual([]);
    expect(result.roomTypes).toEqual([]);

    empty.addOns.fulfilledBookings.current = 1;
    expect(() => composeFinanceRevenueResponse(empty)).toThrow(
      "Finance reporting ratio is invalid",
    );
  });

  it("bounds correction shares, clamps reversal nights, and retains mismatch currency", () => {
    const correction = input();
    correction.rooms.rows = [
      room("current", "booking_com", null, ROOM, "100", "0", 1),
      room("current", "direct", "email", ROOM_THREE, "50", "0", 1),
      room("current", "direct", "walk_in", ROOM_TWO, "-200", "0", -2),
      room("comparison", "direct", "email", ROOM_TWO, "-50", "0", -1),
    ];
    correction.rooms.incompleteEvidence = [
      { code: "room_revenue_currency_mismatch", count: 1, currency: "USD" },
    ];
    const result = composeFinanceRevenueResponse(correction);
    expect(result.summary.nights).toEqual({ value: 0, absoluteChange: 0, percentChange: null });
    expect(result.summary.adr.value).toEqual(money("0.0000"));
    expect(result.channels.map(({ channel, share }) => [channel, share])).toEqual([
      ["booking_com", "1.0000"],
      ["direct", "0.0000"],
    ]);
    expect(result.directSources.map(({ source, share }) => [source, share])).toEqual([
      ["email", "1.0000"],
      ["walk_in", "0.0000"],
    ]);
    expect(result.roomTypes).toEqual([]);
    expect(result.incompleteEvidence).toEqual(
      expect.arrayContaining([
        { code: "room_revenue_currency_mismatch", count: 1, currency: "USD" },
        { code: "room_type_occupancy_unavailable", count: 1 },
      ]),
    );
  });

  it("excludes explicitly missing room prices from ADR without hiding occupied nights", () => {
    const missing = input();
    missing.rooms.rows = [
      room("current", "direct", "email", ROOM, "100", "0", 1),
      room("current", "booking_com", null, ROOM, "0", "0", 1, 0),
    ];
    missing.rooms.incompleteEvidence = [{ code: "room_revenue_missing", count: 1 }];

    const result = composeFinanceRevenueResponse(missing);

    expect(result.summary.nights.value).toBe(2);
    expect(result.summary.adr.value).toEqual(money("100.0000"));
    expect(result.roomTypes).toEqual([
      { roomTypeId: ROOM, nights: 2, revenue: money("100.0000"), adr: money("100.0000") },
    ]);
    expect(result.incompleteEvidence).toContainEqual({ code: "room_revenue_missing", count: 1 });
  });
});

function input(): FinanceRevenueResponseInput {
  return {
    propertyId: "11280000-0000-4000-8000-000000000001",
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: "2026-08-04T14:00:00Z",
    sourceFreshness: { pmsPricing: "2026-08-04T09:00:00.000Z" },
    rooms: {
      rows: [
        room("current", "direct", "email", ROOM, "100", "0", 1),
        room("current", "booking_com", null, ROOM, "200", "30", 2),
        room("current", "unknown", null, ROOM_TWO, "50", "0", 1),
        room("comparison", "direct", "email", ROOM, "80", "0", 1),
      ],
      eligibleBookings: { current: 3, comparison: 1 },
      sourceFreshness: { bookingRevenueThrough: "2026-08-03", financeOtaCommissionAt: null },
      incompleteEvidence: [
        { code: "ota_commission_missing", count: 1 },
        {
          code: "room_revenue_currency_mismatch",
          count: 1,
          currency: "USD",
          amount: { amount: "9.0000", currency: "USD" },
        },
      ],
    },
    addOns: {
      rows: [
        {
          period: "current",
          recognizedOn: "2026-08-01",
          ownership: "property",
          revenueAmount: "20",
        },
        { period: "current", recognizedOn: "2026-08-01", ownership: "partner", revenueAmount: "5" },
        {
          period: "comparison",
          recognizedOn: "2026-07-31",
          ownership: "property",
          revenueAmount: "10",
        },
      ],
      fulfilledBookings: { current: 2, comparison: 1 },
      sourceFreshness: {
        bookingAddonRevenueThrough: "2026-08-03",
        bookingAddonRevenueAt: "2026-08-04T13:00:00.000Z",
      },
      incompleteEvidence: [{ code: "addon_fulfillment_missing", count: 2 }],
    },
  };
}

// prettier-ignore
const room = (period: "current" | "comparison", channel: string, directSource: string | null, roomTypeId: string, grossRoomAmount: string, otaCommissionAmount: string, occupiedRoomNights: number, pricedOccupiedRoomNights = occupiedRoomNights) => ({ period, recognizedOn: period === "current" ? "2026-08-01" : "2026-07-31", channel, directSource, roomTypeId, grossRoomAmount, otaCommissionAmount, occupiedRoomNights, pricedOccupiedRoomNights });
const money = (amount: string) => ({ amount, currency: "EUR" });
// prettier-ignore
const metric = (value: string, change: string, percentChange: string | null) => ({ value: money(value), absoluteChange: money(change), percentChange });
// prettier-ignore
const channel = (name: string, gross: string, commission: string, net: string, share: string) => ({ channel: name, gross: money(gross), commission: money(commission), net: money(net), share });
