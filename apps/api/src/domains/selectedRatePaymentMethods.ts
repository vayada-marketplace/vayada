import type { PoolClient } from "pg";
import type { PricingPaymentMethod, PublicPricingSelection } from "@vayada/domain-booking";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { publicPricingOfferBindings } from "./publicPricingRoomStay.js";

/** VAY-2309: whether every selected rate's terms take this way to pay. Only names the reason a
 * quote was refused, so the booking page can say so; the quote owner (publicPricingPaymentAmounts)
 * enforces the rule. A rate the publication no longer knows, or terms without methods, count as
 * taking it: their refusal has another reason. */
export async function selectedRatesTakePaymentMethod(
  client: PoolClient,
  slug: unknown,
  selection: Pick<PublicPricingSelection, "rooms">,
  method: PricingPaymentMethod,
): Promise<boolean> {
  const owner = await lockPublicPricingPublication(client, slug);
  if (!owner) return true;
  const bindings = publicPricingOfferBindings(owner);
  return selection.rooms.every((room) => {
    const binding = bindings.find((b) => b.publicOfferKey === room.publicOfferKey);
    const methods =
      binding &&
      owner.terms.find((t) => t.roomTypeId === binding.roomTypeId && t.offerId === binding.offerId)
        ?.payment.acceptedMethods;
    return !methods?.length || methods.includes(method);
  });
}
