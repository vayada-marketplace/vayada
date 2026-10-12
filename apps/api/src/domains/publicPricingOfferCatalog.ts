import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import {
  parseBookingPublicContent,
  type BookingPublicContent,
} from "@vayada/domain-distribution/booking-publication";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { publicPricingOfferKey } from "./publicPricingRoomStay.js";
import { mapReplacementPublicOffers } from "./replacementPublicOfferMapping.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";

type Owner = NonNullable<Awaited<ReturnType<typeof lockCurrentPricingPublication>>>;
type Published = Readonly<{ content: BookingPublicContent; pricingSourceRevision: string }>;

/** Published public choices only; no date-specific price, inventory hold or booking authority.
 * Saved price, terms or Finance changes serve at once; a changed room or offer set waits for
 * the next publication (VAY-2123). Offer keys always bind the current pricing revision. */
export function createPublicPricingOfferCatalog(pool: Pool, options: PublishedContentOptions = {}) {
  return {
    async read(slug: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return null;
        const mapped = mapReplacementPublicOffers(owner);
        if (!mapped) return null;
        const published = await readActivePublication(client, owner.scope.propertyId, options);
        if (!published) return null;
        const { content } = published;
        if (
          content.profile.hotel.propertyId !== owner.scope.propertyId ||
          content.profile.hotel.slug !== slug ||
          !sameRoomsAndOffers(owner, published)
        )
          return null;
        const eligibility = await readPmsRoomOperatingEligibility(client, owner.scope.propertyId);
        const operating = new Set(
          eligibility.filter((room) => room.state === "operating").map((room) => room.roomTypeId),
        );
        if (content.rooms.some((room) => !operating.has(room.roomTypeId))) return null;
        const current = await lockPublicPricingAuthority(client, slug);
        if (!current || !isDeepStrictEqual(current, owner.scope)) return null;
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

/** For the owner's review screen, not public access: whether the published booking page still
 * lists the current rooms and offers. Null without a published page or current prices. */
export function createPublishedOfferCheck(pool: Pool, options: PublishedContentOptions = {}) {
  return {
    async matchCurrent(scope: { organizationId: string; propertyId: string }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockCurrentPricingPublication(client, scope);
        const published = owner && (await readActivePublication(client, scope.propertyId, options));
        return owner && published ? sameRoomsAndOffers(owner, published) : null;
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

/** Bank-transfer and PayPal pages count only while their acceptance is on (VAY-2139). */
type PublishedContentOptions = { manualPayments?: boolean };

async function readActivePublication(
  client: PoolClient,
  propertyId: string,
  options: PublishedContentOptions,
): Promise<Published | null> {
  const row = (
    await client.query(
      `SELECT revision.public_content,revision.source_manifest
       FROM distribution.active_public_booking_revision active
       JOIN distribution.public_booking_content_revisions revision
         ON revision.id=active.content_revision_id AND revision.property_id=active.property_id
       WHERE active.property_id=$1 FOR SHARE OF active,revision`,
      [propertyId],
    )
  ).rows[0];
  const content = parseBookingPublicContent(row?.public_content, options);
  // The page's offer keys derive from the PMS pricing source revision it was built from.
  const sources: unknown = row?.source_manifest?.sources;
  const pricing = Array.isArray(sources)
    ? sources.filter(
        (source) =>
          source?.ownerDomain === "pms" &&
          source.entityType === "pms_pricing_publication.v2" &&
          source.entityId === propertyId &&
          typeof source.revision === "string",
      )
    : [];
  return content && pricing.length === 1
    ? { content, pricingSourceRevision: pricing[0].revision }
    : null;
}

/** Same rooms, and per room the same offers by offer, meal plan and currency. */
function sameRoomsAndOffers(owner: Owner, published: Published): boolean {
  const identity = (roomTypeId: string, offers: readonly string[]) =>
    JSON.stringify([roomTypeId, [...offers].sort()]);
  const current = owner.publication.rooms.map((room) =>
    identity(
      room.roomTypeId,
      room.offers.map((offer) =>
        JSON.stringify([
          publicPricingOfferKey(published.pricingSourceRevision, room.roomTypeId, offer.id),
          offer.meal.kind,
          owner.publication.currency,
        ]),
      ),
    ),
  );
  const shown = published.content.rooms.map((room) =>
    identity(
      room.roomTypeId,
      room.rates.map((rate) =>
        JSON.stringify([rate.ratePlanId, "mealPlan" in rate ? rate.mealPlan : null, rate.currency]),
      ),
    ),
  );
  return isDeepStrictEqual(current.sort(), shown.sort());
}
