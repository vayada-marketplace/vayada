import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import {
  mapReplacementPublicOffers,
  publicOfferCancellations,
  publicOfferMealDescriptions,
  publicOfferPaymentMethods,
  publicOfferPaymentSchedules,
} from "./replacementPublicOfferMapping.js";
import type { PricingPaymentSwitches } from "./pricingRatePayability.js";
import { readPmsRoomOperatingEligibility } from "./pmsRoomOperatingEligibility.js";
import { toPublicPmsRoomAmenityLabelsV1 } from "./pmsRoomAmenityVocabulary.js";
import { guestRoomLocation, readGuestLocation, type MapPin } from "./bookingLocationMap.js";

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
  category: string | null;
  attributes: unknown;
  amenities: unknown;
  media: { mediaObjectId: string; altText: string | null }[];
};

/** Public offer choices only; no date-specific price, inventory hold or booking authority.
 * The hotel's first booking-page publication is its go-live (VAY-2129). After that, the
 * catalog follows what is saved now: priced, operating rooms with their current content and
 * offers. Offer keys always bind the current pricing revision. Only rates guests can pay now
 * are offered, with the booking page's `payments` switches (VAY-2304); a room left with none is
 * left out. Without switches, Finance's ready methods alone decide. Each offer names those ways to
 * pay (VAY-2309), read live like the rest. */
