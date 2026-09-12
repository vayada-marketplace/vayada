import { createHash } from "node:crypto";
import pg from "pg";
import type { ApiConfig } from "../config.js";
import { resolveStagingCatalogReference } from "./channexStagingCatalogReference.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  catalogUuid,
  readStagingCatalogEvidence,
  rejectCatalog,
  type StagingCatalogRequest,
} from "./channexStagingCatalogEvidence.js";

export async function adoptChannexStagingCatalog(
  config: ApiConfig,
  input: StagingCatalogRequest,
  request: typeof fetch = fetch,
) {
  const management = config.channexManagement,
    propertyId = management.stagingRestrictionsPropertyId;
  if (
    config.apiRuntime !== "next" ||
    config.backgroundWorkersEnabled ||
    management.apiBaseUrl !== "https://staging.channex.io" ||
    management.capabilityModes.bookingSync !== "observe_only" ||
    !management.apiKey ||
    !config.targetDatabaseUrl ||
    ![
      propertyId,
      input.providerPropertyId,
      input.bookingId,
      input.revisionId,
      input.channelId,
    ].every(catalogUuid) ||
    !/^VAY-\d+:[a-zA-Z0-9:_-]{1,120}$/.test(input.approvalRef) ||
    (input.applyHash !== undefined && !/^[a-f0-9]{64}$/.test(input.applyHash))
  )
    rejectCatalog("invalid_staging_catalog_scope");
  const pool = new pg.Pool({
    connectionString: config.targetDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const binding = async () => {
    const rows = (
      await client.query<{ id: string; generation: string }>(
        `SELECT c.id::text,c.binding_generation::text generation FROM pms.channel_connections c
       JOIN pms.channel_binding_claims claim ON claim.property_id=c.property_id AND claim.provider=c.provider
         AND claim.external_property_id=c.external_property_id
       WHERE c.property_id=$1::uuid AND c.provider='channex' AND c.external_property_id=$2
         AND c.connection_status='connected' AND claim.claim_state='active' FOR UPDATE OF c,claim`,
        [propertyId, input.providerPropertyId],
      )
    ).rows;
    if (rows.length !== 1) rejectCatalog("staging_catalog_binding_unavailable");
    return rows[0]!;
  };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    const before = await binding();
    await client.query("ROLLBACK");
    const facts = await readStagingCatalogEvidence(input, management.apiKey!, request);
    const evidence = {
      version: "channex-staging-catalog.v1",
      propertyId,
      connectionId: before.id,
      bindingGeneration: before.generation,
      providerPropertyId: input.providerPropertyId,
      bookingId: input.bookingId,
      revisionId: input.revisionId,
      channelId: input.channelId,
      facts,
    };
    const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    if (input.applyHash !== undefined && input.applyHash !== hash)
      rejectCatalog("staging_catalog_evidence_changed");
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    await lockPmsInventoryMutationScope(client, propertyId!);
    const current = await binding();
    if (current.id !== before.id || current.generation !== before.generation)
      rejectCatalog("staging_catalog_binding_changed");
    const jobKey = `channex.staging-import:${propertyId}:${input.bookingId}:${input.revisionId}:v1`;
    const imported = (
      await client.query<{ bookingId: string }>(
        `SELECT b.id::text AS "bookingId" FROM pms.channel_booking_mappings m
       JOIN booking.guest_bookings b ON b.id=m.guest_booking_id AND b.property_id=m.property_id
       WHERE m.property_id=$3::uuid AND m.connection_id=$4::uuid AND m.external_booking_id=$5
         AND m.external_revision_id=$6 AND m.sync_status='active' AND b.lifecycle_status='confirmed'
         AND b.booking_channel='booking_com' AND b.room_count=1 AND b.source_system='pms'
         AND b.source_booking_id=$7 AND m.channel_room_index=0
         AND EXISTS(SELECT 1 FROM platform.jobs j WHERE j.queue_name='pms.channex.webhooks'
           AND j.job_key=$1 AND j.status='succeeded' AND j.job_metadata#>>'{stagingImport,bindingGeneration}'=$2)
       FOR UPDATE OF m,b`,
        [
          jobKey,
          before.generation,
          propertyId,
          before.id,
          input.bookingId,
          input.revisionId,
          `channex:${propertyId}:${input.bookingId}`,
        ],
      )
    ).rows;
    if (imported.length !== 1) rejectCatalog("completed_staging_import_required");
    const bookingId = imported[0]!.bookingId;
    const auditKey = `channex.staging-catalog:${propertyId}:${facts.roomId}:${facts.rateId}:v1`;
    const receipt = (
      await client.query<{ hash: string; roomTypeId: string }>(
        `SELECT evidence_hash hash,room_type_id::text AS "roomTypeId" FROM pms.channex_staging_catalog_references
       WHERE property_id=$1::uuid AND provider_booking_id=$2::uuid AND provider_revision_id=$3::uuid`,
        [propertyId, input.bookingId, input.revisionId],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.hash !== hash) rejectCatalog("staging_catalog_receipt_conflict");
      const valid = await resolveStagingCatalogReference(client, {
        propertyId: propertyId!,
        connectionId: before.id,
        bindingGeneration: before.generation,
        bookingId,
        providerBookingId: input.bookingId,
        revisionId: input.revisionId,
        externalRoomTypeId: facts.roomId,
        externalRatePlanId: facts.rateId,
      });
      if (valid.length !== 1 || valid[0]!.roomTypeId !== receipt.roomTypeId)
        rejectCatalog("staging_catalog_replay_conflict");
      await client.query("ROLLBACK");
      return {
        outcome: "replayed",
        hash,
        roomTypeId: receipt.roomTypeId,
        providerRateId: facts.rateId,
      };
    }
    const sourceId = `channex-staging:${input.providerPropertyId}:${facts.roomId}`;
    const conflict = (
      await client.query(
        `SELECT 1 FROM pms.channel_room_type_mappings WHERE property_id=$1::uuid AND external_room_type_id=$2
       UNION ALL SELECT 1 FROM pms.channel_rate_plan_mappings WHERE property_id=$1::uuid AND (external_room_type_id=$2 OR external_rate_plan_id=$3)
       UNION ALL SELECT 1 FROM pms.room_types WHERE property_id=$1::uuid AND source_room_type_id=$4`,
        [propertyId, facts.roomId, facts.rateId, sourceId],
      )
    ).rowCount;
    if (conflict) rejectCatalog("staging_catalog_mapping_conflict");
    if (!input.applyHash) {
      await client.query("ROLLBACK");
      return {
        outcome: "preview",
        hash,
        evidence,
        operationalReadiness: "physical_units_and_calendar_required",
      };
    }
    const roomTypeId = (
      await client.query<{ id: string }>(
        `INSERT INTO pms.room_types(property_id,source_system,source_room_type_id,name,occupancy_limits,room_attributes)
       VALUES($1::uuid,'pms',$2,$3,$4::jsonb,$5::jsonb) RETURNING id::text`,
        [
          propertyId,
          sourceId,
          facts.roomName,
          JSON.stringify({
            total: facts.adults + facts.children,
            adults: facts.adults,
            children: facts.children,
          }),
          JSON.stringify({
            channexStagingAdoption: { hash, providerRoomCount: facts.providerRoomCount },
          }),
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO pms.channel_room_type_mappings(property_id,connection_id,room_type_id,external_room_type_id,status)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4,'active')`,
      [propertyId, before.id, roomTypeId, facts.roomId],
    );
    const audit = await client.query<{ id: string }>(
      `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
       target_resource_product,target_resource_type,target_resource_id,redacted_payload,retention_class,privacy_scope)
       VALUES($1,'pms','channex.staging_catalog.adopted',now(),'property',$2::uuid,'system','pms','room_type',$3,$4::jsonb,'provider_receipt','restricted') RETURNING id::text`,
      [
        auditKey,
        propertyId,
        roomTypeId,
        JSON.stringify({
          hash,
          roomTypeId,
          approvalRef: input.approvalRef,
          ...evidence,
        }),
      ],
    );
    await client.query(
      `INSERT INTO pms.channex_staging_catalog_references(property_id,connection_id,binding_generation,provider_property_id,
       guest_booking_id,provider_booking_id,provider_revision_id,room_type_id,external_room_type_id,external_rate_plan_id,evidence_hash,audit_event_id)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11,$12::uuid)`,
      [
        propertyId,
        before.id,
        before.generation,
        input.providerPropertyId,
        bookingId,
        input.bookingId,
        input.revisionId,
        roomTypeId,
        facts.roomId,
        facts.rateId,
        hash,
        audit.rows[0]!.id,
      ],
    );
    await client.query("COMMIT");
    return {
      outcome: "adopted",
      hash,
      roomTypeId,
      providerRateId: facts.rateId,
      operationalReadiness: "physical_units_and_calendar_required",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
