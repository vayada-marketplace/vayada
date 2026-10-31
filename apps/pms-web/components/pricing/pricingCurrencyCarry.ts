import {
  pricingAmountStep,
  pricingConfigurationWithSameNumbers,
  pricingCurrencyScale,
} from "@vayada/domain-pms/replacement-pricing";
import type { PricingSnapshot } from "@/services/api/replacementPricingClient";

type Room = PricingSnapshot["rooms"][number];

/** Whether every number means the same in both currencies: one scale and one price step (EUR and CHF, not USD and IDR,
 * which is priced in whole rupiah). */
export function carriesEveryRoom(from: string, to: string) {
  return (
    pricingCurrencyScale(from) === pricingCurrencyScale(to) &&
    pricingAmountStep(from) === pricingAmountStep(to)
  );
}

/** The published rooms carried into the pricing currency an Owner changed to, with their numbers (VAY-2390 P5, D2).
 * Between currencies of one scale and price step every room is carried, as P5 did. Otherwise (VAY-2425) only `keep`,
 * the room on screen, rounded to the new step (US$49.99 is IDR 50): the others are left out, so a save publishes only
 * prices the Owner has seen, and they have no price until their own page is saved. A room whose numbers can't be
 * carried (a positive price under half a step) is left out too. */
export function roomsInPricingCurrency(
  rooms: readonly Room[],
  from: string,
  to: string,
  keep: string | null,
): Room[] {
  const every = carriesEveryRoom(from, to);
  return rooms
    .filter((room) => every || room.roomTypeId === keep)
    .flatMap((room) => {
      const carried = pricingConfigurationWithSameNumbers(room, to);
      return carried ? [carried] : [];
    });
}