export function createPublicPricingOfferCatalog(
  pool: Pool,
  options: { mediaServing?: MediaServing; payments?: PricingPaymentSwitches } = {},
) {
  const payments = options.payments ?? {
    card: true,
    deposits: true,
    manual: ["bank_transfer", "paypal"],
  };
  return {
    async read(slug: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const owner = await lockPublicPricingPublication(client, slug);
        if (!owner) return null;
        const mapped = mapReplacementPublicOffers(owner);
        if (!mapped) return null;
        const cancellations = publicOfferCancellations(owner);
        const mealDescriptions = publicOfferMealDescriptions(owner);
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
        const methods = publicOfferPaymentMethods(owner, payments);
        const schedules = publicOfferPaymentSchedules(owner);
        const offered = mapped
          .filter((room) => operating.has(room.roomTypeId))
          .map((room) => ({
            ...room,
            offers: room.offers.filter((rate) => !!methods.get(rate.ratePlanId)?.length),
          }))
          .filter((room) => room.offers.length > 0);
        const content = await readRoomContent(client, propertyId, offered);
        // The location map switch (VAY-2126) is read live. A room's own "Show map in room details" works
        // without it (VAY-2445): while it is off, only those rooms carry their place.
        const guestLocation = await readGuestLocation(client, propertyId);
        const locationMap = guestLocation?.enabled ? guestLocation.map : null;
        const offeredRooms = new Map(offered.map((room) => [room.roomTypeId, room]));
        const rooms = [];
        // In the hotel's saved room order (Calendar → Reorder rooms, VAY-2315), read live like the
        // rooms' content, so a new order shows without publishing.
        for (const row of content.values()) {
          const room = offeredRooms.get(row.roomTypeId);
          const facts = roomFacts(row);
          // A room whose saved facts are incomplete is left out; the others stay bookable.
          if (!room || !facts) continue;
          rooms.push({
            roomTypeId: room.roomTypeId,
            name: facts.name,
            description: facts.description,
            occupancy: facts.occupancy,
            ...roomCardFacts(row),
            ...(guestLocation &&
              roomLocation(row, guestLocation.propertyPin, guestLocation.enabled)),
            images: await roomImages(client, options.mediaServing, organizationId, row),
            offers: room.offers.map((rate) => ({
              publicOfferKey: rate.ratePlanId,
              currency: rate.currency,
              mealPlan: rate.mealPlan,
              // Additive (VAY-2188). A mapped offer always has its terms; null would mean unknown.
              cancellation: cancellations.get(rate.ratePlanId) ?? null,
              // Additive (VAY-2281), only when the hotel wrote one.
              ...(mealDescriptions.has(rate.ratePlanId) && {
                mealDescription: mealDescriptions.get(rate.ratePlanId)!,
              }),
              // Additive (VAY-2309): the ways guests can pay this rate now, so the booking page
              // prices the stay with one of them first.
              paymentMethods: [...methods.get(rate.ratePlanId)!],
              // Additive (VAY-2320): how the rate is paid, so a group combines only rates paid
              // the same way.
              ...(schedules.has(rate.ratePlanId) && {
                paymentSchedule: schedules.get(rate.ratePlanId)!,
              }),
            })),
          });
        }
        if (!rooms.length) return null;
        const current = await lockPublicPricingAuthority(client, slug);
        if (!current || !isDeepStrictEqual(current, owner.scope)) return null;
        return {
          version: "public-pricing-offers.v1" as const,
          rooms,
          // Additive (VAY-2126): only while the hotel shows the location map.
          ...(locationMap && { locationMap }),
          // Additive (VAY-2445): the property's place for the rooms' own details maps, whatever the switch says.
          ...(guestLocation && { detailsMap: guestLocation.map }),
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

/** The rooms' saved content, in the order the Calendar and Rooms & Rates list room types. */
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
       room_type.category,
       room_type.room_attributes AS "attributes",
       room_type.amenities_snapshot AS "amenities",
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
     GROUP BY room_type.property_id, room_type.id
     ORDER BY room_type.sort_order, room_type.name, room_type.id`,
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

/** What the booking page's room cards show besides name and photos (VAY-2190): size in square
 * metres, the room's category, its bedrooms and bathrooms (VAY-2410) and its amenities as public
 * labels. Each is empty when unusable. */
export function roomCardFacts(row: Pick<RoomRow, "category" | "attributes" | "amenities">) {
  const attributes = (
    row.attributes && typeof row.attributes === "object" ? row.attributes : {}
  ) as Record<string, unknown>;
  const raw = attributes["size"];
  const { bedrooms, bathrooms } = attributes;
  const rooms = (value: unknown): value is number =>
    typeof value === "number" && value > 0 && value <= 100;
  const sqm =
    typeof raw === "number"
      ? raw
      : raw && typeof raw === "object" && (raw as Record<string, unknown>)["unit"] === "sqm"
        ? (raw as Record<string, unknown>)["value"]
        : null;
  const key = row.category?.trim() ?? "";
  // Category keys ("suite", "family_room") read as labels like the amenity labels do.
  const category = /^[a-z0-9_]+$/.test(key)
    ? `${key.charAt(0).toUpperCase()}${key.slice(1).replaceAll("_", " ")}`
    : key;
  const amenities = Array.isArray(row.amenities)
    ? row.amenities.filter(
        (amenity): amenity is string =>
          typeof amenity === "string" && !!amenity.trim() && amenity.length <= 80,
      )
    : [];
  return {
    size:
      typeof sqm === "number" && Number.isFinite(sqm) && sqm > 0
        ? { value: sqm, unit: "sqm" as const }
        : null,
    category: category && category.length <= 80 ? category : null,
    // As the room facts save them: whole bedrooms (0 is a studio, not shown), bathrooms as entered
    // (1.5 for a shower room; none when shared).
    bedrooms: rooms(bedrooms) && Number.isInteger(bedrooms) ? bedrooms : null,
    bathrooms: rooms(bathrooms) ? bathrooms : null,
    amenities: toPublicPmsRoomAmenityLabelsV1(amenities).slice(0, 40),
  };
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

/** A room's place for the guest location map (VAY-2321): at the property, or its own pin with its address. A
 * room shown as an area gets its pin rounded and its area's name, never its street. While the location map is
 * off (`listed` false), only a room that shows its place in its details sends it (VAY-2445). */
function roomLocation(
  row: RoomRow,
  propertyPin: MapPin | null,
  listed: boolean,
): {
  atProperty: boolean;
  showMapInDetails: boolean;
  location?:
    | { latitude: number; longitude: number; address?: string }
    | { latitude: number; longitude: number; approximate: true; area?: string };
} {
  const { atProperty, approximate, pin, address, showMapInDetails } = guestRoomLocation(
    row.attributes,
    propertyPin,
  );
  if (!pin || (!listed && !showMapInDetails)) return { atProperty, showMapInDetails };
  return {
    atProperty,
    showMapInDetails,
    location: approximate
      ? { ...pin, approximate: true, ...(address && { area: address }) }
      : { ...pin, ...(address && { address }) },
  };
}
