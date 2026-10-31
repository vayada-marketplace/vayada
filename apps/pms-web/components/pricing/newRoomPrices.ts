import { parsePricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  createReplacementPricingClient,
  PricingSnapshot,
  PricingTermsInput,
} from "@/services/api/replacementPricingClient";

import { PricingError } from "./pricingAmounts";
import { roomsInPricingCurrency } from "./pricingCurrencyCarry";
import { pricingSave } from "./savePricing";

type Client = ReturnType<typeof createReplacementPricingClient>;
type Room = PricingSnapshot["rooms"][number];
/** Prices typed on the New room page (VAY-2147): the room under a temporary id, and its options' terms. */
export type NewRoomPrices = { room: Room; terms: PricingTermsInput[] };

/** The prices for the room as created: its id in the room and in every option's terms (the server binds terms to the
 * room), and the guest numbers it was created with. Prices per number of guests that no longer fit are refused. */
export function pricesForRoom(
  prices: NewRoomPrices,
  roomTypeId: string,
  capacity: Room["capacity"],
): NewRoomPrices {
  const room = parsePricingConfiguration({ ...prices.room, roomTypeId, capacity });
  if (!room) throw new PricingError("pricing.newRoom.errorGuests");
  return { room, terms: prices.terms.map((terms) => ({ ...terms, roomTypeId })) };
}

/** Publishes a just-created room's prices (see `pricesForRoom`) with every other room as the server has them now: one
 * whole-property save, like "Save prices" on the room's Prices tab. After an Owner's currency change the rooms still in
 * the old currency are carried as on a room's Prices tab (`roomsInPricingCurrency`, VAY-2425); storage takes another
 * currency only as the property's pricing currency. */
export async function publishNewRoomPrices(client: Client, prices: NewRoomPrices) {
  const saved = await client.read();
  // Someone published prices for this room since the page loaded.
  if (saved?.rooms.some((room) => room.roomTypeId === prices.room.roomTypeId))
    throw new ApiErrorResponse(409, { message: "The saved prices changed. Reload pricing." });
  const others = !saved
    ? []
    : saved.currency === prices.room.currency
      ? saved.rooms
      : roomsInPricingCurrency(saved.rooms, saved.currency, prices.room.currency, null);
  const baseRevision = saved?.revision ?? 0,
    revision = baseRevision + 1;
  const snapshot: PricingSnapshot = {
    currency: prices.room.currency,
    ownerReferences: { finance: saved?.ownerReferences.finance ?? "" },
    rooms: [...others, prices.room].map((room) => ({ ...room, revision })),
  };
  return pricingSave(client, { snapshot, baseRevision, terms: prices.terms })();
}
