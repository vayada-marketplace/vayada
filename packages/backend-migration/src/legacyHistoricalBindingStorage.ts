import { randomUUID } from "node:crypto";
import {
  readLegacyHistoricalBindingTargetRow,
  type AdoptionQueryClient,
} from "./channexAdoptionTargetRows.js";

export type HistoricalBindingEvent = {
  command_id: string;
  contract_version: string;
  environment: string;
  event_kind: string;
  compensates_command_id: string | null;
  claim_id: string;
  property_id: string;
  external_property_id: string;
  provider: string;
  claim_source: string;
  claim_created_at: string;
  source_run_id: string;
  source_active: boolean;
  source_evidence_sha256: string;
  payload_sha256: string;
  target_before_sha256: string;
  target_after_sha256: string;
  approval_envelope_sha256: string;
  executor_principal_sha256: string;
  before_state: string;
  after_state: string;
};

/** INTERNAL storage primitive, NOT an authenticated migration command. No runtime
 * route/CLI/export-index wiring. Caller must verify signatures, current authorities,
 * source, owner/disposition eligibility and full target evidence under retained locks
 * BEFORE calling, including before replay. Caller binds all arguments to approved
 * evidence, rechecks expiry, and owns commit/rollback and indeterminate-commit recovery.
 * A recorded receipt is history, not renewed eligibility. This layer never commits.
 */
