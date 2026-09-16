import type { Pool } from "pg";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
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
  };
}
export type ReplacementPricingPublicationReader = ReturnType<
  typeof createReplacementPricingPublicationReader
>;
