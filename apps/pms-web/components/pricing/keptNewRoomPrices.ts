import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { PricingError as SetupPricingError } from "@vayada/product-onboarding/pricingSetupAmounts";
import en from "@/messages/en.json";
import { ApiErrorResponse, type ApiError } from "@/services/api/client";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";

import type { NewRoomPrices } from "./newRoomPrices";
import { type MessageKey, PricingError } from "./pricingAmounts";

/** Prices the New room page created a room with but could not save (VAY-2147): the room's Prices tab starts from them
 * and shows why. `outcomeUnknown`: the save broke off without an answer, so it may have published after all. */
export type KeptNewRoomPrices = NewRoomPrices & { error: unknown; outcomeUnknown: boolean };
type StoredError = { status: number; data: ApiError } | { key: string } | { message: string };

// Per browser tab, so a reload of the room's Prices tab still finds them; forgotten once saved or no longer applying.
const storageKey = (roomTypeId: string) => `pms.newRoomPrices.v1:${roomTypeId.toLowerCase()}`;
const maxAgeMs = 60 * 60 * 1000;

export function keepNewRoomPrices(prices: NewRoomPrices, error: unknown) {
  const refused = error instanceof ApiErrorResponse && error.status >= 400 && error.status < 500;
  // A conflict was resolved by the reload that opens the tab; what is left to say is that someone saved meanwhile.
  const stored: StoredError =
    error instanceof SetupPricingError
      ? { key: error.key }
      : refused && error.status === 409
        ? { key: "pricing.newRoom.errorChanged" }
        : error instanceof ApiErrorResponse
          ? { status: error.status, data: error.data }
          : { message: error instanceof Error ? error.message : "" };
  const outcomeUnknown = !refused && !(error instanceof SetupPricingError);
  try {
    sessionStorage.setItem(
      storageKey(prices.room.roomTypeId),
      JSON.stringify({ savedAt: Date.now(), prices, error: stored, outcomeUnknown }),
    );
  } catch {
    // No storage: the Prices tab opens without them, as after a reload.
  }
}

export function forgetKeptNewRoomPrices(roomTypeId: string) {
  try {
    sessionStorage.removeItem(storageKey(roomTypeId));
  } catch {
    // Nothing to forget.
  }
}

/** This room's kept prices, when they are recent and still read as prices for exactly this room. */
export function readKeptNewRoomPrices(roomTypeId: string): KeptNewRoomPrices | null {
  let value: unknown;
  try {
    value = JSON.parse(sessionStorage.getItem(storageKey(roomTypeId)) ?? "null");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { savedAt, prices, error, outcomeUnknown } = value as Record<string, unknown>;
  if (
    typeof savedAt !== "number" ||
    Date.now() - savedAt > maxAgeMs ||
    !prices ||
    typeof prices !== "object"
  )
    return null;
  const room = parsePricingConfiguration((prices as Record<string, unknown>).room);
  const stored = (prices as Record<string, unknown>).terms;
  if (!room || room.roomTypeId !== roomTypeId.toLowerCase() || !Array.isArray(stored)) return null;
  const terms = stored.map((item) => keptTerms(item, room));
  if (!terms.every((item) => item !== null)) return null;
  return {
    room,
    terms: terms as PricingTermsInput[],
    error: storedError(error),
    outcomeUnknown: outcomeUnknown === true,
  };
}

// The terms parser wants a revision; a kept option's terms are new or name the revision they change.
const newTermsRevision = "00000000-0000-4000-8000-000000000000";
/** One option's kept terms, when they are complete terms for an option of this room. */
function keptTerms(item: unknown, room: NonNullable<ReturnType<typeof parsePricingConfiguration>>) {
  const value = (item ?? {}) as Record<string, unknown>;
  const expectedRevision = value.expectedRevision;
  if (expectedRevision !== null && typeof expectedRevision !== "string") return null;
  if (!room.offers.some((offer) => offer.id === value.offerId)) return null;
  const parsed = parseBookingPricingOfferTerms({
    roomTypeId: value.roomTypeId,
    offerId: value.offerId,
    revision: expectedRevision ?? newTermsRevision,
    cancellation: value.cancellation,
    payment: value.payment,
  });
  return parsed && parsed.roomTypeId === room.roomTypeId
    ? {
        roomTypeId: parsed.roomTypeId,
        offerId: parsed.offerId,
        expectedRevision,
        cancellation: parsed.cancellation,
        payment: parsed.payment,
      }
    : null;
}

function storedError(value: unknown): unknown {
  const stored = (value ?? {}) as Partial<Record<string, unknown>>;
  if (typeof stored.key === "string" && Object.hasOwn(en, stored.key))
    return new PricingError(stored.key as MessageKey);
  if (typeof stored.status === "number" && stored.data && typeof stored.data === "object")
    return new ApiErrorResponse(stored.status, stored.data as ApiError);
  return typeof stored.message === "string" && stored.message
    ? new Error(stored.message)
    : new PricingError("pricing.editor.errorSaveFailed");
}
