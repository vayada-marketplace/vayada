import { expect, it } from "vitest";
import {
  toBookingReservationReadModel,
  type BookingReservationReadModelRow,
} from "./bookingReservationReadModel.js";
it.each(["recorded", "unverified"] as const)(
  "preserves room records with %s amounts without exposing inventory evidence",
  (amountStatus) => {
    const lines = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ].map((roomTypeId, index) => ({
      roomTypeId,
      publicOfferKey: roomTypeId,
      guests: Array.from({ length: index ? 1 : 2 }, () => ({ adults: 2, children: 0 })),
    }));
    const result = toBookingReservationReadModel({
      amountStatus,
      id: "booking",
      bookingReference: "VAY-1",
      roomTypeId: lines[0]!.roomTypeId,
      roomName: "stale primary",
      roomMaxOccupancy: 2,
      guestFirstName: "Test",
      guestLastName: "Guest",
      guestEmail: "",
      guestPhone: "",
      specialRequests: "",
      checkIn: "2027-02-01",
      checkOut: "2027-02-03",
      adults: 6,
      children: 0,
      nightlyRate: 100,
      numberOfRooms: 3,
      totalAmount: 600,
      currency: "EUR",
      status: "pending",
      createdAt: "2027-01-01",
      updatedAt: "2027-01-01",
      selectedRoomOffer: {
        roomSelection: { contractVersion: "booking-room-selection.v1", lines },
        roomLines: lines.map((line, index) => ({
          ...line,
          offer: {
            roomSummary: { name: index ? "Twin" : "Double" },
            inventoryEvidence: "private receipt",
          },
        })),
      },
    } satisfies BookingReservationReadModelRow);
    expect(result.roomLines).toEqual(
      lines.map((line, index) => ({
        roomTypeId: line.roomTypeId,
        roomName: index ? "Twin" : "Double",
        roomCount: index ? 1 : 2,
      })),
    );
    expect(JSON.stringify(result)).not.toContain("private receipt");
    expect(result.amountStatus).toBe(amountStatus);
    expect(result.totalAmount).toBe(amountStatus === "unverified" ? null : 600);
    expect(result.balanceAmount).toBe(amountStatus === "unverified" ? null : 600);
    expect(result.nightlyRate).toBe(amountStatus === "unverified" ? null : 100);
  },
);

// VAY-2320: a booking with rooms of several types lists them by type, not as "3 x" the first one.
it("lists a pricing booking's rooms by type from its assigned rooms", () => {
  const row = {
    id: "booking",
    bookingReference: "VAY-2",
    roomTypeId: "type-a",
    roomName: "Deluxe Double Room",
    roomMaxOccupancy: 2,
    guestFirstName: "Ada",
    guestLastName: "Lovelace",
    guestEmail: "",
    guestPhone: "",
    specialRequests: "",
    checkIn: "2026-11-10",
    checkOut: "2026-11-12",
    adults: 5,
    children: 1,
    nightlyRate: 100,
    numberOfRooms: 3,
    totalAmount: 900,
    currency: "EUR",
    status: "confirmed",
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
    selectedRoomOffer: null,
  } satisfies BookingReservationReadModelRow;
  const lines = [
    { roomTypeId: "type-a", roomName: "Deluxe Double Room", roomCount: 2 },
    { roomTypeId: "type-b", roomName: "Garden Double Room", roomCount: "1" },
  ];
  expect(toBookingReservationReadModel({ ...row, assignedRoomLines: lines }).roomLines).toEqual([
    { roomTypeId: "type-a", roomName: "Deluxe Double Room", roomCount: 2 },
    { roomTypeId: "type-b", roomName: "Garden Double Room", roomCount: 1 },
  ]);
  // The driver may hand JSON over as text; one type keeps today's "3 x Deluxe Double Room".
  expect(
    toBookingReservationReadModel({ ...row, assignedRoomLines: JSON.stringify(lines) }).roomLines,
  ).toHaveLength(2);
  expect(
    toBookingReservationReadModel({ ...row, assignedRoomLines: [lines[0]] }),
  ).not.toHaveProperty("roomLines");
  expect(toBookingReservationReadModel({ ...row, assignedRoomLines: null })).not.toHaveProperty(
    "roomLines",
  );
});

// A booked room selection whose rooms the PMS moved to other types lists the PMS rooms' types.
it("lists the PMS rooms' types over a booked room selection", () => {
  const [double, twin, suite] = ["a", "b", "c"].map(
    (id) => `00000000-0000-4000-8000-00000000000${id}`,
  );
  const lines = [double!, twin!].map((roomTypeId, index) => ({
    roomTypeId,
    publicOfferKey: roomTypeId,
    guests: Array.from({ length: index ? 1 : 2 }, () => ({ adults: 2, children: 0 })),
  }));
  const row = {
    id: "booking",
    bookingReference: "VAY-3",
    roomTypeId: suite!,
    roomName: "Suite",
    roomMaxOccupancy: 2,
    guestFirstName: "Ada",
    guestLastName: "Lovelace",
    guestEmail: "",
    guestPhone: "",
    specialRequests: "",
    checkIn: "2026-11-10",
    checkOut: "2026-11-12",
    adults: 6,
    children: 0,
    nightlyRate: 100,
    numberOfRooms: 3,
    totalAmount: 900,
    currency: "EUR",
    status: "confirmed",
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
    selectedRoomOffer: {
      roomSelection: { contractVersion: "booking-room-selection.v1", lines },
      roomLines: lines.map((line, index) => ({
        ...line,
        offer: { roomSummary: { name: index ? "Twin" : "Double" } },
      })),
    },
  } satisfies BookingReservationReadModelRow;
  const moved = [
    { roomTypeId: suite!, roomName: "Suite", roomCount: 2 },
    { roomTypeId: twin!, roomName: "Twin", roomCount: 1 },
  ];
  expect(toBookingReservationReadModel({ ...row, assignedRoomLines: moved }).roomLines).toEqual(
    moved,
  );
  expect(toBookingReservationReadModel(row).roomLines).toEqual([
    { roomTypeId: double!, roomName: "Double", roomCount: 2 },
    { roomTypeId: twin!, roomName: "Twin", roomCount: 1 },
  ]);
});
