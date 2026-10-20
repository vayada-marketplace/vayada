import {
  FIRST_RUN_BED_CHOICES,
  FIRST_RUN_DEFAULT_BED,
  FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
  FIRST_RUN_FREE_CANCELLATION_DAYS,
  FIRST_RUN_MAX_ROOMS,
  firstRunPriceMinor,
  firstRunRoomFacts,
  isFirstRunBedChoice,
  isFirstRunFreeCancellationDays,
  type FirstRunBedChoice,
  type FirstRunFreeCancellationDays,
} from "@vayada/domain-booking";

import type { QuickPreviewRoom } from "./QuickBookingPagePreview";

/** VAY-2247 "First room and price": one room type as the owner types it. */
export type QuickRoomDraft = {
  name: string;
  numberOfRooms: string;
  maxGuests: string;
  pricePerNight: string;
};

/**
 * The hotel's room types (in order), the taxes tick, which covers all their prices, and the owner's
 * cancellation and bed choices for all of them (1.12b; the first run's defaults when not set).
 */
export type QuickRoomsDraft = {
  rooms: QuickRoomDraft[];
  pricesIncludeMandatoryCharges: boolean;
  freeCancellationDays?: FirstRunFreeCancellationDays;
  bed?: FirstRunBedChoice;
};

/** The draft's cancellation and bed, with the first run's defaults (free until 3 days, a double bed). */
export function quickRoomChoices(draft: QuickRoomsDraft): {
  freeCancellationDays: FirstRunFreeCancellationDays;
  bed: FirstRunBedChoice;
} {
  return {
    freeCancellationDays: draft.freeCancellationDays ?? FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
    bed: draft.bed ?? FIRST_RUN_DEFAULT_BED,
  };
}

const days = (count: number) => `${count} day${count === 1 ? "" : "s"}`;

/** "Free cancellation until 7 days before arrival". */
export function quickCancellationTitle(freeCancellationDays: FirstRunFreeCancellationDays): string {
  return `Free cancellation until ${days(freeCancellationDays)} before arrival`;
}

const BED_TITLES: Record<FirstRunBedChoice, string> = {
  double: "One double bed per room",
  queen: "One queen bed per room",
  king: "One king bed per room",
  twin: "Two twin beds per room",
  single: "One single bed per room",
};

export function quickBedTitle(bed: FirstRunBedChoice): string {
  return BED_TITLES[bed];
}

/** The cancellation picker's choices (Flamur, 2026-10-20), then Non-refundable, not offered yet. */
export const QUICK_CANCELLATION_OPTIONS = FIRST_RUN_FREE_CANCELLATION_DAYS.map((value) => ({
  value,
  label: `Free until ${days(value)} before arrival`,
}));
export const QUICK_NON_REFUNDABLE_NOTE =
  "Needs online card payments. Set it later in Rooms & Rates once cards are on.";

export const QUICK_BED_OPTIONS = FIRST_RUN_BED_CHOICES.map((value) => ({
  value,
  label: BED_TITLES[value].replace(" per room", ""),
}));

/** What the first-run request carries for the choices. */
export function quickFirstRunChoices(draft: QuickRoomsDraft) {
  const { freeCancellationDays, bed } = quickRoomChoices(draft);
  return Object.freeze({
    cancellation: Object.freeze({
      kind: "free_until_days_before_arrival" as const,
      days: freeCancellationDays,
    }),
    bed,
  });
}

/** The first run takes up to this many room types (the server's FIRST_RUN_MAX_ROOM_TYPES). */
export const QUICK_MAX_ROOM_TYPES = 10;

export const EMPTY_QUICK_ROOM_DRAFT: QuickRoomDraft = Object.freeze({
  name: "",
  numberOfRooms: "",
  maxGuests: "2",
  pricePerNight: "",
});

export const EMPTY_QUICK_ROOMS_DRAFT: QuickRoomsDraft = Object.freeze({
  rooms: [EMPTY_QUICK_ROOM_DRAFT],
  pricesIncludeMandatoryCharges: false,
});

export const QUICK_TAXES_ERROR = "Confirm that your prices include taxes and fees.";

export type QuickRoomField = "name" | "numberOfRooms" | "maxGuests" | "pricePerNight";
export type QuickRoomErrors = Partial<Record<QuickRoomField, string>>;

const whole = (value: string) => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null);
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The same rules as the server's first run (firstRunRoomFacts, firstRunPriceMinor), in the owner's words.
 * `otherNames` are the hotel's other room types: the PMS keeps room type names unique.
 */
