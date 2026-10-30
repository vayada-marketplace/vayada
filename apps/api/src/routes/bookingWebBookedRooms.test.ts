import { expect, it } from "vitest";
import { serializeTargetBooking, type TargetBookingRow } from "./bookingWebPublic.js";

const DELUXE = "11111111-1111-4111-8111-111111111111";
const GARDEN = "22222222-2222-4222-8222-222222222222";
const row = (extra: Partial<TargetBookingRow> = {}) =>
  ({
    guestBookingId: "booking",
    propertyId: "property",
    publicReference: "VAY-TEST01",
    sourceSystem: "booking",
    lifecycleStatus: "confirmed",
    paymentStatus: "unpaid",
    checkIn: "2026-11-10",
    checkOut: "2026-11-12",
    adults: 5,
    children: 1,
    roomCount: 3,
    currency: "EUR",
    totalAmount: "900.00",
    balanceAmount: "900.00",
    createdAt: "2026-10-23T10:00:00.000Z",
    bookingMetadata: {
      targetSource: "pricing_quote_draft",
      pricingQuoteId: "quote",
      pricingSelections: [
        {
          selectionId: "one",
          roomTypeId: DELUXE,
          offerId: "flex",
          guests: { adults: 2, childAgesAtCheckIn: [] },
        },
        {
          selectionId: "two",
          roomTypeId: GARDEN,
          offerId: "flex",
          guests: { adults: 1, childAgesAtCheckIn: [7] },
        },
        {
          selectionId: "three",
          roomTypeId: DELUXE,
          offerId: "nrf",
          guests: { adults: 2, childAgesAtCheckIn: [] },
        },
      ],
    },
    bookedTerms: [
      {
        roomTypeId: DELUXE,
        offerId: "flex",
        cancellation: {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 3,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        },
      },
      {
        roomTypeId: GARDEN,
        offerId: "flex",
        cancellation: {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 5,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        },
      },
      { roomTypeId: DELUXE, offerId: "nrf", cancellation: { kind: "non_refundable" } },
    ],
    bookedPricedRooms: [
      { selectionId: "one", mealPlan: "room_only" },
      { selectionId: "two", mealPlan: "breakfast" },
      { selectionId: "three", mealPlan: "room_only" },
    ],
    bookedRoomNames: { [DELUXE]: "Deluxe Double Room", [GARDEN]: "Garden Double Room" },
    ...extra,
  }) as TargetBookingRow;

// VAY-2320: a group's booking lists every room, each with its own type, guests, meal and terms.
it("lists each booked room of a pricing booking with its own terms", () => {
  expect(serializeTargetBooking(row())["bookedRooms"]).toEqual([
    {
      roomTypeId: DELUXE,
      roomName: "Deluxe Double Room",
      mealPlan: "room_only",
      adults: 2,
      children: 0,
      cancellation: { kind: "free_until_days_before_arrival", days: 3 },
    },
    {
      roomTypeId: GARDEN,
      roomName: "Garden Double Room",
      mealPlan: "breakfast",
      adults: 1,
      children: 1,
      cancellation: { kind: "free_until_days_before_arrival", days: 5 },
    },
    {
      roomTypeId: DELUXE,
      roomName: "Deluxe Double Room",
      mealPlan: "room_only",
      adults: 2,
      children: 0,
      cancellation: { kind: "non_refundable" },
    },
  ]);
});

it("names what it can't read as unknown and leaves other bookings unchanged", () => {
  const missing = serializeTargetBooking(
    row({ bookedTerms: undefined, bookedPricedRooms: null, bookedRoomNames: null }),
  )["bookedRooms"] as Record<string, unknown>[];
  expect(
    missing.map(({ roomName, mealPlan, cancellation }) => [roomName, mealPlan, cancellation]),
  ).toEqual([
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]);
  expect(
    serializeTargetBooking(row({ bookingMetadata: { selectedOffer: { roomName: "Suite" } } })),
  ).not.toHaveProperty("bookedRooms");
  // A loader that doesn't read the rooms' terms and names leaves the field out.
  const unread: Record<string, unknown> = row();
  delete unread["bookedTerms"];
  delete unread["bookedPricedRooms"];
  delete unread["bookedRoomNames"];
  expect(serializeTargetBooking(unread as TargetBookingRow)).not.toHaveProperty("bookedRooms");
});

// VAY-2408: the lookup lists each booked extra once, with its quantity and days, as the PMS does.
it("groups the booked extras' lines per extra", () => {
  const extras = serializeTargetBooking(
    row({
      bookedAddons: [
        {
          addonId: "breakfast",
          name: "Garden breakfast",
          quantity: 2,
          serviceDates: ["2026-11-11"],
        },
        { addonId: "late", name: "Late check-out", quantity: 1, serviceDates: ["2026-11-12"] },
        {
          addonId: "breakfast",
          name: "Garden breakfast",
          quantity: 2,
          serviceDates: ["2026-11-10"],
        },
        // Older bookings' lines that differ add up.
        { addonId: "transfer", name: "Transfer", quantity: 1, serviceDates: ["2026-11-10"] },
        { addonId: "transfer", name: "Transfer", quantity: 2, serviceDates: ["2026-11-10"] },
        { addonId: "bottle", name: "Welcome bottle", quantity: 1, serviceDates: [] },
        { addonId: "broken", name: "", quantity: 1, serviceDates: [] },
      ],
    }),
  );
  expect(extras).toMatchObject({
    addonIds: ["breakfast", "late", "transfer", "bottle"],
    addonNames: ["Garden breakfast", "Late check-out", "Transfer", "Welcome bottle"],
    addonQuantities: { breakfast: 2, late: 1, transfer: 3, bottle: 1 },
    addonDates: {
      breakfast: ["2026-11-10", "2026-11-11"],
      late: ["2026-11-12"],
      transfer: ["2026-11-10"],
      bottle: [],
    },
  });
});

it("sends empty extras for a booking without, and none from loaders that don't read them", () => {
  expect(serializeTargetBooking(row({ bookedAddons: [] }))).toMatchObject({
    addonIds: [],
    addonNames: [],
    addonQuantities: {},
    addonDates: {},
  });
  expect(serializeTargetBooking(row())).not.toHaveProperty("addonIds");
});
