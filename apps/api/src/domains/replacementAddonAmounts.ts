import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import {
  parseReplacementStay,
  parsePublicPricingSelection,
  replacementStayKey,
} from "@vayada/domain-booking";
import { isMinorAmount } from "@vayada/domain-pms";
import { lockReplacementAddons } from "./replacementAddons.js";
import { addonLeadTimeAllows } from "./addonLeadTime.js";
import { addonScheduledDates, isoWeekday } from "./addonSchedule.js";
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
    // VAY-2391: the days follow when the add-on happens. The guest sends a day only for a guest-pick
    // add-on; a day list for any other must be the add-on's own.
    const sent = selected.dates === null ? null : [...selected.dates].sort();
    let dates: string[] | null = sent;
    if (perNight) {
      // Every night of the stay.
      const nights = Array.from(
        { length: (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000 },
        (_, i) => new Date(Date.parse(stay.checkIn) + i * 86400000).toISOString().slice(0, 10),
      );
      if (sent !== null && !isDeepStrictEqual(sent, nights)) return null;
      dates = nights;
    } else if (definition.scheduleMode === "guest_pick") {
      // A night of the stay on a weekday it is offered; without one it stays undated, which the
      // booking refuses.
      if (
        sent !== null &&
        (sent.length !== 1 ||
          sent[0]! >= stay.checkOut ||
          !definition.bookableWeekdays.includes(isoWeekday(sent[0]!)))
      )
        return null;
    } else {
      // Check-in for arrival, check-out for departure, no day for anytime.
      const scheduled = addonScheduledDates(definition.scheduleMode, stay);
      if (sent !== null && !isDeepStrictEqual(sent, scheduled)) return null;
      dates = scheduled;
    }
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
      dates,
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
