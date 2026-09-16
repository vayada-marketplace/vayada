import { describe, expect, it, vi } from "vitest";

import type { NightlyRevenueBackfillLine } from "./bookingNightlyRevenueBackfill.js";
import { verifyAppliedNightlyRevenueBackfillPage } from "./bookingNightlyRevenueBackfillVerification.js";

const BOOKING = "11810000-0000-4000-8000-000000000001";
const PROPERTY = "11810000-0000-4000-8000-000000000002";
const ROOM = "11810000-0000-4000-8000-000000000003";

describe("nightly revenue backfill target verification", () => {
  it("reconciles effective room nights, immutable rows, and source revisions", async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          stored({ stayDate: "2026-09-14", storedRows: 2, sourceRevisions: [1, 2] }),
          stored({ stayDate: "2026-09-15" }),
        ],
      })),
    };
    const verification = await verifyAppliedNightlyRevenueBackfillPage(client as never, [
      line({ stayDate: "2026-09-15" }),
      line({ stayDate: "2026-09-14" }),
    ]);
    expect(verification).toEqual({
      lineCount: 2,
      storedRows: 3,
      revisionCount: 2,
      reconciliation: [
        {
          propertyId: PROPERTY,
          stayDate: "2026-09-14",
          currency: "EUR",
          sourceKind: "direct",
          evidenceQuality: "exact",
          bookingCount: 1,
          roomNightCount: 1,
          revisionCount: 2,
          storedRows: 2,
          occupiedRoomNights: 1,
          grossRoomAmount: "12.0000",
          missingRoomNights: 0,
        },
        {
          propertyId: PROPERTY,
          stayDate: "2026-09-15",
          currency: "EUR",
          sourceKind: "direct",
          evidenceQuality: "exact",
          bookingCount: 1,
          roomNightCount: 1,
          revisionCount: 1,
          storedRows: 1,
          occupiedRoomNights: 1,
          grossRoomAmount: "12.0000",
          missingRoomNights: 0,
        },
      ],
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SUM(gross_room_amount)"), [
      [BOOKING],
    ]);
  });

  it("blocks commit when effective ledger state differs from the page plan", async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [stored({ grossRoomAmount: "11.0000" })],
      })),
    };
    await expect(
      verifyAppliedNightlyRevenueBackfillPage(client as never, [line()]),
    ).rejects.toThrow("does not match the page plan");
  });
});

function line(overrides: Partial<NightlyRevenueBackfillLine> = {}): NightlyRevenueBackfillLine {
  return {
    propertyId: PROPERTY,
    guestBookingId: BOOKING,
    roomTypeId: ROOM,
    stayDate: "2026-09-14",
    currency: "EUR",
    grossRoomAmount: "12.0000",
    linePosition: 1,
    lifecycleState: "confirmed",
    sourceKind: "direct",
    evidenceQuality: "exact",
    evidenceFingerprint: "a".repeat(64),
    ...overrides,
  };
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PROPERTY,
    guestBookingId: BOOKING,
    roomTypeId: ROOM,
    stayDate: "2026-09-14",
    currency: "EUR",
    grossRoomAmount: "12.0000",
    linePosition: 1,
    sourceKind: "direct",
    evidenceQuality: "exact",
    occupiedRoomNights: 1,
    storedRows: 1,
    sourceRevisions: [1],
    ...overrides,
  };
}
