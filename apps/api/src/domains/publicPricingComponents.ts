import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { replacementStayKey } from "@vayada/domain-booking";
import { isMinorAmount } from "@vayada/domain-pms";
import { lockPublicPricingRoomStay } from "./publicPricingRoomStay.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockReplacementAddonAmounts } from "./replacementAddonAmounts.js";
import { lockReplacementLastMinute } from "./replacementLastMinute.js";
import { lockReplacementPromoCode } from "./replacementPromoCode.js";
import { composeReplacementDiscounts } from "./replacementDiscountComposition.js";

/** Current public components in one caller-owned READ COMMITTED transaction.
 * Internal result only: subtotal before mandatory charges, not an accepted quote.
 * No inferred FX, deposit execution, calendar/inventory or generalized promotions. */
export async function lockPublicPricingComponents(
  client: PoolClient,
  slug: unknown,
  input: unknown,
) {
  const room = await lockPublicPricingRoomStay(client, slug, input);
  if (!room) return null;
  const { stay } = room,
    requestKey = replacementStayKey(stay);
  const addons = await lockReplacementAddonAmounts(client, stay);
  if (!addons || addons.requestKey !== requestKey) return null;
  const lastMinute = await lockReplacementLastMinute(client, {
    propertyId: stay.propertyId,
    checkIn: stay.checkIn,
    roomTypeIds: [...new Set(stay.rooms.map((r) => r.roomTypeId))],
  });
  if (!lastMinute) return null;
  const rooms = room.rooms.map((r) => {
    const selected = stay.rooms.find((s) => s.selectionId === r.selectionId)!;
    const policy = lastMinute.rooms.find((p) => p.roomTypeId === selected.roomTypeId);
    return {
      selectionId: r.selectionId,
      roomMinor: r.roomMinor,
      lastMinute: policy?.lastMinute,
      codeEligible: false,
    };
  });
  const base = {
    rooms,
    eligibleAddonMinor: addons.totalMinor,
    code: null,
    stacking: lastMinute.stacking,
  };
  const lmOnly = composeReplacementDiscounts(base);
  if (!lmOnly) return null;
  // Python checks the minimum against rooms after LM plus extras, even when nonstacking.
  const code =
    stay.promoCode === null
      ? null
      : await lockReplacementPromoCode(client, {
          propertyId: stay.propertyId,
          currency: stay.currency,
          code: stay.promoCode,
          checkIn: stay.checkIn,
          rooms: stay.rooms,
          bookingAmountMinor: lmOnly.remainingRoomAndEligibleAddonMinor,
        });
  if (stay.promoCode !== null && (!code || code.bookingLocalDate !== lastMinute.bookingLocalDate))
    return null;
  const discounts = composeReplacementDiscounts({
    ...base,
    code: code?.discount ?? null,
    rooms: rooms.map((r) => ({
      ...r,
      codeEligible: code?.eligibleSelectionIds.includes(r.selectionId) ?? false,
    })),
  });
  if (!discounts) return null;
  const subtotalMinor = (
    BigInt(discounts.remainingRoomAndEligibleAddonMinor) + BigInt(room.mealMinor)
  ).toString();
  if (!isMinorAmount(subtotalMinor)) return null;
  // Earlier owners can wait for locks; do not reuse expired public access or a prior local day.
  const scope = await lockPublicPricingAuthority(client, slug);
  if (
    !scope ||
    scope.propertyId !== room.owner.scope.propertyId ||
    scope.organizationId !== room.owner.scope.organizationId ||
    scope.authorityRevision !== room.owner.scope.authorityRevision
  )
    return null;
  const date = (
    await client.query("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS date", [
      lastMinute.propertyTimeZone,
    ])
  ).rows[0].date;
  if (date !== lastMinute.bookingLocalDate) return null;
  const promotions =
    "booking.promotions.v2:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          lastMinute: lastMinute.sourceRevision,
          code: code?.sourceRevision ?? null,
          requestedCode: stay.promoCode,
        }),
      )
      .digest("hex");
  return {
    kind: "pricing_components" as const,
    evaluatorVersion: "booking.components.v2" as const,
    stay,
    requestKey,
    room,
    addons,
    lastMinute,
    code,
    discounts,
    subtotalMinor,
    componentSources: {
      pms: room.owner.pmsSourceRevision,
      addons: addons.sourceRevision,
      promotions,
    },
  };
}
