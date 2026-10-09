import type pg from "pg";

type QueryClient = Pick<pg.ClientBase, "query">;

/** The VAY-2066 setup-completeness criteria a-g, plus a complete profile, per property. */
export const COHORT_READINESS_CRITERIA = ["a", "b", "c", "d", "e", "f", "g", "complete"] as const;
export type CohortReadinessCriterion = (typeof COHORT_READINESS_CRITERIA)[number];
export type CohortReadiness = {
  propertyId: string;
  lifecycleStatus: string;
} & Record<CohortReadinessCriterion, boolean>;

/**
 * vay2066-readiness-criteria.md, a-g, evaluated on the target exactly as written there. $1: the
 * property IDs. SELECT-only, so the PMS import, its dry run and parity share it.
 */
export const COHORT_READINESS_SQL = `
  WITH candidate AS (SELECT DISTINCT unnest($1::uuid[]) AS property_id),
  latest AS (
    SELECT DISTINCT ON (calendar.property_id) calendar.*
      FROM pms.operating_calendar_revisions calendar
      JOIN candidate USING (property_id)
     ORDER BY calendar.property_id, calendar.calendar_revision DESC
  )
  SELECT property.id::text AS "propertyId", property.lifecycle_status AS "lifecycleStatus",
         property.lifecycle_status IN ('provisioning', 'active') AS a,
         NOT EXISTS (SELECT 1 FROM pms.calendar_auto_open_settings setting
                      WHERE setting.property_id = property.id AND NOT setting.enabled) AS b,
         NOT EXISTS (
           SELECT 1 FROM pms.rooms room
             JOIN pms.room_types room_type
               ON room_type.property_id = room.property_id AND room_type.id = room.room_type_id
              AND room_type.active
            WHERE room.property_id = property.id AND room.status <> 'retired'
              AND (room.operational_label_status <> 'verified' OR room.room_number IS NULL)
         ) AS c,
         coalesce(latest.organization_id IS NOT NULL
           AND latest.property_profile_revision = property.profile_revision
           AND location.timezone IS NOT NULL
           AND latest.property_time_zone = location.timezone, FALSE) AS d,
         latest.property_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM pms.room_types room_type
              WHERE room_type.property_id = property.id AND room_type.active
                AND (SELECT count(*) FROM pms.operating_calendar_room_bindings binding
                      WHERE binding.property_id = property.id
                        AND binding.calendar_revision = latest.calendar_revision
                        AND binding.room_type_id = room_type.id
                        AND binding.source_room_facts_revision = room_type.room_facts_revision
                        AND binding.source_room_units_revision = room_type.room_units_revision) <> 1)
           AND NOT EXISTS (
             SELECT 1 FROM pms.operating_calendar_room_bindings binding
               LEFT JOIN pms.room_types room_type
                 ON room_type.property_id = binding.property_id
                AND room_type.id = binding.room_type_id
              WHERE binding.property_id = property.id
                AND binding.calendar_revision = latest.calendar_revision
                AND room_type.active IS NOT TRUE)
           AND NOT EXISTS (
             SELECT 1 FROM pms.room_type_closures closure
               JOIN pms.room_types room_type
                 ON room_type.property_id = closure.property_id
                AND room_type.id = closure.room_type_id AND room_type.active
              WHERE closure.property_id = property.id) AS e,
         EXISTS (SELECT 1 FROM pms.property_pricing_settings pricing
                  WHERE pricing.property_id = property.id
                    AND pricing.pricing_currency_revision IS NOT NULL
                    AND pricing.optional_pricing_aggregate_revision IS NOT NULL) AS f,
         EXISTS (SELECT 1 FROM pms.room_types room_type
                  WHERE room_type.property_id = property.id AND room_type.active) AS g,
         property.profile_status = 'complete' AS complete
    FROM candidate
    JOIN hotel_catalog.properties property ON property.id = candidate.property_id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
    LEFT JOIN latest ON latest.property_id = property.id
   ORDER BY property.id`;

export async function readCohortReadiness(
  client: QueryClient,
  propertyIds: string[],
): Promise<CohortReadiness[]> {
  if (!propertyIds.length) return [];
  return (await client.query<CohortReadiness>(COHORT_READINESS_SQL, [propertyIds])).rows;
}

export function readyForActivation(readiness: CohortReadiness): boolean {
  return COHORT_READINESS_CRITERIA.every((criterion) => readiness[criterion]);
}
