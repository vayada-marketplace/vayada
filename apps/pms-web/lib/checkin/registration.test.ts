import { describe, expect, it } from "vitest";
import type { Booking, BookingAdditionalGuest, GuestRegistration } from "@/services/bookings";
import { DEFAULT_CHECKIN_SETTINGS } from "@/lib/settings/checkinSettings";
import { expectedRegistrations, registrationGuests, registrationSummary } from "./registration";

const booking = {
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.com",
  guestPhone: "",
  guestCountry: "AT",
  adults: 4,
  children: 1,
  numberOfGuests: 5,
} as Booking;

function guest(
  id: string,
  firstName: string,
  lastName: string,
  nationality = "",
): BookingAdditionalGuest {
  return { id, firstName, lastName, nationality, email: "", phone: "" } as BookingAdditionalGuest;
}

function registration(
  guestId: string,
  filledFields: GuestRegistration["filledFields"],
  role: GuestRegistration["role"] = "additional_guest",
): GuestRegistration {
  return {
    guestId,
    role,
    assignmentId: null,
    dateOfBirth: null,
    documentType: null,
    documentNumber: null,
    gender: null,
    staffNotes: null,
    filledFields,
    updatedAt: null,
  };
}

describe("guest registration status (VAY-2373)", () => {
  it("expects the booker, every adult or every guest, by the setting", () => {
    expect(expectedRegistrations(booking, { registrationScope: "booker" })).toBe(1);
    expect(expectedRegistrations(booking, { registrationScope: "adults" })).toBe(4);
    expect(expectedRegistrations(booking, { registrationScope: "all" })).toBe(5);
  });

  it("calls a guest registered only with every required field, ID missing with only the document missing", () => {
    const guests = registrationGuests({
      booking,
      additionalGuests: [guest("g-grace", "Grace", "Hopper", "US")],
      registrations: [
        registration("g-ada", ["documentType", "documentNumber", "dateOfBirth"], "booker"),
        registration("g-grace", ["dateOfBirth"]),
      ],
      settings: DEFAULT_CHECKIN_SETTINGS,
    });
    expect(guests.map(({ key, role, status }) => ({ key, role, status }))).toEqual([
      { key: "g-ada", role: "booker", status: "registered" },
      { key: "g-grace", role: "additional_guest", status: "id_missing" },
      { key: "slot-3", role: "slot", status: "details_missing" },
      { key: "slot-4", role: "slot", status: "details_missing" },
    ]);
    expect(guests[1]!.missing).toEqual(["documentType", "documentNumber"]);
    // A guest nobody entered yet misses every required field (VAY-2418).
    expect(guests[2]!.missing).toEqual([
      "firstName",
      "lastName",
      ...DEFAULT_CHECKIN_SETTINGS.guestFields
        .filter((entry) => entry.required)
        .map((entry) => entry.field),
    ]);
    expect(registrationSummary(guests, 4)).toMatchObject({ registered: 1, total: 4 });
  });

  it("follows the settings: an optional document makes names and nationality enough", () => {
    const relaxed = {
      ...DEFAULT_CHECKIN_SETTINGS,
      registrationScope: "booker" as const,
      guestFields: DEFAULT_CHECKIN_SETTINGS.guestFields.map((entry) => ({
        ...entry,
        required: false,
      })),
    };
    const guests = registrationGuests({
      booking,
      additionalGuests: [],
      registrations: [],
      settings: relaxed,
    });
    expect(guests).toHaveLength(1);
    expect(guests[0]).toMatchObject({ key: "booker", guestId: null, status: "registered" });
    expect(registrationSummary(guests, 1)).toMatchObject({
      registered: 1,
      total: 1,
      incomplete: [],
    });
  });
});
