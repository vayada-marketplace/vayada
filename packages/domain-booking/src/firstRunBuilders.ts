import {
  parsePmsOperatingCalendarProposalRequest,
  parsePricingConfiguration,
  parseRoomTypeFacts,
  pricingAmountStep,
  pricingCurrencyScale,
  type PmsOperatingCalendarProposalRequest,
  type PricingCapacity,
  type PricingConfiguration,
  type RoomTypeFacts,
} from "@vayada/domain-pms";

import {
  FIRST_RUN_ADULT_AGE_THRESHOLD,
  FIRST_RUN_DEFAULT_BED,
  FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
  FIRST_RUN_MINIMUM_STAY_NIGHTS,
  FIRST_RUN_OPERATING_SCHEDULE,
  firstRunBeds,
  firstRunCancellationTerms,
  type FirstRunBedChoice,
  type FirstRunFreeCancellationDays,
} from "./firstRunDefaults.js";
import type { ReplacementOfferTerms } from "./replacementPricingEvidence.js";
import { parseBookingPricingOfferTerms } from "./replacementPricingBrowser.js";

/**
 * Pure builders for the server's first run (VAY-2247): the hotel's answers in the new setup plus the
 * first-run defaults, turned into the exact inputs the existing commands take. Every result is checked with
 * the parser the real write path uses, so a builder returns null rather than something the server refuses.
 * No I/O and no node-only imports: this package is also bundled into Booking Admin.
 */

/** The first room type as the new setup collects it: a name, how many rooms, max guests and a nightly price. */
export type FirstRunRoomInput = Readonly<{
  name: string;
  numberOfRooms: number;
  maxGuests: number;
  /** In the hotel's currency, e.g. "120" or "120.50". */
  pricePerNight: string;
}>;

export const FIRST_RUN_MAX_ROOMS = 200;

/**
 * Room facts with the chosen beds (one double bed unless the owner picked another) and a private bathroom.
 * Max guests may all be adults; children are welcome up to one less, so at least one adult books.
 */
export function firstRunRoomFacts(
  room: FirstRunRoomInput,
  bed: FirstRunBedChoice = FIRST_RUN_DEFAULT_BED,
): RoomTypeFacts | null {
  if (
    !Number.isInteger(room.numberOfRooms) ||
    room.numberOfRooms < 1 ||
    room.numberOfRooms > FIRST_RUN_MAX_ROOMS
  ) {
    return null;
  }
  if (!Number.isInteger(room.maxGuests) || room.maxGuests < 1) return null;
  return parseRoomTypeFacts({
    name: room.name.trim(),
    description: "",
    category: null,
    occupancy: {
      maxGuests: room.maxGuests,
      maxAdults: room.maxGuests,
      maxChildren: room.maxGuests - 1,
    },
    beds: firstRunBeds(bed).map((one) => ({ ...one })),
    bedrooms: null,
    bathrooms: null,
    bathroomType: "private",
    size: null,
  });
}

/** "120.50" in EUR → "12050". Null for a missing, zero, malformed or off-step amount (IDR: whole rupiah). */
export function firstRunPriceMinor(pricePerNight: string, currency: string): string | null {
  const scale = pricingCurrencyScale(currency);
  const value = pricePerNight.trim();
  if (
    scale === null ||
    !new RegExp(`^\\d+(?:\\.\\d{1,${scale || 1}})?$`).test(value) ||
    (!scale && value.includes("."))
  ) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  const minor = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (
    minor === "0" ||
    minor.length > 18 ||
    BigInt(minor) % BigInt(pricingAmountStep(currency)) !== BigInt(0)
  )
    return null;
  return minor;
}

/** What pricing-v2 stages for the first rate: free cancellation until N days, paid in full at the property. */
export type FirstRunPricingTerms = Omit<ReplacementOfferTerms, "revision"> & {
  expectedRevision: null;
};

