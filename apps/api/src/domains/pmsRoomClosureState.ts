import type { DistributionBookingPublicationTransaction } from "./distributionBookingPublicationProjection.js";

export type PmsRoomClosureScope = {
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  actorUserId: string;
};
export type PmsRoomClosureState = {
  propertyId: string;
  roomTypeId: string;
  roomFactsRevision: number;
  roomUnitsRevision: number;
  calendarRevision: number | null;
  cutoffDate: string | null;
  coverageFrom: string | null;
  coverageThrough: string | null;
  operatingRoomTypeIds: string[];
  physicalUnitIds: string[];
  activePublicationRevisionId: string | null;
  activeRoomMappings: number;
  activeRateMappings: number;
  futureInventoryDays: number;
  blockers: string[];
};

type Row = Omit<PmsRoomClosureState, "blockers"> & {
  operating: boolean;
  linked: boolean;
  calendarCurrent: boolean;
  bindingsCurrent: boolean;
  coverageComplete: boolean;
  inventoryProtected: boolean;
  reservationsProtected: boolean;
  unitsProtected: boolean;
  blocksProtected: boolean;
  unknownOwner: boolean;
};

/** Read under the closure command's inventory/facts/unit/publication locks. */
export async function readPmsRoomClosureState(
  client: DistributionBookingPublicationTransaction,
  scope: Pick<PmsRoomClosureScope, "propertyId" | "roomTypeId">,
  acceptedAt: Date,
): Promise<PmsRoomClosureState | null> {
  const row = (
    await client.query<Row>(
      `WITH eligible AS (
      SELECT room.* FROM pms.room_types room
      WHERE room.property_id=$1::uuid AND room.active
        AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closure
          WHERE closure.property_id=room.property_id AND closure.room_type_id=room.id)
    ), latest AS (
      SELECT * FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid
      ORDER BY calendar_revision DESC LIMIT 1
    ), calendar AS (
      SELECT latest.*,($3::timestamptz AT TIME ZONE property_time_zone)::date AS cutoff
      FROM latest
    )
    SELECT room.property_id::text AS "propertyId",room.id::text AS "roomTypeId",
      room.room_facts_revision::int AS "roomFactsRevision",
      room.room_units_revision::int AS "roomUnitsRevision",
      calendar.calendar_revision::int AS "calendarRevision",calendar.cutoff::text AS "cutoffDate",
      coverage.coverage_from::text AS "coverageFrom",coverage.coverage_through::text AS "coverageThrough",
      ARRAY(SELECT id::text FROM eligible ORDER BY id) AS "operatingRoomTypeIds",
      ARRAY(SELECT id::text FROM pms.rooms unit WHERE unit.property_id=room.property_id
        AND unit.room_type_id=room.id AND unit.status<>'retired' ORDER BY id) AS "physicalUnitIds",
      (SELECT content_revision_id::text FROM distribution.active_public_booking_revision
        WHERE property_id=room.property_id) AS "activePublicationRevisionId",
      (SELECT count(*)::int FROM pms.channel_room_type_mappings mapping
        WHERE mapping.property_id=room.property_id AND mapping.room_type_id=room.id AND mapping.status='active') AS "activeRoomMappings",
      (SELECT count(*)::int FROM pms.channel_rate_plan_mappings mapping
        WHERE mapping.property_id=room.property_id AND mapping.room_type_id=room.id AND mapping.status='active') AS "activeRateMappings",
      (SELECT count(*)::int FROM pms.inventory_days day WHERE day.property_id=room.property_id
        AND day.room_type_id=room.id AND day.stay_date>=calendar.cutoff) AS "futureInventoryDays",
      EXISTS(SELECT 1 FROM eligible WHERE id=room.id) AS operating,
      room.linked_inventory_group_id IS NOT NULL AS linked,
      COALESCE(calendar.property_profile_revision=property.profile_revision
        AND calendar.property_time_zone=location.timezone, false) AS "calendarCurrent",
      COALESCE(calendar.room_binding_count=(SELECT count(*) FROM eligible)
        AND NOT EXISTS (
          SELECT 1 FROM eligible candidate LEFT JOIN pms.operating_calendar_room_bindings binding
            ON binding.property_id=candidate.property_id AND binding.room_type_id=candidate.id
              AND binding.calendar_revision=calendar.calendar_revision
          WHERE binding.room_type_id IS NULL
            OR binding.source_room_facts_revision<>candidate.room_facts_revision
            OR binding.source_room_units_revision<>candidate.room_units_revision
            OR binding.physical_capacity_count<>(SELECT count(*) FROM pms.rooms unit
              WHERE unit.property_id=candidate.property_id AND unit.room_type_id=candidate.id AND unit.status<>'retired')
        ),false) AS "bindingsCurrent",
      COALESCE(coverage.calendar_revision=calendar.calendar_revision
        AND coverage.materialized_revision=calendar.calendar_revision
        AND coverage.room_type_count=(SELECT count(*) FROM eligible)
        AND coverage.coverage_through>=calendar.cutoff
        AND NOT EXISTS (
          SELECT 1 FROM eligible candidate WHERE (SELECT count(*) FROM pms.inventory_days day
            WHERE day.property_id=candidate.property_id AND day.room_type_id=candidate.id
              AND day.stay_date BETWEEN coverage.coverage_from AND coverage.coverage_through
              AND day.calendar_revision=calendar.calendar_revision
              AND day.generated_source_revision=calendar.calendar_revision
              AND day.inventory_revision<2147483647
          )<>coverage.coverage_through-coverage.coverage_from+1
        ),false) AS "coverageComplete",
      EXISTS(SELECT 1 FROM pms.inventory_days day WHERE day.property_id=room.property_id
        AND day.room_type_id=room.id AND day.stay_date>=calendar.cutoff
        AND (day.assigned_count<>0 OR day.blocked_count<>0
          OR day.stay_date>coverage.coverage_through
          OR day.manual_sellable_limit_count IS NOT NULL OR day.channel_sellable_limit_count IS NOT NULL
          OR day.calendar_revision IS DISTINCT FROM calendar.calendar_revision
          OR day.generated_source_revision IS DISTINCT FROM calendar.calendar_revision
          OR day.linked_stop_sell OR day.closure_source_revision<>0 OR day.inventory_revision>=2147483647)) AS "inventoryProtected",
      EXISTS(SELECT 1 FROM pms.operational_booking_assignments assignment
        WHERE assignment.property_id=room.property_id AND assignment.room_type_id=room.id
          AND assignment.assignment_status IN ('pending','assigned','checked_in','in_house'))
      OR EXISTS(SELECT 1 FROM pms.active_inventory_reservation_receipts receipt
        JOIN pms.inventory_reservation_statuses status ON status.receipt_id=receipt.receipt_id
        WHERE receipt.property_id=room.property_id AND receipt.room_type_id=room.id
          AND receipt.check_out>calendar.cutoff AND status.lifecycle_state IN ('reserved','handed_off')) AS "reservationsProtected",
      EXISTS(SELECT 1 FROM pms.rooms unit WHERE unit.property_id=room.property_id
        AND unit.room_type_id=room.id AND unit.status NOT IN ('available','retired')) AS "unitsProtected",
      EXISTS(SELECT 1 FROM pms.room_blocks block WHERE block.property_id=room.property_id
        AND (block.room_type_id=room.id OR block.source_room_type_id=room.id)
        AND block.status='active' AND block.ends_on>=calendar.cutoff) AS "blocksProtected"
      ,EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='pms.inventory_days'::regclass
        AND attnum>0 AND NOT attisdropped AND attname ~ '_source_revision$'
        AND attname NOT IN ('generated_source_revision','channel_source_revision','manual_source_revision',
          'block_source_revision','booking_source_revision','linked_source_revision','closure_source_revision')) AS "unknownOwner"
    FROM pms.room_types room JOIN hotel_catalog.properties property ON property.id=room.property_id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id=room.property_id
    LEFT JOIN calendar ON true
    LEFT JOIN pms.inventory_materialization_coverage coverage ON coverage.property_id=room.property_id
    WHERE room.property_id=$1::uuid AND room.id=$2::uuid AND room.active`,
      [scope.propertyId, scope.roomTypeId, acceptedAt.toISOString()],
    )
  ).rows[0];
  if (!row) return null;
  const {
    operating,
    linked,
    calendarCurrent,
    bindingsCurrent,
    coverageComplete,
    inventoryProtected,
    reservationsProtected,
    unitsProtected,
    blocksProtected,
    unknownOwner,
    ...state
  } = row;
  const blockers: string[] = [];
  if (!operating) blockers.push("room_not_operating");
  if (state.operatingRoomTypeIds.length < 2) blockers.push("last_operating_room");
  if (
    !calendarCurrent ||
    !bindingsCurrent ||
    !state.calendarRevision ||
    state.calendarRevision >= 2147483647
  )
    blockers.push("calendar_not_current");
  if (!coverageComplete) blockers.push("coverage_incomplete");
  if (inventoryProtected) blockers.push("protected_inventory");
  if (reservationsProtected) blockers.push("active_reservations");
  if (unitsProtected || state.roomUnitsRevision >= 2147483647) blockers.push("protected_units");
  if (blocksProtected) blockers.push("active_blocks");
  if (linked) blockers.push("linked_inventory");
  if (unknownOwner) blockers.push("unknown_inventory_owner");
  return { ...state, blockers };
}
