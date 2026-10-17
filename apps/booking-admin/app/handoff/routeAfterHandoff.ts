import { ApiErrorResponse } from "@/services/api/client";
import type { HotelSummary } from "@/services/settings";

export type HandoffRoutingInput = {
  /** The redeemed handoff's target path, or a safe `?redirect=` query value. */
  safeRedirect: string | null;
  propertyId: string | null;
  handoffHotelId: string | null;
};

export type HandoffRoutingOutcome = { kind: "navigate"; href: string } | { kind: "retry" };

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A hotel list failure worth retrying: an outage or a network error, not a rejected request. */
export function isTransientHotelListFailure(error: unknown): boolean {
  if (error instanceof ApiErrorResponse) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // Network and timeout failures surface as TypeError / DOMException; a malformed status answer
  // is a plain Error and would fail the same way on every retry.
  return error instanceof TypeError || error instanceof DOMException;
}

/**
 * Picks the hotel the handoff names (or the stored one) and where to go next. A temporarily
 * failed hotel list never drops a handoff target: the caller shows Retry and runs this again
 * (VAY-2266), so a PMS hotel still lands on the setup path it was handed, e.g.
 * `/setup?…&mode=add&returnProduct=pms`. A rejected request keeps the previous setup fallback.
 */
export async function resolveHandoffRouting(
  input: HandoffRoutingInput,
  deps: { listHotels: () => Promise<HotelSummary[]>; storage: HotelSelectionStorage },
): Promise<HandoffRoutingOutcome> {
  const { storage } = deps;
  let hotels: HotelSummary[];
  try {
    hotels = await deps.listHotels();
  } catch (error) {
    if (input.safeRedirect && isTransientHotelListFailure(error)) return { kind: "retry" };
    storage.setItem("setupComplete", "false");
    const explicitId = input.propertyId || input.handoffHotelId;
    return {
      kind: "navigate",
      href: explicitId
        ? `/setup?entryProduct=booking&propertyId=${encodeURIComponent(explicitId)}`
        : "/setup",
    };
  }

  const storedPropertyId = storage.getItem("selectedSharedPropertyId")?.trim();
  const storedHotelId = storage.getItem("selectedHotelId")?.trim();
  const requestedPropertyId = input.propertyId ?? undefined;
  const requestedHotelId = input.handoffHotelId ?? undefined;
  const explicitSelectionRequested = Boolean(requestedPropertyId || requestedHotelId);
  let selected = requestedPropertyId
    ? (hotels.find(
        (hotel) => hotel.propertyId === requestedPropertyId || hotel.id === requestedPropertyId,
      ) ?? null)
    : requestedHotelId
      ? (hotels.find((hotel) => hotel.id === requestedHotelId) ?? null)
      : storedPropertyId
        ? (hotels.find(
            (hotel) => hotel.propertyId === storedPropertyId || hotel.id === storedPropertyId,
          ) ?? null)
        : storedHotelId
          ? (hotels.find((hotel) => hotel.id === storedHotelId) ?? null)
          : null;
  const explicitSelectionMissing = explicitSelectionRequested && !selected;

  if ((requestedPropertyId || requestedHotelId || storedPropertyId || storedHotelId) && !selected) {
    storage.removeItem("selectedSharedPropertyId");
    storage.removeItem("selectedHotelId");
  }
  if (!explicitSelectionRequested && !selected && hotels.length === 1) {
    selected = hotels[0]!;
  }
  if (selected) {
    storage.setItem("selectedSharedPropertyId", selected.propertyId ?? selected.id);
    storage.setItem("selectedHotelId", selected.id);
  }

  if (input.safeRedirect && !explicitSelectionMissing) {
    storage.setItem("setupComplete", "true");
    return { kind: "navigate", href: input.safeRedirect };
  }
  if (explicitSelectionMissing) {
    storage.setItem("setupComplete", "false");
    if (requestedPropertyId) {
      return {
        kind: "navigate",
        href: `/setup?entryProduct=booking&propertyId=${encodeURIComponent(requestedPropertyId)}`,
      };
    }
    return { kind: "navigate", href: hotels.length > 1 ? "/choose-property" : "/setup" };
  }
  if (hotels.length === 0) {
    storage.setItem("setupComplete", "false");
    return { kind: "navigate", href: "/setup" };
  }
  if (!selected && hotels.length > 1) {
    storage.setItem("setupComplete", "true");
    return { kind: "navigate", href: "/choose-property" };
  }

  storage.setItem("setupComplete", "true");
  return { kind: "navigate", href: "/dashboard" };
}
