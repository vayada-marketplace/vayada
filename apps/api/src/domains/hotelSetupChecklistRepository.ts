import { FIRST_RUN_GUEST_TERMS } from "@vayada/domain-booking";
import type {
  HotelGoLiveRoomType,
  HotelSetupChecklistAcknowledgeable,
} from "@vayada/domain-hotels";
import type { QueryResult, QueryResultRow } from "pg";

import { APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE } from "../platform/propertyMediaPublicationJob.js";
import { FIRST_RUN_PLACEHOLDER_PUBLISH_STEP } from "./hotelFirstRunPricing.js";
import { onlineCardReadySql } from "./financeOnlineCardReadySql.js";
import type {
  HotelGoLiveFactsRow,
  HotelSetupChecklistPorts,
  HotelSetupChecklistViewerChange,
} from "./hotelSetupChecklistService.js";
import type { HotelFirstRunActor } from "./hotelFirstRunSteps.js";

type Pool = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows">>;
};

/** An approved public image of the hotel (`media_types`), servable to guests. */
const hotelImage = (mediaTypes: string) => `EXISTS (
  SELECT 1
  FROM hotel_catalog.property_media media
  JOIN platform.media_objects media_object
    ON media_object.id = media.platform_media_object_id
   AND media_object.property_id = media.property_id
   AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
  JOIN platform.media_variants variant
    ON variant.media_object_id = media_object.id
   AND variant.variant_name = 'original_safe'
   AND variant.visibility = 'public'
   AND NULLIF(variant.public_cdn_url, '') IS NOT NULL
  WHERE media.property_id = property.id
    AND media.public_approved = TRUE
    AND media.source_system = 'platform'
    AND media.media_type IN (${mediaTypes})
)`;

/** "Looks good", else changed (terms that aren't setup's text, or guest rules saved later), else default; $3 is the default text. */
const GUEST_TERMS = `CASE
    WHEN EXISTS (
      SELECT 1 FROM hotel_catalog.setup_checklist_acknowledgements ack
      WHERE ack.property_id = property.id AND ack.item = 'guest_terms'
    ) THEN 'acknowledged'
    WHEN EXISTS (
      SELECT 1 FROM hotel_catalog.property_policy_summaries summary
      WHERE summary.property_id = property.id
        AND NULLIF(btrim(summary.terms_and_conditions), '') IS NOT NULL
        AND btrim(summary.terms_and_conditions) <> btrim($3::text)
    )
    OR EXISTS (
      SELECT 1
      FROM booking.guest_choice_heads head
      JOIN booking.guest_choice_revisions revision
        ON revision.property_id = head.property_id AND revision.revision = head.revision
      WHERE head.property_id = property.id
        AND revision.request_id NOT LIKE 'first-run:v1:guest_rules:%'
    ) THEN 'changed'
    ELSE 'default'
  END`;

const ONLINE_CARD_READY = `COALESCE(
    (SELECT ${onlineCardReadySql("readiness", "settings")}
     FROM finance.online_card_readiness_by_provider readiness
     JOIN finance.payment_settings settings ON settings.property_id = readiness.property_id
     WHERE readiness.property_id = property.id),
    FALSE
  )`;

/**
 * VAY-2451: the go-live list's facts, in one query: the profile, the page, hotel photos, the booking rules
 * (as guest terms above), online cards, each active room type (rooms, guests, approved photos, saved prices)
 * and whether the current prices are the first run's placeholder, or a payment re-publish of it. $4 is the
 * start of the placeholder publish's request id.
 */
