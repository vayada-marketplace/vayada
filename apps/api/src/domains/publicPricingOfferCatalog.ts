import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { mapReplacementPublicOffers } from "./replacementPublicOfferMapping.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";

type MediaServing = Pick<
  PlatformMediaServingConfig,
  "bucketName" | "cdnBaseUrl" | "publicPathPrefix"
>;
type RoomRow = {
  propertyId: string;
  roomTypeId: string;
  name: string;
  description: string | null;
  occupancyLimits: unknown;
  media: { mediaObjectId: string; altText: string | null }[];
};

/** Public offer choices only; no date-specific price, inventory hold or booking authority.
 * The hotel's first booking-page publication is its go-live (VAY-2129). After that, the
 * catalog follows what is saved now: priced, operating rooms with their current content and
 * offers. Offer keys always bind the current pricing revision. */
export function createPublicPricingOfferCatalog(
  pool: Pool,
  options: { mediaServing?: MediaServing } = {},
) {
  return {
    async read(slug: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return null;
        const mapped = mapReplacementPublicOffers(owner);
        if (!mapped) return null;
        const { propertyId, organizationId } = owner.scope;
        const live = await client.query(
          "SELECT 1 FROM distribution.active_public_booking_revision WHERE property_id=$1 FOR SHARE",
          [propertyId],
        );
        if (!live.rows.length) return null;
        const operating = new Set(
          (await readPmsRoomOperatingEligibility(client, propertyId))
            .filter((room) => room.state === "operating")
            .map((room) => room.roomTypeId),
        );
        const offered = mapped.filter((room) => operating.has(room.roomTypeId));
        const content = await readRoomContent(client, propertyId, offered);
        const rooms = [];
        for (const room of offered) {
          const row = content.get(room.roomTypeId);
          const facts = row && roomFacts(row);
          // A room whose saved facts are incomplete is left out; the others stay bookable.
          if (!row || !facts) continue;
          rooms.push({
            roomTypeId: room.roomTypeId,
            name: facts.name,
            description: facts.description,
            occupancy: facts.occupancy,
            images: await roomImages(client, options.mediaServing, organizationId, row),
            offers: room.offers.map((rate) => ({
              publicOfferKey: rate.ratePlanId,
              currency: rate.currency,
              mealPlan: rate.mealPlan,
            })),
          });
        }
        if (!rooms.length) return null;
        const current = await lockPublicPricingAuthority(client, slug);
        if (!current || !isDeepStrictEqual(current, owner.scope)) return null;
        return { version: "public-pricing-offers.v1" as const, rooms };
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

async function readRoomContent(
  client: PoolClient,
  propertyId: string,
  rooms: readonly { roomTypeId: string }[],
): Promise<Map<string, RoomRow>> {
  const result = await client.query<RoomRow>(
    `SELECT
       room_type.property_id::text AS "propertyId",
       room_type.id::text AS "roomTypeId",
       room_type.name,
       room_type.description,
       room_type.occupancy_limits AS "occupancyLimits",
       COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'mediaObjectId', assignment.platform_media_object_id::text,
             'altText', assignment.alt_text
           )
           ORDER BY assignment.sort_order, assignment.platform_media_object_id
         ) FILTER (WHERE assignment.platform_media_object_id IS NOT NULL),
         '[]'::jsonb
       ) AS media
     FROM pms.room_types room_type
     LEFT JOIN pms.room_type_media assignment
       ON assignment.property_id = room_type.property_id
      AND assignment.room_type_id = room_type.id
     WHERE room_type.property_id = $1::uuid AND room_type.id = ANY($2::uuid[])
     GROUP BY room_type.property_id, room_type.id`,
    [propertyId, rooms.map((room) => room.roomTypeId)],
  );
  return new Map(result.rows.map((row) => [row.roomTypeId, row]));
}

/** Name, description and occupancy as the booking publication maps them; a room whose name
 * or occupancy is unusable is left out. */
function roomFacts(row: RoomRow) {
  const limits = (
    row.occupancyLimits && typeof row.occupancyLimits === "object" ? row.occupancyLimits : {}
  ) as Record<string, unknown>;
  const occupancy = {
    maxGuests: limits["total"],
    maxAdults: limits["adults"] ?? limits["total"],
    maxChildren: limits["children"] ?? limits["total"],
  };
  const count = (value: unknown, minimum: number): value is number =>
    Number.isSafeInteger(value) && (value as number) >= minimum;
  return row.name.trim() &&
    count(occupancy.maxGuests, 1) &&
    count(occupancy.maxAdults, 1) &&
    count(occupancy.maxChildren, 0)
    ? {
        name: row.name,
        description: row.description ?? "",
        occupancy: occupancy as { maxGuests: number; maxAdults: number; maxChildren: number },
      }
    : null;
}

/** Approved public photos through the shared media resolver. A room is shown without photos
 * when one of them is not publicly ready, media serving is not configured or the lookup fails;
 * a savepoint keeps a failed lookup from aborting the guest's read. */
async function roomImages(
  client: PoolClient,
  serving: MediaServing | undefined,
  organizationId: string,
  row: RoomRow,
): Promise<{ url: string; alt: string | null }[]> {
  if (!serving || !row.media.length) return [];
  await client.query("SAVEPOINT room_images");
  try {
    const resolver = createPgHotelMediaResolutionPort({
      connectionString: "caller-transaction",
      serving,
      pool: {
        query: (text, values) => client.query(text, values as unknown[]),
        end: async () => {},
      },
    });
    const resolved = await resolver.loadPublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "room_type", propertyId: row.propertyId, roomTypeId: row.roomTypeId },
      mediaObjectIds: row.media.map((assignment) => assignment.mediaObjectId),
    });
    await client.query("RELEASE SAVEPOINT room_images");
    if (!resolved.ok) return [];
    return row.media.flatMap((assignment, index) => {
      const image = resolved.media[index]?.publicVariants.find(
        (variant) => variant.variantName === "original_safe",
      );
      return image ? [{ url: image.publicUrl, alt: assignment.altText }] : [];
    });
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT room_images");
    return [];
  }
}
