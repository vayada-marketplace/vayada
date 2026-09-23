import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { parseBookingPublicContent } from "@vayada/domain-distribution/booking-publication";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { mapReplacementPublicOffers } from "./replacementPublicOfferMapping.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";

/** Published public choices only; no date-specific price, inventory hold or booking authority. */
export function createPublicPricingOfferCatalog(
  pool: Pool,
  options: {
    assertRuntimeScope?: (
      client: PoolClient,
    ) => Promise<{ propertyId: string; organizationId: string }>;
  } = {},
) {
  return {
    async read(slug: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const assigned = await options.assertRuntimeScope?.(client);
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return null;
        if (
          assigned &&
          (assigned.propertyId !== owner.scope.propertyId ||
            assigned.organizationId !== owner.scope.organizationId)
        )
          return null;
        const mapped = mapReplacementPublicOffers(owner);
        if (!mapped) return null;
        const row = (
          await client.query(
            `SELECT revision.public_content FROM distribution.active_public_booking_revision active
           JOIN distribution.public_booking_content_revisions revision
             ON revision.id=active.content_revision_id AND revision.property_id=active.property_id
           WHERE active.property_id=$1 FOR SHARE OF active,revision`,
            [owner.scope.propertyId],
          )
        ).rows[0];
        const content = parseBookingPublicContent(row?.public_content);
        if (
          !content ||
          content.profile.hotel.propertyId !== owner.scope.propertyId ||
          content.profile.hotel.slug !== slug ||
          content.rooms.length !== mapped.length
        )
          return null;
        const eligibility = await readPmsRoomOperatingEligibility(client, owner.scope.propertyId);
        const operating = new Set(
          eligibility.filter((room) => room.state === "operating").map((room) => room.roomTypeId),
        );
        for (const room of content.rooms) {
          const current = mapped.find((candidate) => candidate.roomTypeId === room.roomTypeId);
          if (
            !operating.has(room.roomTypeId) ||
            !current ||
            !isDeepStrictEqual(room.rates, current.offers)
          )
            return null;
        }
        const current = await lockPublicPricingAuthority(client, slug);
        if (
          !current ||
          !isDeepStrictEqual(current, owner.scope) ||
          (assigned &&
            (assigned.propertyId !== current.propertyId ||
              assigned.organizationId !== current.organizationId))
        )
          return null;
        return {
          version: "public-pricing-offers.v1" as const,
          rooms: content.rooms.map((room) => ({
            roomTypeId: room.roomTypeId,
            name: room.name,
            description: room.description,
            occupancy: room.occupancy,
            images: room.images,
            offers: mapped
              .find((current) => current.roomTypeId === room.roomTypeId)!
              .offers.map((rate) => ({
                publicOfferKey: rate.ratePlanId,
                currency: rate.currency,
                mealPlan: rate.mealPlan,
              })),
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