const GO_LIVE_FACTS_SQL = `
SELECT
  property.profile_status = 'complete' AS "propertyDetails",
  EXISTS (
    SELECT 1 FROM distribution.active_public_booking_revision active
    WHERE active.property_id = property.id
  ) AS "bookingPublished",
  ${hotelImage("'hero_image', 'gallery_image'")} AS "propertyPhotos",
  ${GUEST_TERMS} AS "bookingRules",
  ${ONLINE_CARD_READY} AS "onlineCardReady",
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
        'name', room_type.name,
        'rooms', (
          SELECT count(*) FROM pms.rooms room
          WHERE room.property_id = room_type.property_id
            AND room.room_type_id = room_type.id
            AND room.status <> 'retired'
        ),
        'maxGuests', COALESCE((
          SELECT least(trunc((room_type.occupancy_limits ->> key)::numeric), 1000)::integer
          FROM unnest(ARRAY['total', 'maxOccupancy']) WITH ORDINALITY AS keys(key, position)
          WHERE jsonb_typeof(room_type.occupancy_limits -> key) = 'number'
          ORDER BY position
          LIMIT 1
        ), 0),
        'photos', (
          SELECT count(*)
          FROM pms.room_type_media media
          JOIN platform.media_objects media_object
            ON media_object.id = media.platform_media_object_id
           AND media_object.property_id = media.property_id
           AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
          WHERE media.property_id = room_type.property_id AND media.room_type_id = room_type.id
        ),
        'priced', EXISTS (
          SELECT 1 FROM pms.pricing_v2_heads head
          JOIN pms.pricing_v2_rooms priced
            ON priced.property_id = head.property_id AND priced.revision = head.revision
          WHERE head.property_id = room_type.property_id
            AND priced.room_type_id = room_type.id
            AND jsonb_typeof(priced.configuration -> 'offers') = 'array'
            AND jsonb_array_length(priced.configuration -> 'offers') > 0
        )
      ) ORDER BY room_type.sort_order, room_type.created_at, room_type.id)
    FROM pms.room_types room_type
    WHERE room_type.property_id = property.id AND room_type.active
  ), '[]'::jsonb) AS "roomTypes",
  EXISTS (
    SELECT 1 FROM pms.pricing_v2_heads head
    JOIN pms.pricing_v2_revisions revision
      ON revision.property_id = head.property_id AND revision.revision = head.revision
    WHERE head.property_id = property.id AND starts_with(revision.request_id, $4::text)
  ) AS "placeholderPrices",
  COALESCE(viewer.hidden, FALSE) AS hidden,
  COALESCE(viewer.dismissed, FALSE) AS dismissed
FROM hotel_catalog.properties property
LEFT JOIN hotel_catalog.setup_checklist_viewer_states viewer
  ON viewer.property_id = property.id AND viewer.user_id = $2::uuid
WHERE property.id = $1::uuid`;

type GoLiveRow = Omit<HotelGoLiveFactsRow, "viewer" | "roomTypes"> & {
  roomTypes: Array<
    Omit<HotelGoLiveRoomType, "rooms" | "photos"> & {
      rooms: number | string;
      photos: number | string;
    }
  >;
  hidden: boolean;
  dismissed: boolean;
};

export function createPgHotelSetupChecklistRepository(
  pool: Pool,
): Pick<HotelSetupChecklistPorts, "goLiveFacts" | "store"> {
  return {
    goLiveFacts: {
      async read(actor: HotelFirstRunActor) {
        const result = await pool.query<GoLiveRow>(GO_LIVE_FACTS_SQL, [
          actor.propertyId,
          actor.userId,
          FIRST_RUN_GUEST_TERMS,
          `first-run:v1:${FIRST_RUN_PLACEHOLDER_PUBLISH_STEP}:`,
        ]);
        const row = result.rows[0];
        if (!row) return null;
        const { hidden, dismissed, roomTypes, ...facts } = row;
        return Object.freeze({
          ...facts,
          // Numbers in the JSON; Number() also covers a driver that hands them over as text.
          roomTypes: Object.freeze(
            roomTypes.map((room) =>
              Object.freeze({ ...room, rooms: Number(room.rooms), photos: Number(room.photos) }),
            ),
          ),
          viewer: Object.freeze({ hidden, dismissed }),
        });
      },
    },
    store: {
      // "Looks good" is for the whole hotel; a later one by someone else updates who and when.
      async acknowledge(actor: HotelFirstRunActor, item: HotelSetupChecklistAcknowledgeable) {
        await pool.query(
          `INSERT INTO hotel_catalog.setup_checklist_acknowledgements
             (property_id, item, acknowledged_by_user_id, acknowledged_at)
           VALUES ($1::uuid, $2::text, $3::uuid, now())
           ON CONFLICT (property_id, item) DO UPDATE
           SET acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
               acknowledged_at = EXCLUDED.acknowledged_at`,
          [actor.propertyId, item, actor.userId],
        );
      },
      // Hide for now and Dismiss are the signed-in person's own; what isn't sent stays.
      async setViewer(actor: HotelFirstRunActor, change: HotelSetupChecklistViewerChange) {
        await pool.query(
          `INSERT INTO hotel_catalog.setup_checklist_viewer_states
             (property_id, user_id, hidden, dismissed, updated_at)
           VALUES ($1::uuid, $2::uuid, COALESCE($3::boolean, FALSE), COALESCE($4::boolean, FALSE), now())
           ON CONFLICT (property_id, user_id) DO UPDATE
           SET hidden = COALESCE($3::boolean, setup_checklist_viewer_states.hidden),
               dismissed = COALESCE($4::boolean, setup_checklist_viewer_states.dismissed),
               updated_at = now()`,
          [actor.propertyId, actor.userId, change.hidden ?? null, change.dismissed ?? null],
        );
      },
    },
  };
}
