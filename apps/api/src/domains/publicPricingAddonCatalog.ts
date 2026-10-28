import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockReplacementAddons } from "./replacementAddons.js";
import { addonLeadTimeEarliestArrival, type AddonLeadTimeHours } from "./addonLeadTime.js";
import { readPricingCheckInPlace } from "./pricingManualPaymentLead.js";

/** Current, explicitly public Booking definitions. Unpriced discovery only;
 * selected people/dates, availability and amounts are validated by the quote owner. */
export function createPublicPricingAddonCatalog(pool: Pool) {
  return {
    async read(slug: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return null;
        const propertyId = owner.scope.propertyId,
          currency = owner.publication.currency;
        // The publication reader holds inventory/identity locks first. Block FK-backed
        // inserts before discovering IDs; the shared owner then validates all selected rows.
        await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
          propertyId,
        ]);
        const settings = (
          await client.query(
            "SELECT show_addons_step, addons_enabled FROM booking.booking_settings WHERE property_id=$1 FOR SHARE",
            [propertyId],
          )
        ).rows[0];
        const ids =
          // VAY-2200: the Feature Hub Add-ons switch hides the list like the page's own choice.
          settings?.show_addons_step === false || settings?.addons_enabled === false
            ? []
            : (
                await client.query(
                  `SELECT id FROM booking.addon_definitions WHERE property_id=$1
           AND status='active' AND public_visible=true AND currency=$2 ORDER BY id FOR SHARE`,
                  [propertyId, currency],
                )
              ).rows.map((row) => row.id as string);
        const addons = [];
        // 99 bounds one quote selection, not the number of configured public extras.
        // Keep every batch under the same locks, including an empty-owner validation.
        for (let offset = 0; offset < Math.max(ids.length, 1); offset += 99) {
          const current = await lockReplacementAddons(client, {
            propertyId,
            currency,
            addonIds: ids.slice(offset, offset + 99),
          });
          if (!current) return null;
          addons.push(...current.addons);
        }
        const place = addons.some((addon) => addon.leadTimeHours !== null)
          ? await readPricingCheckInPlace(client, propertyId)
          : null;
        // One date per lead time: there are only five.
        const bookableFrom = new Map<number, string | null>();
        const firstDate = (hours: AddonLeadTimeHours) => {
          if (!place) return null;
          if (!bookableFrom.has(hours))
            bookableFrom.set(
              hours,
              addonLeadTimeEarliestArrival({ hours, place: place.place, now: place.now }),
            );
          return bookableFrom.get(hours)!;
        };
        const confirmed = await lockPublicPricingAuthority(client, slug);
        if (!confirmed || !isDeepStrictEqual(confirmed, owner.scope)) return null;
        return {
          version: "public-pricing-addons.v1" as const,
          // Free-text lead times from before VAY-2232 stay hidden until they are converted.
          addons: addons
            .filter((addon) => !addon.legacyLeadTime)
            .map((addon) => ({
              id: addon.id,
              name: addon.name,
              currency: addon.currency,
              pricingModel: addon.pricingModel,
              maxQuantity: Math.min(addon.maxQuantity, 99),
              maxGuests: addon.maxGuests,
              leadTimeHours: addon.leadTimeHours,
              // The first property-local check-in date the quote accepts it for; null when it
              // needs no notice, or when that date is unknown (then it can't be added).
              bookableFrom: addon.leadTimeHours === null ? null : firstDate(addon.leadTimeHours),
              // VAY-2391: when it happens; only guest_pick asks for a day, on these weekdays.
              scheduleMode: addon.scheduleMode,
              bookableWeekdays: addon.bookableWeekdays,
            })),
        };
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    },
  };
}
