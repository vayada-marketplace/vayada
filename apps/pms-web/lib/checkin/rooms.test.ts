import { describe, expect, it } from "vitest";
import type { Booking, BookingStay } from "@/services/bookings";
import type { CalendarData } from "@/services/calendar";
import type { RegistrationGuest } from "./registration";
import { checkinRooms, guestsByRoom, roomMoveOptions } from "./rooms";

const stay = (
  position: number,
  roomNumber: string,
  checkOut: string,
  prices: number[],
): BookingStay => ({
  position,
  roomName: position === 0 ? "Double Room with balcony" : "Alpine Suite",
  ratePlanName: null,
  roomNumber,
  checkIn: "2026-08-15",
  checkOut,
  adults: 2,
  children: 0,
  nightly: prices.map((amount) => ({
    appliedAmount: amount,
    currency: "EUR",
    evidenceQuality: "exact" as const,
  })),
});

const booking = {
  id: "booking-ada",
  checkIn: "2026-08-15",
  checkOut: "2026-08-19",
  adults: 4,
  children: 0,
  roomId: "room-104",
  roomNumber: "104",
  roomTypeId: "type-double",
  roomName: "Double Room with balcony",
  stays: [
    stay(0, "104", "2026-08-17", [100, 100]),
    stay(1, "101", "2026-08-19", [150, 150, 170, 170]),
  ],
  assignedRooms: [
    {
      assignmentId: "as-104",
      roomId: "room-104",
      roomNumber: "104",
      position: 0,
      roomTypeId: "type-double",
    },
    {
      assignmentId: "as-101",
      roomId: "room-101",
      roomNumber: "101",
      position: 1,
      roomTypeId: "type-suite",
    },
  ],
} as unknown as Booking;

const guest = (key: string, assignmentId: string | null = null): RegistrationGuest => ({
  key,
  guestId: key,
  role: "additional_guest",
  firstName: key,
  lastName: "",
  registration: assignmentId
    ? {
        guestId: key,
        role: "additional_guest",
        assignmentId,
        dateOfBirth: null,
        documentType: null,
        documentNumber: null,
        gender: null,
        staffNotes: null,
        filledFields: ["assignmentId"],
        updatedAt: null,
      }
    : null,
  status: "details_missing",
  missing: [],
});

describe("check-in rooms (VAY-2373)", () => {
  it("lists each booked room with its own dates, and the one leaving first", () => {
    const rooms = checkinRooms(booking);
    expect(
      rooms.map(({ key, unit, nights, departsEarlier, nightlyRate }) => ({
        key,
        unit,
        nights,
        departsEarlier,
        nightlyRate,
      })),
    ).toEqual([
      { key: "as-104", unit: "104", nights: 2, departsEarlier: true, nightlyRate: 100 },
      { key: "as-101", unit: "101", nights: 4, departsEarlier: false, nightlyRate: 160 },
    ]);
  });

  it("puts guests in their saved room, then fills the rooms' beds in order", () => {
    const rooms = checkinRooms(booking);
    const placed = guestsByRoom(
      [guest("ada"), guest("grace", "as-101"), guest("g3"), guest("g4"), guest("g5")],
      rooms,
    );
    expect(placed.get("as-104")!.map((entry) => entry.key)).toEqual(["ada", "g3"]);
    expect(placed.get("as-101")!.map((entry) => entry.key)).toEqual(["grace", "g4", "g5"]);
  });

  it("offers free rooms of any type and says why the others can't be picked", () => {
    const [room104] = checkinRooms(booking);
    const calendar = {
      rooms: [
        {
          id: "room-101",
          roomTypeId: "type-suite",
          roomTypeName: "Alpine Suite",
          roomNumber: "101",
          status: "available",
        },
        {
          id: "room-102",
          roomTypeId: "type-suite",
          roomTypeName: "Alpine Suite",
          roomNumber: "102",
          status: "available",
        },
        {
          id: "room-103",
          roomTypeId: "type-suite",
          roomTypeName: "Alpine Suite",
          roomNumber: "103",
          status: "out_of_service",
        },
        {
          id: "room-104",
          roomTypeId: "type-double",
          roomTypeName: "Double Room with balcony",
          roomNumber: "104",
          status: "available",
        },
        {
          id: "room-105",
          roomTypeId: "type-double",
          roomTypeName: "Double Room with balcony",
          roomNumber: "105",
          status: "available",
        },
        {
          id: "room-106",
          roomTypeId: "type-double",
          roomTypeName: "Double Room with balcony",
          roomNumber: "106",
          status: "available",
        },
        {
          id: "room-107",
          roomTypeId: "type-double",
          roomTypeName: "Double Room with balcony",
          roomNumber: "107",
          status: "available",
        },
      ],
      bookings: [
        { id: "other", roomId: "room-106", checkIn: "2026-08-14", checkOut: "2026-08-16" },
        // Leaves the morning Ada arrives: no clash.
        { id: "earlier", roomId: "room-102", checkIn: "2026-08-12", checkOut: "2026-08-15" },
      ],
      blocks: [{ roomId: "room-107", startDate: "2026-08-16", endDate: "2026-08-18" }],
    } as unknown as CalendarData;
    const groups = roomMoveOptions(room104!, booking, calendar);
    expect(groups.map((group) => group.roomTypeName)).toEqual([
      "Double Room with balcony",
      "Alpine Suite",
    ]);
    expect(
      groups.flatMap((group) =>
        group.options.map(({ roomNumber, state, from }) => [roomNumber, state, from]),
      ),
    ).toEqual([
      ["104", "current", undefined],
      ["105", "free", undefined],
      ["106", "occupied", "2026-08-14"],
      ["107", "blocked", "2026-08-16"],
      ["101", "in_booking", undefined],
      ["102", "free", undefined],
      ["103", "out_of_service", undefined],
    ]);
  });
});
