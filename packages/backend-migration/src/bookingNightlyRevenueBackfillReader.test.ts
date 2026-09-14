import { describe, expect, it } from "vitest";

import { planNightlyRevenueBackfill } from "./bookingNightlyRevenueBackfill.js";
import { readUncapturedNightlyRevenueCandidates } from "./bookingNightlyRevenueBackfillReader.js";

const PROPERTY = "00000000-0000-4000-8000-000000000010";
const ROOM_A = "00000000-0000-4000-8000-000000000020";
const ROOM_B = "00000000-0000-4000-8000-000000000021";
const CURSOR = "00000000-0000-4000-8000-000000000000";
const ids = [1, 2, 3, 4].map(
  (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`,
);

describe("nightly revenue backfill reader", () => {
  it("pages uncaptured bookings and uses only retained booking and assignment evidence", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, values: readonly unknown[]) {
        calls.push({ sql, values });
        return { rows: bookings() };
      },
    };
    const page = await readUncapturedNightlyRevenueCandidates(client as never, {
      afterGuestBookingId: CURSOR,
      limit: 4,
    });

    expect(page.nextGuestBookingId).toBe(ids[3]);
    expect(page.candidates.map(({ sourceKind }) => sourceKind)).toEqual([
      "direct",
      "ota",
      "manual",
      "migration",
    ]);
    expect(page.candidates[0]).toMatchObject({
      roomCount: 2,
      assignments: [{ roomTypeId: ROOM_A }, { roomTypeId: ROOM_B }],
      retainedEvidence: { currency: "EUR", exactNightly: expect.any(Array) },
    });
    expect(page.candidates[0]!.retainedEvidence.exactNightly).toHaveLength(4);
    expect(page.candidates[1]!.retainedEvidence).toEqual({ currency: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([CURSOR, 4]);
    expect(calls[0]!.sql).toContain("$1::uuid IS NULL OR booking.id>$1::uuid");
    expect(calls.map(({ sql }) => sql).join(" ")).not.toMatch(/rate_plan|pricing|external|fetch/i);

    const plan = planNightlyRevenueBackfill(page.candidates, {
      allowInferredEqualAllocation: true,
    });
    expect(plan.lines.filter(({ evidenceQuality }) => evidenceQuality === "exact")).toHaveLength(4);
    expect(plan.exceptions.map(({ code }) => code)).toEqual([
      "missing_evidence",
      "missing_evidence",
      "invalid_booking_scope",
    ]);
  });

  it("rejects misaligned mixed-room evidence instead of assigning it to another room type", async () => {
    const direct = structuredClone(bookings()[0]!);
    const metadata = direct.bookingMetadata as {
      selectedOffer: { roomLines: Array<{ publicOfferKey: string }> };
    };
    metadata.selectedOffer.roomLines[1]!.publicOfferKey = "wrong-offer";
    const client = { query: async () => ({ rows: [direct] }) };
    const page = await readUncapturedNightlyRevenueCandidates(client as never);

    expect(page.candidates[0]).toMatchObject({ assignments: [], retainedEvidence: {} });
    expect(page.candidates[0]!.retainedEvidence).toEqual({ currency: null });
  });

  it("validates bounded page sizes and returns an empty page with one query", async () => {
    let calls = 0;
    const client = { query: async () => (calls++, { rows: [] }) };
    await expect(
      readUncapturedNightlyRevenueCandidates(client as never, { limit: 0 }),
    ).rejects.toThrow("Invalid page limit");
    expect(await readUncapturedNightlyRevenueCandidates(client as never)).toEqual({
      candidates: [],
      nextGuestBookingId: null,
    });
    expect(calls).toBe(1);
  });
});

function bookings() {
  const base = {
    propertyId: PROPERTY,
    checkIn: "2026-09-14",
    checkOut: "2026-09-16",
    roomCount: 1,
    currency: "EUR",
    lifecycleStatus: "confirmed",
    bookingMetadata: {},
    quoteCurrency: null,
    quoteSnapshot: {},
    assignments: [],
  };
  return [
    {
      ...base,
      guestBookingId: ids[0],
      roomCount: 2,
      sourceSystem: "booking",
      bookingChannel: "direct",
      quoteCurrency: "EUR",
      bookingMetadata: {
        selectedOffer: {
          roomSelection: {
            contractVersion: "booking-room-selection.v1",
            lines: [
              line(ROOM_A, "offer-a", 1, [night("2026-09-14", "100"), night("2026-09-15", 110)]),
              line(ROOM_B, "offer-b", 1, [night("2026-09-14", "120"), night("2026-09-15", 130)]),
            ],
          },
          roomLines: [
            line(ROOM_A, "offer-a", 1, [night("2026-09-14", "100"), night("2026-09-15", 110)]),
            line(ROOM_B, "offer-b", 1, [night("2026-09-14", "120"), night("2026-09-15", 130)]),
          ],
        },
      },
    },
    {
      ...base,
      guestBookingId: ids[1],
      sourceSystem: "pms",
      bookingChannel: "booking_com",
      assignments: [assignment(ROOM_A, "exact")],
    },
    {
      ...base,
      guestBookingId: ids[2],
      sourceSystem: "pms",
      bookingChannel: "direct",
      bookingMetadata: { contractVersion: "pms-manual-booking.v1" },
      assignments: [assignment(ROOM_A, "exact")],
    },
    {
      ...base,
      guestBookingId: ids[3],
      sourceSystem: "migration",
      bookingChannel: "unknown",
      bookingMetadata: { contractVersion: "pms-manual-booking.v1" },
      assignments: [assignment(ROOM_B, "summary_only")],
    },
  ];
}

function assignment(roomTypeId: string, stayEvidenceKind: "exact" | "summary_only") {
  return {
    position: 1,
    roomTypeId,
    stayEvidenceKind,
    checkIn: stayEvidenceKind === "exact" ? "2026-09-14" : null,
    checkOut: stayEvidenceKind === "exact" ? "2026-09-16" : null,
  };
}

const line = (
  roomTypeId: string,
  publicOfferKey: string,
  rooms: number,
  nightlyRoomAmounts: Array<ReturnType<typeof night>>,
) => ({
  roomTypeId,
  publicOfferKey,
  guests: Array.from({ length: rooms }, () => ({ adults: 2, children: 0 })),
  offer: { nightlyRoomAmounts },
});

const night = (stayDate: string, grossRoomAmount: string | number) => ({
  stayDate,
  grossRoomAmount,
});
