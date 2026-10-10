import { createHash } from "node:crypto";
import type pg from "pg";

// VAY-2108: the audited per-hotel Channex handover (engineering/channex-per-hotel-ownership.md).
// It promotes one VAY-1362 handover-pending cohort connection to the target, or reverts that
// promotion. It never calls Channex and never enables or disables a Channex property.

/** Staging/test identities reserved by migration 0432; the executor is for cohort hotels only. */
const RESERVED_IDS = new Set([
  "17621565-40b5-4ebc-8727-3a301ac947a2",
  "46906724-72cb-4acf-a2eb-b740a3bdbcf7",
  "65f6b2fc-c783-4963-9d6b-a85f82319769",
  "8f4c1e47-3de1-4150-8bde-ad031a013842",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN = /^vay1351-[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CAPABILITIES = new Set(["booking", "ari", "message"]);
const UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export type ChannexHandoverInput =
  | {
      command: "activate";
      propertyId: string;
      approvalRef: string;
      legacyDisabledAt: string;
      legacyReadbackSha256: string;
    }
  | { command: "revoke"; propertyId: string; approvalRef: string; reason: string };

export type ChannexHandoverPlan = {
  command: "activate" | "revoke";
  propertyId: string;
  connectionId: string;
  externalPropertyId: string;
  claimId: string | null;
  /** The row versions the reviewed plan is bound to. */
  state: Record<string, string | null>;
  capabilities: string[];
  roomTypeMappingIds: string[];
  ratePlanMappingIds: string[];
  bookingMappingIds: string[];
  evidence: Record<string, string>;
};

export class ChannexHandoverRefused extends Error {}
function refuse(code: string): never {
  throw new ChannexHandoverRefused(code);
}

type Client = Pick<pg.PoolClient, "query">;
type Connection = {
  id: string;
  status: string;
  external: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
  generation: string;
};
type Claim = {
  id: string;
  propertyId: string;
  external: string;
  state: string;
  source: string;
  updatedAt: string;
};

/** Reads and validates the whole handover; with `lock` it also locks every row it reads. */
export async function planChannexHandover(
  client: Client,
  input: ChannexHandoverInput,
  lock = false,
) {
  validateInput(input);
  const forUpdate = lock ? "FOR UPDATE" : "";
  const connection =
    (
      await client.query<Connection>(
        `SELECT id::text, connection_status AS status, external_property_id AS external,
           connection_metadata AS metadata, binding_generation::text AS generation,
           to_char(updated_at AT TIME ZONE 'UTC', ${UTC}) AS "updatedAt"
         FROM pms.channel_connections WHERE property_id = $1::uuid AND provider = 'channex' ${forUpdate}`,
        [input.propertyId],
      )
    ).rows[0] ?? refuse("connection_missing");
  const metadata = connection.metadata;
  const claimsFor = async (external: string) =>
    (
      await client.query<Claim>(
        `SELECT id::text, property_id::text AS "propertyId", external_property_id AS external,
           claim_state AS state, claim_source AS source,
           to_char(updated_at AT TIME ZONE 'UTC', ${UTC}) AS "updatedAt"
         FROM pms.channel_binding_claims
         WHERE provider = 'channex' AND (property_id = $1::uuid OR lower(external_property_id) = $2)
         ORDER BY id ${forUpdate}`,
        [input.propertyId, external],
      )
    ).rows;
  // Revoke takes the id from its claim: after a disable the connection may have lost it.
  const external =
    input.command === "activate"
      ? String(metadata["legacyExternalPropertyId"] ?? "").toLowerCase()
      : (
          (await claimsFor("")).find((claim) => claim.propertyId === input.propertyId) ??
          refuse("handover_claim_missing")
        ).external.toLowerCase();
  if (!UUID.test(external)) refuse("external_id_invalid");
  if (RESERVED_IDS.has(external) || RESERVED_IDS.has(input.propertyId)) refuse("reserved_identity");
  const claims = await claimsFor(external);
  const own = claims.find((claim) => claim.propertyId === input.propertyId) ?? null;
  if (claims.some((claim) => claim !== own) || (own && own.external.toLowerCase() !== external))
    refuse("claim_conflict");
  // A running management job may persist after the handover; let it finish first.
  const running = await client.query(
    `SELECT 1 FROM platform.jobs WHERE queue_name = 'pms.channex.management'
       AND property_id = $1::uuid AND status = 'running'`,
    [input.propertyId],
  );
  if (running.rowCount) refuse("management_job_running");
  const mappings = (sql: string, extraLock = "") =>
    client
      .query<{ id: string }>(`${sql} ORDER BY m.id ${lock ? `FOR UPDATE OF m${extraLock}` : ""}`, [
        connection.id,
        input.propertyId,
      ])
      .then((result) => result.rows.map((row) => row.id));

  if (input.command === "activate") {
    if (metadata["channexHandover"] !== "pending") refuse("handover_not_pending");
    if (connection.status !== "disconnected" || connection.external !== null)
      refuse("connection_not_pending");
    // A released handover claim may be reactivated; any other claim blocks the handover.
    if (own && !(own.state === "released" && own.source === "handover")) refuse("claim_exists");
    const cohortRunId = String(metadata["migrationCohortRunId"] ?? "");
    if (!RUN.test(cohortRunId)) refuse("cohort_stamp_missing");
    const cohort = await client.query(
      `SELECT 1 FROM platform.production_migration_cohorts cohort
       WHERE cohort.source_run_id = $2 AND $1::uuid = ANY(cohort.booking_hotel_ids)
         AND EXISTS (SELECT 1 FROM hotel_catalog.property_source_links link
           WHERE link.property_id = $1::uuid AND link.source_system = 'pms'
             AND link.source_table = 'hotels' AND link.status = 'active'
             AND lower(link.source_id) = ANY(cohort.pms_hotel_ids::text[]))`,
      [input.propertyId, cohortRunId],
    );
    if (!cohort.rowCount) refuse("cohort_membership_missing");
    const capabilities = metadata["legacyCapabilities"];
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes("booking") ||
      !capabilities.includes("ari") ||
      capabilities.some((value) => !CAPABILITIES.has(String(value))) ||
      new Set(capabilities).size !== capabilities.length
    )
      refuse("capabilities_invalid");
    const eligible = `JOIN pms.room_types room ON room.id = m.room_type_id AND room.property_id = m.property_id
       WHERE m.connection_id = $1::uuid AND m.property_id = $2::uuid AND m.status = 'disabled' AND room.active
         AND m.mapping_metadata->'sourceActive' = 'true'::jsonb
         AND m.mapping_metadata->'roomTypeActive' = 'true'::jsonb`;
    return seal({
      command: "activate",
      propertyId: input.propertyId,
      connectionId: connection.id,
      externalPropertyId: external,
      claimId: own?.id ?? null,
      state: { connectionUpdatedAt: connection.updatedAt, claimUpdatedAt: own?.updatedAt ?? null },
      capabilities: capabilities as string[],
      roomTypeMappingIds: await mappings(
        `SELECT m.id::text FROM pms.channel_room_type_mappings m ${eligible}`,
        ", room",
      ),
      ratePlanMappingIds: await mappings(
        `SELECT m.id::text FROM pms.channel_rate_plan_mappings m ${eligible}`,
        ", room",
      ),
      bookingMappingIds: await mappings(
        `SELECT m.id::text FROM pms.channel_booking_mappings m
         WHERE m.connection_id = $1::uuid AND m.property_id = $2::uuid
           AND m.sync_status = 'ignored' AND m.assignment_id IS NOT NULL`,
      ),
      evidence: {
        approvalRef: input.approvalRef,
        cohortRunId,
        legacyDisabledAt: new Date(input.legacyDisabledAt).toISOString(),
        legacyReadbackSha256: input.legacyReadbackSha256,
      },
    });
  }

  if (metadata["channexHandover"] !== "completed") refuse("handover_not_completed");
  if (!own || own.state !== "active" || own.source !== "handover") refuse("handover_claim_missing");
  if (connection.external !== null && connection.external.toLowerCase() !== external)
    refuse("claim_conflict");
  // Revoke disables everything live on the binding, including rows written after activation.
  return seal({
    command: "revoke",
    propertyId: input.propertyId,
    connectionId: connection.id,
    externalPropertyId: external,
    claimId: own.id,
    state: { claimUpdatedAt: own.updatedAt, bindingGeneration: connection.generation },
    capabilities: [],
    roomTypeMappingIds: await mappings(
      `SELECT m.id::text FROM pms.channel_room_type_mappings m
       WHERE m.connection_id = $1::uuid AND m.property_id = $2::uuid AND m.status = 'active'`,
    ),
    ratePlanMappingIds: await mappings(
      `SELECT m.id::text FROM pms.channel_rate_plan_mappings m
       WHERE m.connection_id = $1::uuid AND m.property_id = $2::uuid AND m.status = 'active'`,
    ),
    bookingMappingIds: await mappings(
      `SELECT m.id::text FROM pms.channel_booking_mappings m
       WHERE m.connection_id = $1::uuid AND m.property_id = $2::uuid AND m.sync_status = 'active'`,
    ),
    evidence: { approvalRef: input.approvalRef, reason: input.reason },
  });
}

/** Applies a reviewed plan in one transaction; refuses unless the locked state still yields it. */
export async function applyChannexHandover(
  pool: Pick<pg.Pool, "connect">,
  input: ChannexHandoverInput,
  planSha256: string,
) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    // The same key the Channex management worker holds while it plans for this property.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `channex.management:${input.propertyId}`,
    ]);
    const sealed = await planChannexHandover(client, input, true);
    if (sealed.planSha256 !== planSha256) refuse("plan_changed");
    const { plan } = sealed;
    const changed = (result: { rowCount: number | null }, expected = 1) => {
      if (result.rowCount !== expected) refuse("state_changed");
    };
    let claimId = plan.claimId;
    if (plan.command === "activate") {
      // The claim must exist before the connection gets its id, or trigger 0128 inserts its own.
      const claim = plan.claimId
        ? await client.query<{ id: string }>(
            `UPDATE pms.channel_binding_claims SET claim_state = 'active', updated_at = now()
             WHERE id = $1::uuid AND claim_state = 'released' AND claim_source = 'handover'
             RETURNING id::text`,
            [plan.claimId],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO pms.channel_binding_claims
               (property_id, provider, external_property_id, claim_state, claim_source)
             VALUES ($1::uuid, 'channex', $2, 'active', 'handover') RETURNING id::text`,
            [plan.propertyId, plan.externalPropertyId],
          );
      changed(claim);
      claimId = claim.rows[0]!.id;
      changed(
        await client.query(
          `UPDATE pms.channel_connections SET external_property_id = $2, connection_status = 'connected',
             capabilities = $3::text[], messaging_app_installed = 'message' = ANY($3::text[]),
             connection_metadata = connection_metadata || '{"channexHandover":"completed"}'::jsonb,
             updated_at = now()
           WHERE id = $1::uuid`,
          [plan.connectionId, plan.externalPropertyId, plan.capabilities],
        ),
      );
      await setStatus(
        client,
        "channel_room_type_mappings",
        "status",
        "active",
        plan.roomTypeMappingIds,
      );
      await setStatus(
        client,
        "channel_rate_plan_mappings",
        "status",
        "active",
        plan.ratePlanMappingIds,
      );
      await setStatus(
        client,
        "channel_booking_mappings",
        "sync_status",
        "active",
        plan.bookingMappingIds,
      );
    } else {
      changed(
        await client.query(
          `UPDATE pms.channel_connections SET external_property_id = NULL,
             connection_status = 'disconnected', capabilities = '{}', messaging_app_installed = false,
             connection_metadata = (connection_metadata - 'connectedChannels' - 'inventoryRules'
               - 'airbnbCreationEvidence') || '{"channexHandover":"pending"}'::jsonb,
             updated_at = now()
           WHERE id = $1::uuid`,
          [plan.connectionId],
        ),
      );
      await setStatus(
        client,
        "channel_room_type_mappings",
        "status",
        "disabled",
        plan.roomTypeMappingIds,
      );
      await setStatus(
        client,
        "channel_rate_plan_mappings",
        "status",
        "disabled",
        plan.ratePlanMappingIds,
      );
      await setStatus(
        client,
        "channel_booking_mappings",
        "sync_status",
        "ignored",
        plan.bookingMappingIds,
      );
      changed(
        await client.query(
          `UPDATE pms.channel_binding_claims SET claim_state = 'released', updated_at = now()
           WHERE id = $1::uuid AND claim_state = 'active'`,
          [plan.claimId],
        ),
      );
    }
    const audit = await client.query<{ id: string }>(
      `INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at, tenant_scope,
         property_id, actor_type, target_resource_product, target_resource_type, target_resource_id,
         redacted_payload, audit_metadata, retention_class, privacy_scope)
       VALUES ($1, 'pms', $2, now(), 'property', $3::uuid, 'migration', 'pms', 'channex_connection',
         $3::uuid::text, $4::jsonb, jsonb_build_object('sessionUser', session_user::text),
         'security', 'restricted')
       RETURNING id::text`,
      [
        `channex.handover:${plan.command}:${plan.propertyId}:${planSha256}`,
        `pms.channex.handover.${plan.command === "activate" ? "activated" : "revoked"}`,
        plan.propertyId,
        JSON.stringify({ ...plan, claimId, planSha256 }),
      ],
    );
    await client.query("COMMIT");
    return { ...sealed, auditId: audit.rows[0]!.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

async function setStatus(
  client: Client,
  table: string,
  column: string,
  state: string,
  ids: string[],
) {
  if (!ids.length) return;
  const result = await client.query(
    `UPDATE pms.${table} SET ${column} = $2, updated_at = now() WHERE id = ANY($1::uuid[])`,
    [ids, state],
  );
  if (result.rowCount !== ids.length) refuse("state_changed");
}

function validateInput(input: ChannexHandoverInput) {
  if (!UUID.test(input.propertyId)) refuse("property_id_invalid");
  if (!/^[\x20-\x7e]{3,200}$/.test(input.approvalRef)) refuse("approval_ref_invalid");
  if (input.command === "activate") {
    const at = Date.parse(input.legacyDisabledAt);
    if (!ISO_INSTANT.test(input.legacyDisabledAt) || !Number.isFinite(at) || at > Date.now())
      refuse("legacy_disabled_at_invalid");
    if (!SHA256.test(input.legacyReadbackSha256)) refuse("legacy_readback_invalid");
  } else if (!/^[\x20-\x7e]{3,500}$/.test(input.reason)) refuse("reason_invalid");
}

/** Revoke binds to its claim and binding, not to mapping ids a busy hotel keeps changing. */
function seal(plan: ChannexHandoverPlan) {
  const bound =
    plan.command === "revoke"
      ? { ...plan, roomTypeMappingIds: [], ratePlanMappingIds: [], bookingMappingIds: [] }
      : plan;
  return { plan, planSha256: createHash("sha256").update(JSON.stringify(bound)).digest("hex") };
}