/**
 * The first price, as the setup screen's FirstPricingSetup builds it for "flat": one price per room and night,
 * room only, children free and counted toward the room's capacity (adults from 12), one-night minimum.
 */
export function firstRunPricing(input: {
  propertyId: string;
  roomTypeId: string;
  /** A UUID: it is also the offer's terms revision, which pricing-v2 requires to be a UUID. */
  offerId: string;
  currency: string;
  capacity: PricingCapacity;
  pricePerNight: string;
  /** The owner's choice in the first run (VAY-2247 1.12b); 3 when not given. */
  freeCancellationDays?: FirstRunFreeCancellationDays;
}): { configuration: PricingConfiguration; terms: FirstRunPricingTerms } | null {
  const amountMinor = firstRunPriceMinor(input.pricePerNight, input.currency);
  if (!amountMinor) return null;
  const cancellation = {
    kind: "flexible" as const,
    terms: {
      ...firstRunCancellationTerms(
        input.freeCancellationDays ?? FIRST_RUN_DEFAULT_FREE_CANCELLATION_DAYS,
      ),
    },
  };
  const payment = { kind: "full" as const, acceptedMethods: ["pay_at_property" as const] };
  if (
    !parseBookingPricingOfferTerms({
      roomTypeId: input.roomTypeId,
      offerId: input.offerId,
      revision: input.offerId,
      cancellation,
      payment,
    })
  ) {
    return null;
  }
  const configuration = parsePricingConfiguration({
    version: "pricing.v2",
    propertyId: input.propertyId,
    roomTypeId: input.roomTypeId,
    revision: 1,
    currency: input.currency,
    capacity: input.capacity,
    children: {
      adultFromAge: FIRST_RUN_ADULT_AGE_THRESHOLD,
      bands: [
        {
          fromAge: 0,
          throughAge: FIRST_RUN_ADULT_AGE_THRESHOLD - 1,
          nightlyMinor: "0",
          countsTowardCapacity: true,
        },
      ],
    },
    offers: [
      {
        id: input.offerId,
        termsRevision: input.offerId,
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "flat", amountMinor },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights: FIRST_RUN_MINIMUM_STAY_NIGHTS,
            maxStayNights: null,
            closedToArrival: false,
            closedToDeparture: false,
            stopSell: false,
          },
          seasons: [],
          dates: [],
        },
      },
    ],
  });
  if (!configuration) return null;
  return {
    configuration,
    terms: {
      roomTypeId: input.roomTypeId,
      offerId: input.offerId,
      expectedRevision: null,
      cancellation,
      payment,
    },
  };
}

/** One active room type for the calendar: its current revisions and how many rooms can be sold. */
export type FirstRunCalendarRoomType = Readonly<{
  roomTypeId: string;
  expectedRoomFactsRevision: number;
  expectedRoomUnitsRevision: number;
  activeUnitCount: number;
}>;

/** Open all year with a one-night minimum; every room of every active room type is sellable from the start. */
export function firstRunOperatingCalendarProposal(input: {
  expectedCalendarRevision: number;
  expectedPropertyProfileRevision: number;
  roomTypes: readonly FirstRunCalendarRoomType[];
}): PmsOperatingCalendarProposalRequest | null {
  return parsePmsOperatingCalendarProposalRequest({
    expectedCalendarRevision: input.expectedCalendarRevision,
    expectedPropertyProfileRevision: input.expectedPropertyProfileRevision,
    schedule: { mode: FIRST_RUN_OPERATING_SCHEDULE.mode, periods: [] },
    defaultMinimumStayNights: FIRST_RUN_MINIMUM_STAY_NIGHTS,
    roomTypeLimits: input.roomTypes.map((room) => ({
      roomTypeId: room.roomTypeId,
      expectedRoomFactsRevision: room.expectedRoomFactsRevision,
      expectedRoomUnitsRevision: room.expectedRoomUnitsRevision,
      startingSellableLimitCount: room.activeUnitCount,
    })),
  });
}
