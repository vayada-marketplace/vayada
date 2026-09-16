import pg from "pg";

// These are canonical source tables, not provider progress/status. Including
// last_ari_sync_at here would cause a successful sync to schedule itself forever.
const sourceTables = [
  "pms.property_pricing_settings",
  "pms.rate_plans",
  "pms.recurring_pricing_sources",
  "pms.recurring_pricing_source_room_values",
  "pms.channel_date_prices",
  "pms.room_types",
  "pms.channel_room_type_mappings",
  "pms.channel_rate_plan_mappings",
  "pms.inventory_days",
  "pms.inventory_materialization_coverage",
  "booking.same_day_booking_policies",
];

export function createPgChannexAriSchedule(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  return {
    async enqueue(now = new Date()) {
      // ponytail: one source scan per minute; replace with source-owned outbox
      // fan-out if the connected-property inventory volume makes scans costly.
      const result = await pool.query(
        `WITH fingerprints AS (
        SELECT connection.property_id, encode(sha256(convert_to(jsonb_build_array(
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
        WHERE connection.provider='channex' AND connection.external_property_id IS NOT NULL
          AND connection.connection_status IN ('connected','degraded')
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
        SELECT 'channex.scheduled:'||property_id||':'||revision,'pms.channex.management','channex.sync_ari',5,'property',
          property_id,'pms','channex_connection',property_id::text,
          jsonb_build_object('commandId',gen_random_uuid(),'idempotencyKey','scheduled:'||property_id||':'||revision,'operationType','sync_ari'),
          jsonb_build_object('source','channex-ari-schedule','sourceRevision',revision)
        FROM changed RETURNING id`,
        [now.toISOString()],
      );
      return result.rows.length;
    },
    async close() {
      await pool.end();
    },
  };
}