export async function storeHistoricalBindingTransition(
  client: AdoptionQueryClient,
  input: {
    event: HistoricalBindingEvent;
    claimBeforeSha256: string;
    claimAfterSha256: string;
    updatedAt: string;
  },
) {
  const expected = structuredClone(input),
    event = expected.event;
  const table = "platform.legacy_historical_binding_transitions";
  const auditKey = `legacy-historical-binding:${event.command_id}`;
  const action = `legacy_historical_binding_${event.event_kind}`;
  const encoded = JSON.stringify(expected),
    encodedEvent = JSON.stringify(event);
  await client.query("SAVEPOINT vay2017_binding_storage");
  try {
    await client.query("SET LOCAL search_path=pg_catalog,pg_temp; SET LOCAL row_security=off");
    const settings = await client.query<{ valid: boolean }>(`SELECT
      current_setting('transaction_isolation')='read committed'
      AND current_setting('lock_timeout')<>'0' AND current_setting('statement_timeout')<>'0' AS valid`);
    if (settings.rows[0]?.valid !== true) throw new Error();
    // Same connection-before-pair ordering as the target guard; no waiting on writers.
    await client.query("LOCK TABLE pms.channel_connections IN SHARE MODE NOWAIT");
    for (const key of [
      ...[
        `channex.management:${event.property_id}`,
        `channex.external-property:${event.external_property_id}`,
      ].sort(),
      `legacy-historical-binding.command:${event.command_id}`,
    ]) {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
        [key],
      );
      if (lock.rows[0]?.acquired !== true) throw new Error();
    }
    await client.query(
      `LOCK TABLE pms.channel_binding_claims,${table},platform.product_audit_events IN ACCESS SHARE MODE NOWAIT`,
    );
    const visible = await client.query<{ valid: boolean }>(
      `SELECT count(*)=4 AND bool_and(
      relkind='r' AND NOT relrowsecurity AND NOT relforcerowsecurity AND has_table_privilege(c.oid,'SELECT')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) AS valid
      FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])`,
      [
        [
          "pms.channel_binding_claims",
          "pms.channel_connections",
          table,
          "platform.product_audit_events",
        ],
      ],
    );
    if (visible.rows[0]?.valid !== true) throw new Error();
    const receipt = await client.query<{ matches: boolean }>(
      `SELECT
      to_jsonb(t)-'recorded_at'=to_jsonb(x)-'recorded_at' AND EXISTS(
        SELECT 1 FROM platform.product_audit_events a WHERE a.audit_key=$2 AND a.product='pms'
        AND a.action=$3 AND a.target_resource_product='pms' AND a.target_resource_type='channel_binding_claim'
        AND a.target_resource_id=$4 AND a.private_payload=$5::jsonb AND a.retention_class='security'
        AND a.privacy_scope='restricted' AND NOT a.ai_visible) AS matches
      FROM ${table} t, jsonb_populate_record(NULL::${table},$1::jsonb) x
      WHERE t.command_id=x.command_id`,
      [encodedEvent, auditKey, action, event.claim_id, encoded],
    );
    if (receipt.rows.length) {
      if (receipt.rows.length !== 1 || receipt.rows[0]?.matches !== true) throw new Error();
      await client.query("RELEASE SAVEPOINT vay2017_binding_storage");
      return { outcome: "recorded_receipt" as const, commandId: event.command_id };
    }
    await client.query(
      "SELECT id FROM pms.channel_binding_claims WHERE id=$1::uuid FOR UPDATE NOWAIT",
      [event.claim_id],
    );
    if (
      (
        await readLegacyHistoricalBindingTargetRow(
          client,
          "pms.channel_binding_claims",
          event.claim_id,
        )
      ).rowStateSha256 !== expected.claimBeforeSha256
    )
      throw new Error();
    const connections = await client.query<{ valid: boolean }>(
      `SELECT count(*)>0 AND bool_and(coalesce(
      property_id=$1::uuid AND connection_status='disconnected' AND external_property_id IS NULL
      AND connection_metadata->>'legacyExternalPropertyId'=$2 AND connection_metadata->>'migrationRunId'=$3
    ,false)) AS valid FROM pms.channel_connections WHERE provider='channex'
      AND (property_id=$1::uuid OR external_property_id=$2 OR connection_metadata->>'legacyExternalPropertyId'=$2)`,
      [event.property_id, event.external_property_id, event.source_run_id],
    );
    if (connections.rows[0]?.valid !== true) throw new Error();
    const changed = await client.query(
      `UPDATE pms.channel_binding_claims SET claim_state=$2,updated_at=$3::timestamptz
      WHERE id=$1::uuid AND property_id=$4::uuid AND external_property_id=$5 AND provider=$6 AND claim_source=$7
      AND created_at=$8::timestamptz AND claim_state=$9 AND updated_at<=$3::timestamptz AND $3::timestamptz<=clock_timestamp()
      RETURNING id`,
      [
        event.claim_id,
        event.after_state,
        expected.updatedAt,
        event.property_id,
        event.external_property_id,
        event.provider,
        event.claim_source,
        event.claim_created_at,
        event.before_state,
      ],
    );
    if (
      changed.rows.length !== 1 ||
      (
        await readLegacyHistoricalBindingTargetRow(
          client,
          "pms.channel_binding_claims",
          event.claim_id,
        )
      ).rowStateSha256 !== expected.claimAfterSha256
    )
      throw new Error();
    // DB constraints validate the only two allowed state edges and compensation lineage.
    await client.query(
      `INSERT INTO ${table} SELECT x.* FROM jsonb_populate_record(NULL::${table},
      $1::jsonb || jsonb_build_object('recorded_at',clock_timestamp())) x`,
      [encodedEvent],
    );
    await client.query(
      `INSERT INTO platform.product_audit_events
      (id,audit_key,product,action,occurred_at,tenant_scope,actor_type,target_resource_product,target_resource_type,
       target_resource_id,redacted_payload,private_payload,audit_metadata,retention_class,privacy_scope,ai_visible)
      VALUES($1,$2,'pms',$3,clock_timestamp(),'migration','migration','pms','channel_binding_claim',$4,
       $5::jsonb,$6::jsonb,'{}'::jsonb,'security','restricted',FALSE)`,
      [
        randomUUID(),
        auditKey,
        action,
        event.claim_id,
        JSON.stringify({ commandId: event.command_id, payloadSha256: event.payload_sha256 }),
        encoded,
      ],
    );
    await client.query("RELEASE SAVEPOINT vay2017_binding_storage");
    return { outcome: "written_pending_commit" as const, commandId: event.command_id };
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT vay2017_binding_storage");
    await client.query("RELEASE SAVEPOINT vay2017_binding_storage");
    throw new Error("HISTORICAL_BINDING_STORAGE_FAILED");
  }
}
