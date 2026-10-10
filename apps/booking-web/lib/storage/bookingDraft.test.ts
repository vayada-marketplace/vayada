import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
  toConfirmationBooking,
  type BookingConfirmationSource,
} from "./bookingDraft";

describe("checkout idempotency keys", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {});
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rotates a checkout idempotency key once its quote expires", () => {
    const quoteIdentity = "hotel|room-1|card";
    const firstQuoteKey = getCheckoutIdempotencyKey("quote", quoteIdentity);
    expect(getCheckoutIdempotencyKey("quote", quoteIdentity)).toBe(firstQuoteKey);
    expireCheckoutIdempotencyKeyAt("quote", quoteIdentity, "2020-01-01T00:00:00.000Z");
    expect(getCheckoutIdempotencyKey("quote", quoteIdentity)).not.toBe(firstQuoteKey);
  });
});

describe("toConfirmationBooking", () => {
  it("adapts the compact target booking response with checkout display details", () => {
    const booking = toConfirmationBooking(
      {
        guestBookingId: "booking-123",
        bookingReference: "B-ABC123",
        status: "confirmed",
        paymentStatus: "unpaid",
        checkIn: "2026-07-24",
        checkOut: "2026-07-27",
        adults: 2,
        children: 1,
        roomCount: 2,
        currency: "eur",
        totalAmount: 870,
        balanceAmount: 870,
        unitNames: ["Suite 204", "Suite 205"],
        paymentDeadline: "2026-07-23T12:00:00.000Z",
        bankTransferDetails: "IBAN: DE123",
      },
      {
        hotelName: "Codex QA Hotel",
        roomName: "Munich Booking Room",
        guestFirstName: "Ada",
        guestLastName: "Lovelace",
        guestEmail: "ada+booking@example.com",
        paymentMethod: "pay_at_property",
      },
    );

    expect(booking).toMatchObject({
      id: "booking-123",
      bookingReference: "B-ABC123",
      hotelName: "Codex QA Hotel",
      roomName: "Munich Booking Room",
      guestFirstName: "Ada",
      guestLastName: "Lovelace",
      guestEmail: "ada+booking@example.com",
      checkIn: "2026-07-24",
      checkOut: "2026-07-27",
      nights: 3,
      adults: 2,
      children: 1,
      numberOfRooms: 2,
      currency: "EUR",
      totalAmount: 870,
      balanceAmount: 870,
      status: "confirmed",
      paymentMethod: "pay_at_property",
      paymentStatus: "unpaid",
      unitNames: ["Suite 204", "Suite 205"],
      paymentDeadline: "2026-07-23T12:00:00.000Z",
      bankTransferDetails: "IBAN: DE123",
    });
  });

  it("rejects invalid public-response fields and never creates NaN confirmation values", () => {
    const unsafeSource = {
      bookingReference: "B-SAFE",
      status: "run_script",
      paymentMethod: "javascript:alert(1)",
      paymentStatus: "invented",
      checkIn: "not-a-date",
      checkOut: "2026-02-31",
      nights: Number.NaN,
      adults: Number.NaN,
      totalAmount: Number.POSITIVE_INFINITY,
      currency: "eur",
    } as unknown as BookingConfirmationSource;

    const booking = toConfirmationBooking(unsafeSource, {
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      adults: 1,
      totalAmount: 300,
      paymentMethod: "pay_at_property",
    });

    expect(booking).toMatchObject({
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      nights: 2,
      adults: 1,
      totalAmount: 300,
      status: "pending",
      paymentMethod: "pay_at_property",
      paymentStatus: null,
    });
    expect(Number.isNaN(booking.nights)).toBe(false);
    expect(Number.isNaN(booking.totalAmount)).toBe(false);
  });

  it("fails closed for malformed authoritative statuses while preserving safe context fallbacks", () => {
    const unsafeSource = {
      id: " ",
      status: "run_script",
      paymentStatus: "invented",
      depositPercentage: -25,
    } as unknown as BookingConfirmationSource;

    const booking = toConfirmationBooking(unsafeSource, {
      id: "context-booking-123",
      status: "confirmed",
      paymentStatus: "captured",
      depositPercentage: 30,
    });

    expect(booking).toMatchObject({
      id: "context-booking-123",
      status: "pending",
      paymentStatus: null,
      depositPercentage: 30,
    });
  });

  it("uses context statuses only when the public response omits them", () => {
    const booking = toConfirmationBooking(
      {},
      {
        status: "confirmed",
        paymentStatus: "captured",
      },
    );

    expect(booking).toMatchObject({
      status: "confirmed",
      paymentStatus: "captured",
    });
  });

  it("preserves guest-safe manual payment methods", () => {
    expect(toConfirmationBooking({ paymentMethod: "credit_card" }).paymentMethod).toBe(
      "credit_card",
    );
    expect(toConfirmationBooking({ paymentMethod: "manual_card" }).paymentMethod).toBe(
      "manual_card",
    );
    expect(toConfirmationBooking({ paymentMethod: "other" }).paymentMethod).toBe("other");
    expect(toConfirmationBooking({ paymentMethod: "future_wallet" }).paymentMethod).toBeNull();
  });

  it("normalizes invalid deposit percentages to zero", () => {
    const booking = toConfirmationBooking(
      { depositPercentage: Number.NaN },
      { depositPercentage: -1 },
    );

    expect(booking.depositPercentage).toBe(0);
  });
});

it("retains server-owned room lines and the complete name in confirmation", () => {
  const roomSelection = {
    contractVersion: "booking-room-selection.v1" as const,
    lines: [
      { roomTypeId: "double", publicOfferKey: "double:flex", guests: [{ adults: 2, children: 0 }] },
      { roomTypeId: "twin", publicOfferKey: "twin:flex", guests: [{ adults: 2, children: 0 }] },
    ],
  };
  const roomLines = roomSelection.lines.map((line) => ({
    ...line,
    roomName: line.roomTypeId,
    roomCount: 1,
    policy: {},
    rateSummary: {},
    totals: { totalAmount: "100.00" },
  }));
  const booking = toConfirmationBooking(
    { roomSelection, roomLines, roomName: "1 × Double + 1 × Twin" },
    { roomName: "Double" },
  );
  expect(booking.roomSelection).toEqual(roomSelection);
  expect(booking.roomLines).toEqual(roomLines);
  expect(booking.roomName).toBe("1 × Double + 1 × Twin");
});
