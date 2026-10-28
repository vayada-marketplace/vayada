import type { PoolClient } from "pg";
import {
  parseReplacementStay,
  parsePublicPricingSelection,
  replacementStayKey,
} from "@vayada/domain-booking";
import { isMinorAmount } from "@vayada/domain-pms";
import { lockReplacementAddons } from "./replacementAddons.js";
import { addonLeadTimeAllows } from "./addonLeadTime.js";
import { addonScheduledDates } from "./addonSchedule.js";
import { readPricingCheckInPlace } from "./pricingManualPaymentLead.js";

/** Caller must already own authorization and validated room allocation in this transaction.
 * Computes requested extras only; not a grand total, inventory or quote acceptance. */
export async function lockReplacementAddonAmounts(client: PoolClient, value: unknown) {
  const stay = parseReplacementStay(value);
  if (
    !stay ||
    !parsePublicPricingSelection({
      version: "public-pricing-selection.v2",
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      currency: stay.currency,
      addons: stay.addons,
      promoCode: stay.promoCode,
      rooms: stay.rooms.map((r) => ({
        selectionId: r.selectionId,
        publicOfferKey: r.offerId,
        guests: r.guests,
      })),
    })
  )
    return null;
  const owner = await lockReplacementAddons(client, {
    propertyId: stay.propertyId,
    currency: stay.currency,
    addonIds: stay.addons.map((a) => a.id),
  });
  if (!owner) return null;
  const guestCount = stay.rooms.reduce(
    (sum, r) => sum + r.guests.adults + r.guests.childAgesAtCheckIn.length,
    0,
  );
  const lines = [];
  let total = 0n;
  let place: Awaited<ReturnType<typeof readPricingCheckInPlace>> | undefined;
  for (const selected of stay.addons) {
    const definition = owner.addons.find((a) => a.id === selected.id.toLowerCase());
    if (
      !definition ||
      selected.version !== "addon-selection.v2" ||
      definition.legacyLeadTime ||
      selected.quantity > definition.maxQuantity
    )
      return null;
    // VAY-2232: check-in must be at least the add-on's notice away, now (the database clock).
    // Acceptance runs this again, so a quote can't be accepted once the notice has passed.
    if (definition.leadTimeHours !== null) {
      if (place === undefined) place = await readPricingCheckInPlace(client, stay.propertyId);
      if (
        !place ||
        !addonLeadTimeAllows({
          hours: definition.leadTimeHours,
          checkIn: stay.checkIn,
          place: place.place,
          now: place.now,
        })
      )
        return null;
    }
    const perPerson =
      definition.pricingModel === "per_guest" || definition.pricingModel === "per_guest_night";
    const perNight =
      definition.pricingModel === "per_night" || definition.pricingModel === "per_guest_night";
    if (perPerson ? selected.people === null || selected.quantity !== 1 : selected.people !== null)
      return null;
    const participants = perPerson ? selected.people!.length : guestCount;
    if (definition.maxGuests !== null && participants > definition.maxGuests) return null;
    let dates = selected.dates;
    if (perNight) {
      if (dates === null)
        dates = Array.from(
          { length: (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000 },
          (_, i) => new Date(Date.parse(stay.checkIn) + i * 86400000).toISOString().slice(0, 10),
        );
      if (dates.some((date) => date >= stay.checkOut)) return null;
    } else if (dates === null) {
      // VAY-2391: the add-on's own day (check-in, check-out, or none for anytime). Guest-pick add-ons stay
      // undated, which the booking refuses. Days today's booking page sends still count, on any weekday,
      // until the page that sends none is live (VAY-2391 part 4 refuses them).
      dates = addonScheduledDates(definition.scheduleMode, stay);
    } else if (dates.length !== 1) return null;
    const peopleMultiplier = perPerson ? participants : 1,
      daysMultiplier = perNight ? dates!.length : 1;
    const amount =
      BigInt(definition.amountMinor) *
      BigInt(selected.quantity) *
      BigInt(peopleMultiplier) *
      BigInt(daysMultiplier);
    total += amount;
    if (!isMinorAmount(amount.toString()) || !isMinorAmount(total.toString())) return null;
    lines.push({
      definition,
      quantity: selected.quantity,
      people: selected.people,
      dates: dates === null ? null : [...dates].sort(),
      peopleMultiplier,
      daysMultiplier,
      amountMinor: amount.toString(),
    });
  }
  return {
    kind: "addon_components" as const,
    evaluatorVersion: "booking.addon-components.v2" as const,
    sourceRevision: owner.sourceRevision,
    requestKey: replacementStayKey(stay),
    currency: stay.currency,
    lines,
    totalMinor: total.toString(),
  };
}
