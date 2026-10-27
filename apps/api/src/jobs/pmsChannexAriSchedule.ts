import pg from "pg";

// These are canonical source tables, not provider progress/status. Including
// last_ari_sync_at here would cause a successful sync to schedule itself forever.
const sourceTables = [
  "pms.property_pricing_settings",
  "pms.rate_plans",
  "pms.recurring_pricing_sources",
  "pms.recurring_pricing_source_room_values",
  "pms.channel_date_prices",
  "pms.pricing_v2_heads",
  "pms.room_types",
  // VAY-2108 D6: a closed room leaves the delivery scope, so its rate plans close on the next run.
  "pms.room_type_closures",
  // VAY-2108 D6: opening or closing sales, or a new active version, is a change to deliver.
  "pms.channex_offer_targets",
  "pms.channel_room_type_mappings",
  "pms.channel_rate_plan_mappings",
  "pms.inventory_days",
  "pms.inventory_materialization_coverage",
  "booking.same_day_booking_policies",
];

export function createPgChannexAriSchedule(
  connectionString: string,
  scope?: string | Readonly<{ propertyIds: readonly string[] }>,
) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  // One staging property, or (VAY-2108 D7) the claimed scope's owned hotels: those are scheduled
  // only while the target owns them (an active claim on the connected binding).
  const propertyId = typeof scope === "string" ? scope : null;
  const propertyIds = typeof scope === "object" ? [...scope.propertyIds] : null;
  return {
    async enqueue(now = new Date()) {
      // ponytail: one source scan per minute; replace with source-owned outbox
      // fan-out if the connected-property inventory volume makes scans costly.
      const result = await pool.query(
        `WITH fingerprints AS (
        SELECT connection.property_id, encode(sha256(convert_to(jsonb_build_array(
          connection.id, connection.connection_status, connection.binding_generation,
          connection.external_property_id, location.timezone,
          CASE WHEN location.timezone IN (SELECT name FROM pg_timezone_names)
            THEN ($1::timestamptz AT TIME ZONE location.timezone)::date::text
            ELSE 'invalid-property-timezone' END,
          ${sourceTables
            .map(
              (table) => `(SELECT jsonb_agg(to_jsonb(source) ORDER BY to_jsonb(source)::text)
            FROM ${table} source WHERE source.property_id=connection.property_id)`,
            )
            .join(",\n")}
        )::text,'UTF8')),'hex') AS fingerprint
        FROM pms.channel_connections connection
        LEFT JOIN hotel_catalog.property_locations location ON location.property_id=connection.property_id
        WHERE connection.provider='channex'
          AND ($2::uuid IS NULL OR connection.property_id=$2::uuid)
          AND ($3::uuid[] IS NULL OR (connection.property_id=ANY($3::uuid[])
            AND EXISTS (SELECT 1 FROM pms.channel_binding_claims claim
              WHERE claim.property_id=connection.property_id AND claim.provider='channex'
                AND claim.claim_state='active'
                AND claim.external_property_id=connection.external_property_id)))
      ), changed AS (
        INSERT INTO pms.channex_ari_schedule_sources(property_id,fingerprint)
        SELECT property_id,fingerprint FROM fingerprints
        WHERE NOT EXISTS (SELECT 1 FROM pms.channex_ari_schedule_sources previous
          WHERE previous.property_id=fingerprints.property_id AND previous.fingerprint=fingerprints.fingerprint)
        ORDER BY property_id LIMIT 100
        ON CONFLICT (property_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,
          revision=pms.channex_ari_schedule_sources.revision+1
        WHERE pms.channex_ari_schedule_sources.fingerprint<>EXCLUDED.fingerprint
        RETURNING property_id,revision
      ) INSERT INTO platform.jobs(job_key,queue_name,job_type,max_attempts,tenant_scope,
          property_id,resource_product,resource_type,resource_id,payload,job_metadata)
        SELECT 'channex.scheduled:'||changed.property_id||':'||changed.revision,'pms.channex.management','channex.sync_ari',5,'property',
          changed.property_id,'pms','channex_connection',changed.property_id::text,
          jsonb_build_object('commandId',gen_random_uuid(),'idempotencyKey','scheduled:'||changed.property_id||':'||changed.revision,'operationType','sync_ari'),
          jsonb_build_object('source','channex-ari-schedule','sourceRevision',changed.revision)
        FROM changed JOIN pms.channel_connections connection
          ON connection.property_id=changed.property_id AND connection.provider='channex'
        WHERE connection.connection_status IN ('connected','degraded')
          AND connection.external_property_id IS NOT NULL
        RETURNING id`,
        [now.toISOString(), propertyId, propertyIds],
      );
      return result.rows.length;
    },
    async close() {
      await pool.end();
    },
  };
}
