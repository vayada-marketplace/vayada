import { expect, it, vi } from "vitest";
import { loadBookingOtaRevenueLedger } from "./bookingOtaRevenueLedger.js";

it.each(["101", "102"])(
  "requires the booking lock transaction to survive all reads (tx %s)",
  async (id) => {
    const line = {
      evidenceId: "82000000-0000-4000-8000-000000000001",
      roomTypeId: "82000000-0000-4000-8000-000000000002",
      stayDate: "2026-09-01",
      recognizedOn: "2026-09-01",
      linePosition: 1,
      occupiedRoomNights: 1,
      grossRoomAmount: "100.0000",
      evidenceQuality: "exact",
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { transactionId: "101", checkIn: "2026-09-01", checkOut: "2026-09-02", roomCount: 1 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ ...line, supported: true }] })
      .mockResolvedValueOnce({ rows: [{ id }] });
    const result = loadBookingOtaRevenueLedger(
      { query },
      {
        propertyId: "82000000-0000-4000-8000-000000000003",
        bookingId: "82000000-0000-4000-8000-000000000004",
        sourceBookingReference: "channex:test:booking",
        currency: "EUR",
      },
    );
    if (id === "101") await expect(result).resolves.toEqual([line]);
    else await expect(result).rejects.toThrow("alteration_revenue_ledger_unavailable");
  },
);