export function quickRoomErrors(
  draft: QuickRoomDraft,
  currency: string,
  otherNames: readonly string[] = [],
): QuickRoomErrors {
  const errors: QuickRoomErrors = {};
  const rooms = whole(draft.numberOfRooms);
  const guests = whole(draft.maxGuests);
  if (!draft.name.trim()) errors.name = "Enter a name for this room type.";
  else if (otherNames.some((name) => sameName(name, draft.name)))
    errors.name = "You already have a room type with this name.";
  if (rooms === null || rooms < 1) errors.numberOfRooms = "Enter at least 1 room.";
  else if (rooms > FIRST_RUN_MAX_ROOMS)
    errors.numberOfRooms = `Enter up to ${FIRST_RUN_MAX_ROOMS} rooms; add more later in Rooms & Rates.`;
  if (guests === null || guests < 1) errors.maxGuests = "Enter how many guests fit in this room.";
  if (!draft.pricePerNight.trim()) errors.pricePerNight = "Enter a price per night.";
  else if (!firstRunPriceMinor(draft.pricePerNight, currency))
    errors.pricePerNight = "Enter a price like 145 or 145.50.";
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

/** The first room type with something to fix, and what; null when all of them can be sent. */
export function quickRoomsFirstError(
  draft: QuickRoomsDraft,
  currency: string,
): { index: number; errors: QuickRoomErrors } | null {
  for (let index = 0; index < draft.rooms.length; index += 1) {
    const others = draft.rooms.filter((_, other) => other !== index).map((other) => other.name);
    const errors = quickRoomErrors(draft.rooms[index]!, currency, others);
    if (Object.keys(errors).length > 0) return { index, errors };
  }
  return null;
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

/**
 * The number of each room type's first room: names are unique in a hotel, so the first run counts on
 * across room types (Room 1–8, then Room 9–12). Unusable counts take no numbers.
 */
export function quickRoomFirstNumbers(rooms: readonly QuickRoomDraft[]): number[] {
  let next = 1;
  return rooms.map((room) => {
    const first = next;
    const count = whole(room.numberOfRooms);
    if (count !== null && count >= 1 && count <= FIRST_RUN_MAX_ROOMS) next += count;
    return first;
  });
}

/** "We create Room 1–8 in the PMS." for the rooms the first run names, from `firstNumber` on. */
export function quickRoomLabelsHint(numberOfRooms: string, firstNumber = 1): string | null {
  const count = whole(numberOfRooms);
  if (count === null || count < 1 || count > FIRST_RUN_MAX_ROOMS) return null;
  return count === 1
    ? `We create Room ${firstNumber} in the PMS. Rename it later.`
    : `We create Room ${firstNumber}–${firstNumber + count - 1} in the PMS. Rename them later.`;
}

/** Reads a saved draft: this version's shape, or the first version's single room with its tick. */
export function parseQuickRoomsDraft(value: unknown): QuickRoomsDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const room = (item: unknown): QuickRoomDraft => ({
    ...EMPTY_QUICK_ROOM_DRAFT,
    ...(item && typeof item === "object" ? pick(item as Record<string, unknown>) : {}),
  });
  // The choices (1.12b) come back only when they are still ones the first run takes.
  const choices = {
    ...(isFirstRunFreeCancellationDays(record.freeCancellationDays)
      ? { freeCancellationDays: record.freeCancellationDays }
      : {}),
    ...(isFirstRunBedChoice(record.bed) ? { bed: record.bed } : {}),
  };
  if (Array.isArray(record.rooms))
    return {
      rooms: record.rooms.length
        ? record.rooms.slice(0, QUICK_MAX_ROOM_TYPES).map(room)
        : [EMPTY_QUICK_ROOM_DRAFT],
      pricesIncludeMandatoryCharges: record.pricesIncludeMandatoryCharges === true,
      ...choices,
    };
  return {
    rooms: [room(record)],
    pricesIncludeMandatoryCharges: record.pricesIncludeMandatoryCharges === true,
    ...choices,
  };
}

function pick(value: Record<string, unknown>): Partial<QuickRoomDraft> {
  const out: Partial<QuickRoomDraft> = {};
  for (const key of ["name", "numberOfRooms", "maxGuests", "pricePerNight"] as const)
    if (typeof value[key] === "string") out[key] = value[key] as string;
  return out;
}

/** The room types as the preview shows them, once each has a name and a price. */
export function quickPreviewRooms(draft: QuickRoomsDraft, symbol: string): QuickPreviewRoom[] {
  const { freeCancellationDays } = quickRoomChoices(draft);
  return draft.rooms.flatMap((room) => {
    const name = room.name.trim();
    const price = room.pricePerNight.trim();
    if (!name || !price) return [];
    const guests = Number(room.maxGuests) || 1;
    return [
      {
        name,
        details: `Up to ${guests} guest${guests === 1 ? "" : "s"} · Free cancellation until ${days(freeCancellationDays)} before`,
        price: `${symbol}${price}`,
      },
    ];
  });
}
