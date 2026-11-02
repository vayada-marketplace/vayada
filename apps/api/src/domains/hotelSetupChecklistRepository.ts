import { FIRST_RUN_GUEST_TERMS } from "@vayada/domain-booking";
import type {
  HotelGoLiveRoomType,
  HotelSetupChecklistAcknowledgeable,
} from "@vayada/domain-hotels";
import type { QueryResult, QueryResultRow } from "pg";

import { APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE } from "../platform/propertyMediaPublicationJob.js";
import { FIRST_RUN_PLACEHOLDER_PUBLISH_STEP } from "./hotelFirstRunPricing.js";
import type {
  HotelGoLiveFactsRow,
  HotelSetupChecklistFactsRow,
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
    (SELECT readiness.online_card_ready FROM finance.online_card_readiness_by_provider readiness
     WHERE readiness.property_id = property.id),
    FALSE
  )`;

/**
 * VAY-2247 wave 2: everything the checklist reads beyond the first run's own state, in one query:
 * - hotel basics: the stored profile status (the basics rule, VAY-2247 1.4a);
 * - published: an active booking page revision;
 * - photos: an approved hotel photo, or a room photo approved like hotel media;
 * - style: a logo, or a page style other than the one the first run saved (its audit source);
 * - calendar: "Looks good", else changed when the latest calendar isn't open all year with 1 night
 *   minimum or auto-open was saved, else setup's default;
 * - guest terms: "Looks good", else changed when the terms aren't the default text or the guest rules
 *   were saved after the first run, else setup's default;
 * - online cards: finance's readiness view; and the signed-in person's own Hide for now / Dismiss.
 */
const FACTS_SQL = `
SELECT
  property.profile_status = 'complete' AS "hotelBasics",
  EXISTS (
    SELECT 1 FROM distribution.active_public_booking_revision active
    WHERE active.property_id = property.id
  ) AS "bookingPublished",
  (
    ${hotelImage("'hero_image', 'gallery_image'")}
    OR EXISTS (
      SELECT 1
      FROM pms.room_type_media room_media
      JOIN pms.room_types room_type
        ON room_type.id = room_media.room_type_id
       AND room_type.property_id = room_media.property_id
       AND room_type.active
      JOIN platform.media_objects media_object
        ON media_object.id = room_media.platform_media_object_id
       AND media_object.property_id = room_media.property_id
       AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
      WHERE room_media.property_id = property.id
    )
  ) AS photos,
  (
    ${hotelImage("'logo'")}
    OR EXISTS (
      SELECT 1 FROM booking.current_working_design_revisions current
      WHERE current.property_id = property.id
        AND NOT EXISTS (
          SELECT 1 FROM platform.product_audit_events audit
          WHERE audit.property_id = current.property_id
            AND audit.action = 'booking.design.created'
            AND audit.target_resource_id = current.revision_id::text
            AND audit.audit_metadata ->> 'source' = 'hotel_first_run'
        )
    )
  ) AS style,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM hotel_catalog.setup_checklist_acknowledgements ack
      WHERE ack.property_id = property.id AND ack.item = 'calendar'
    ) THEN 'acknowledged'
    WHEN EXISTS (
      SELECT 1 FROM pms.calendar_auto_open_settings settings
      WHERE settings.property_id = property.id
    )
    OR EXISTS (
      SELECT 1 FROM (
        SELECT revision.schedule_mode, revision.default_minimum_stay_nights
        FROM pms.operating_calendar_revisions revision
        WHERE revision.property_id = property.id
        ORDER BY revision.calendar_revision DESC
        LIMIT 1
      ) latest
      WHERE latest.schedule_mode <> 'year_round' OR latest.default_minimum_stay_nights <> 1
    ) THEN 'changed'
    ELSE 'default'
  END AS calendar,
  ${GUEST_TERMS} AS "guestTerms",
  ${ONLINE_CARD_READY} AS "onlineCardReady",
  COALESCE(viewer.hidden, FALSE) AS hidden,
  COALESCE(viewer.dismissed, FALSE) AS dismissed
FROM hotel_catalog.properties property
LEFT JOIN hotel_catalog.setup_checklist_viewer_states viewer
  ON viewer.property_id = property.id AND viewer.user_id = $2::uuid
WHERE property.id = $1::uuid`;

/**
 * VAY-2451: the go-live list's facts, in one query: the profile, the page, hotel photos, the booking rules
 * (as guest terms above), online cards, each active room type (rooms, guests, photos, saved prices) and
 * whether the current prices are the first run's placeholder. $4 is the placeholder publish's request id.
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
        'maxGuests', CASE WHEN jsonb_typeof(room_type.occupancy_limits -> 'total') = 'number'
          THEN (room_type.occupancy_limits ->> 'total')::numeric::integer ELSE 0 END,
        'photos', (
          SELECT count(*) FROM pms.room_type_media media
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
    WHERE head.property_id = property.id AND revision.request_id LIKE $4::text
  ) AS "placeholderPrices",
  COALESCE(viewer.hidden, FALSE) AS hidden,
  COALESCE(viewer.dismissed, FALSE) AS dismissed
FROM hotel_catalog.properties property
LEFT JOIN hotel_catalog.setup_checklist_viewer_states viewer
  ON viewer.property_id = property.id AND viewer.user_id = $2::uuid
WHERE property.id = $1::uuid`;

type FactsRow = Omit<HotelSetupChecklistFactsRow, "viewer"> & {
  hidden: boolean;
  dismissed: boolean;
};
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
): Pick<HotelSetupChecklistPorts, "facts" | "goLiveFacts" | "store"> {
  return {
    goLiveFacts: {
      async read(actor: HotelFirstRunActor) {
        const result = await pool.query<GoLiveRow>(GO_LIVE_FACTS_SQL, [
          actor.propertyId,
          actor.userId,
          FIRST_RUN_GUEST_TERMS,
          `first-run:v1:${FIRST_RUN_PLACEHOLDER_PUBLISH_STEP}:%`,
        ]);
        const row = result.rows[0];
        if (!row) return null;
        const { hidden, dismissed, roomTypes, ...facts } = row;
        return Object.freeze({
          ...facts,
          // count(*) comes back as text from pg's bigint.
          roomTypes: Object.freeze(
            roomTypes.map((room) =>
              Object.freeze({ ...room, rooms: Number(room.rooms), photos: Number(room.photos) }),
            ),
          ),
          viewer: Object.freeze({ hidden, dismissed }),
        });
      },
    },
    facts: {
      async read(actor: HotelFirstRunActor) {
        const result = await pool.query<FactsRow>(FACTS_SQL, [
          actor.propertyId,
          actor.userId,
          FIRST_RUN_GUEST_TERMS,
        ]);
        const row = result.rows[0];
        if (!row) return null;
        const { hidden, dismissed, ...facts } = row;
        return Object.freeze({ ...facts, viewer: Object.freeze({ hidden, dismissed }) });
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
