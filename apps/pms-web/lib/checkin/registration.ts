import type { Booking, BookingAdditionalGuest, GuestRegistration } from "@/services/bookings";
import type { CheckinGuestField, CheckinSettings } from "@/services/settings";

/** Registered: every required field is filled. ID missing: the names are there, the document isn't.
 * Details missing: anything else required is empty (VAY-2373, from Settings → Check-in). */
export type GuestRegistrationStatus = "registered" | "id_missing" | "details_missing";

export interface RegistrationGuest {
  /** The booking guest's id, or `slot-N` for a guest nobody has entered yet. */
  key: string;
  guestId: string | null;
  role: "booker" | "additional_guest" | "slot";
  firstName: string;
  lastName: string;
  registration: GuestRegistration | null;
  status: GuestRegistrationStatus;
  /** The required fields still empty, first and last name included. */
  missing: Array<CheckinGuestField | "firstName" | "lastName">;
}

const ID_FIELDS: CheckinGuestField[] = ["documentType", "documentNumber"];

/** How many guests must be registered, by Settings → Check-in's "Who needs to be registered". */
export function expectedRegistrations(
  booking: Pick<Booking, "adults" | "children" | "numberOfGuests">,
  settings: Pick<CheckinSettings, "registrationScope">,
): number {
  if (settings.registrationScope === "booker") return 1;
  const adults = Math.max(1, booking.adults || 0);
  if (settings.registrationScope === "adults") return adults;
  return Math.max(adults + (booking.children || 0), booking.numberOfGuests ?? 0, 1);
}

function filled(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

function evaluate(
  values: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    nationality: string;
  },
  registration: GuestRegistration | null,
  settings: Pick<CheckinSettings, "guestFields">,
): Pick<RegistrationGuest, "status" | "missing"> {
  const has = (field: CheckinGuestField): boolean => {
    if (field === "email") return filled(values.email);
    if (field === "phone") return filled(values.phone);
    if (field === "nationality") return filled(values.nationality);
    return Boolean(registration?.filledFields.includes(field));
  };
  const missing: RegistrationGuest["missing"] = [];
  if (!filled(values.firstName)) missing.push("firstName");
  if (!filled(values.lastName)) missing.push("lastName");
  for (const { field, required } of settings.guestFields)
    if (required && !has(field)) missing.push(field);
  if (missing.length === 0) return { status: "registered", missing };
  const onlyId = missing.every((field) => (ID_FIELDS as string[]).includes(field));
  return { status: onlyId ? "id_missing" : "details_missing", missing };
}

/** The booker, the guests already entered, then empty slots up to the number to register. */
export function registrationGuests(input: {
  booking: Booking;
  additionalGuests: BookingAdditionalGuest[];
  registrations: GuestRegistration[];
  settings: Pick<CheckinSettings, "guestFields" | "registrationScope">;
}): RegistrationGuest[] {
  const { booking, additionalGuests, registrations, settings } = input;
  const byGuest = new Map(registrations.map((entry) => [entry.guestId, entry]));
  const bookerRegistration =
    registrations.find((entry) => entry.role === "booker" || entry.role === "primary_guest") ??
    null;
  const booker: RegistrationGuest = {
    key: bookerRegistration?.guestId ?? "booker",
    guestId: bookerRegistration?.guestId ?? null,
    role: "booker",
    firstName: booking.guestFirstName,
    lastName: booking.guestLastName,
    registration: bookerRegistration,
    ...evaluate(
      {
        firstName: booking.guestFirstName,
        lastName: booking.guestLastName,
        email: booking.guestEmail,
        phone: booking.guestPhone,
        nationality: booking.guestCountry,
      },
      bookerRegistration,
      settings,
    ),
  };
  const others: RegistrationGuest[] = additionalGuests.map((guest) => {
    const registration = byGuest.get(guest.id) ?? null;
    return {
      key: guest.id,
      guestId: guest.id,
      role: "additional_guest",
      firstName: guest.firstName,
      lastName: guest.lastName,
      registration,
      ...evaluate(guest, registration, settings),
    };
  });
  const expected = expectedRegistrations(booking, settings);
  const slots: RegistrationGuest[] = [];
  for (let index = 1 + others.length; index < expected; index += 1)
    slots.push({
      key: `slot-${index + 1}`,
      guestId: null,
      role: "slot",
      firstName: "",
      lastName: "",
      registration: null,
      status: "details_missing",
      missing: ["firstName", "lastName"],
    });
  return [booker, ...others, ...slots];
}

/** Of the guests who must register, how many have; the rest in form order. */
export function registrationSummary(
  guests: RegistrationGuest[],
  expected: number,
): { registered: number; total: number; incomplete: RegistrationGuest[] } {
  const counted = guests.slice(0, Math.max(expected, 1));
  const incomplete = counted.filter((guest) => guest.status !== "registered");
  return { registered: counted.length - incomplete.length, total: counted.length, incomplete };
}
