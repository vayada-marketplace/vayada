import { FIRST_RUN_MAX_ROOMS, firstRunPriceMinor, firstRunRoomFacts } from "@vayada/domain-booking";

/** VAY-2247 "First room and price": what the owner types, kept by the host until the first run is sent. */
export type QuickRoomDraft = {
  name: string;
  numberOfRooms: string;
  maxGuests: string;
  pricePerNight: string;
  pricesIncludeMandatoryCharges: boolean;
};

export const EMPTY_QUICK_ROOM_DRAFT: QuickRoomDraft = Object.freeze({
  name: "",
  numberOfRooms: "",
  maxGuests: "2",
  pricePerNight: "",
  pricesIncludeMandatoryCharges: false,
});

export type QuickRoomField = "name" | "numberOfRooms" | "maxGuests" | "pricePerNight" | "taxes";
export type QuickRoomErrors = Partial<Record<QuickRoomField, string>>;

const whole = (value: string) => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null);

/** The same rules as the server's first run (firstRunRoomFacts, firstRunPriceMinor), in the owner's words. */
export function quickRoomErrors(draft: QuickRoomDraft, currency: string): QuickRoomErrors {
  const errors: QuickRoomErrors = {};
  const rooms = whole(draft.numberOfRooms);
  const guests = whole(draft.maxGuests);
  if (!draft.name.trim()) errors.name = "Enter a name for this room type.";
  if (rooms === null || rooms < 1) errors.numberOfRooms = "Enter at least 1 room.";
  else if (rooms > FIRST_RUN_MAX_ROOMS)
    errors.numberOfRooms = `Enter up to ${FIRST_RUN_MAX_ROOMS} rooms; add more later in Rooms & Rates.`;
  if (guests === null || guests < 1) errors.maxGuests = "Enter how many guests fit in this room.";
  if (!draft.pricePerNight.trim()) errors.pricePerNight = "Enter a price per night.";
  else if (!firstRunPriceMinor(draft.pricePerNight, currency))
    errors.pricePerNight = "Enter a price like 145 or 145.50.";
  if (!draft.pricesIncludeMandatoryCharges)
    errors.taxes = "Confirm that your prices include taxes and fees.";
  if (
    !errors.name &&
    !errors.numberOfRooms &&
    !errors.maxGuests &&
    !firstRunRoomFacts({
      name: draft.name,
      numberOfRooms: rooms ?? 0,
      maxGuests: guests ?? 0,
      pricePerNight: draft.pricePerNight,
    })
  )
    errors.name = "Use a shorter name for this room type.";
  return errors;
}

/** The first-run request's room once the draft is valid. */
export function quickRoomRequest(draft: QuickRoomDraft) {
  return Object.freeze({
    name: draft.name.trim(),
    numberOfRooms: Number(draft.numberOfRooms.trim()),
    maxGuests: Number(draft.maxGuests.trim()),
    pricePerNight: draft.pricePerNight.trim(),
  });
}

/** "We create Room 1–8 in the PMS." for the rooms the first run names. */
export function quickRoomLabelsHint(numberOfRooms: string): string | null {
  const count = whole(numberOfRooms);
  if (count === null || count < 1 || count > FIRST_RUN_MAX_ROOMS) return null;
  return count === 1
    ? "We create Room 1 in the PMS. Rename it later."
    : `We create Room 1–${count} in the PMS. Rename them later.`;
}
