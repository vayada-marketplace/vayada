import type { Pool } from "pg";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { readPricingPublicationFreshness } from "./pricingPublicationFreshness.js";
import { mapReplacementPublicOffers } from "./replacementPublicOfferMapping.js";

/** Internal publication port; scope is supplied by authorized orchestration. */
export function createReplacementPricingPublicationReader(pool: Pool) {
  return {
    async getCurrentPricingOffers(scope: { propertyId: string; organizationId: string }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockCurrentPricingPublication(client, scope);
        const rooms = owner && mapReplacementPublicOffers(owner);
        await client.query("COMMIT");
        return owner && rooms
          ? { scope: owner.scope, sourceRevision: owner.pmsSourceRevision, rooms }
          : null;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    /** Why getCurrentPricingOffers found nothing, when a price save fixes it (VAY-2134).
     * Empty when the reason is not one the hotel can fix by saving prices. */
    async diagnoseMissingPricing(propertyId: string): Promise<readonly PricingGap[]> {
      const [report, ...rest] = await readPricingPublicationFreshness(pool, propertyId);
      if (rest.length) throw new Error("Pricing freshness escaped its property scope");
      if (!report) return ["not_published"];
      if (!("stale" in report) || report.propertyId !== propertyId.toLowerCase()) return [];
      if (report.stale.length) return report.stale.map((source) => STALE_SOURCE_GAPS[source]);
      // Saved prices of a hotel that is still being set up are not offered yet.
      const property = await pool.query(
        "SELECT lifecycle_status FROM hotel_catalog.properties WHERE id=$1::uuid",
        [propertyId],
      );
      return property.rows[0]?.lifecycle_status === "provisioning"
        ? ["hotel_setup_in_progress"]
        : [];
    },
  };
}

export type PricingGap =
  | "not_published"
  | "rooms_changed"
  | "terms_changed"
  | "payments_changed"
  | "hotel_setup_in_progress";
const STALE_SOURCE_GAPS = {
  room: "rooms_changed",
  terms: "terms_changed",
  finance: "payments_changed",
} as const satisfies Record<string, PricingGap>;
export type ReplacementPricingPublicationReader = ReturnType<
  typeof createReplacementPricingPublicationReader
>;
