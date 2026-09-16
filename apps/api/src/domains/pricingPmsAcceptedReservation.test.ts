import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptanceFixture } from "./pricingAcceptanceHistory.fixtures.js";
import { decodePricingAcceptanceHistory } from "./pricingAcceptanceHistory.js";
import { projectAcceptedPricingReservation } from "./pricingPmsAcceptedReservation.js";

const decoded = () => {
  const row = acceptanceFixture();
  return decodePricingAcceptanceHistory(row, row.property_id, row.organization_id)!;
};

describe("accepted pricing PMS projection", () => {
  it("preserves physical selection order, repeated room types and exact child ages", () => {
    const original = decoded();
    const secondReceipt = {
      ...original.reservation.receipts[0]!,
      receiptId: randomUUID(),
    };
    const firstReceipt = original.reservation.receipts[0]!;
    const sourceReceipt = {
      contractVersion: firstReceipt.contractVersion,
      owner: firstReceipt.owner,
      receiptId: firstReceipt.receiptId,
    };
    const sourceAges = [8];
    const rooms = [
      {
        ...original.quote.stay.rooms[0]!,
        guests: { adults: 2, childAgesAtCheckIn: sourceAges },
      },
      {
        ...original.quote.stay.rooms[0]!,
        selectionId: "two",
        guests: { adults: 1, childAgesAtCheckIn: [0, 17] },
      },
      {
        ...original.quote.stay.rooms[0]!,
        selectionId: "three",
        roomTypeId: randomUUID(),
        offerId: "opaque-offer",
        guests: { adults: 3, childAgesAtCheckIn: [4] },
      },
    ];
    const history = {
      ...original,
      quote: { ...original.quote, stay: { ...original.quote.stay, rooms } },
      reservation: {
        ...original.reservation,
        receipts: [sourceReceipt, secondReceipt],
      },
    };

    const result = projectAcceptedPricingReservation(history)!;

    expect(result).toEqual({
      contractVersion: "pms-accepted-pricing-reservation.v1",
      acceptanceId: original.id,
      pricingQuoteId: original.quote.quoteId,
      guestBookingId: original.bookingId,
      propertyId: original.propertyId,
      organizationId: original.organizationId,
      acceptedAt: original.acceptedAt,
      stay: {
        checkIn: original.quote.stay.checkIn,
        checkOut: original.quote.stay.checkOut,
      },
      inventoryReservation: history.reservation,
      rooms: [
        {
          position: 1,
          selectionId: "one",
          roomTypeId: rooms[0]!.roomTypeId,
          offerId: "flex",
          adults: 2,
          childAgesAtCheckIn: [8],
        },
        {
          position: 2,
          selectionId: "two",
          roomTypeId: rooms[0]!.roomTypeId,
          offerId: "flex",
          adults: 1,
          childAgesAtCheckIn: [0, 17],
        },
        {
          position: 3,
          selectionId: "three",
          roomTypeId: rooms[2]!.roomTypeId,
          offerId: "opaque-offer",
          adults: 3,
          childAgesAtCheckIn: [4],
        },
      ],
    });
    sourceReceipt.receiptId = randomUUID();
    sourceAges[0] = 9;
    expect(result.inventoryReservation.receipts[0]!.receiptId).toBe(
      original.reservation.receipts[0]!.receiptId,
    );
    expect(result.rooms[0]!.childAgesAtCheckIn).toEqual([8]);
  });

  it("requires one receipt for every distinct accepted room type", () => {
    const history = decoded();
    const differentType = {
      ...history.quote.stay.rooms[0]!,
      selectionId: "two",
      roomTypeId: randomUUID(),
    };
    expect(
      projectAcceptedPricingReservation({
        ...history,
        quote: {
          ...history.quote,
          stay: { ...history.quote.stay, rooms: [...history.quote.stay.rooms, differentType] },
        },
      }),
    ).toBeNull();
    expect(
      projectAcceptedPricingReservation({
        ...history,
        reservation: {
          ...history.reservation,
          receipts: [
            ...history.reservation.receipts,
            { ...history.reservation.receipts[0]!, receiptId: randomUUID() },
          ],
        },
      }),
    ).toBeNull();
  });
});
