import { createHash } from "node:crypto";
import type pg from "pg";

// VAY-2108: the audited per-hotel Channex handover (engineering/channex-per-hotel-ownership.md).
// It promotes one VAY-1362 handover-pending cohort connection to the target, attaches a fresh
// target property to an existing Channex property, or reverts either. It never calls Channex and
// never enables or disables a Channex property.

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
const SELL_MODES = new Set(["per_room", "per_person"]);
const RATE_TYPES = new Set(["flexible", "non_refundable", "package", "manual"]);
const CURRENCY = /^[A-Z]{3}$/;
const MANIFEST_TEXT = /^[^\p{Cc}]{1,200}$/u;
/** The legacy booking pull keyed its own rows this way; the resync job reuses the queue. */
const RESYNC_QUEUE = "pms.channex.webhooks";
const RESYNC_TYPE = "channex.resync-bookings";
const UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export type ChannexHandoverInput =
  | {
      command: "activate";
      propertyId: string;
      approvalRef: string;
      legacyDisabledAt: string;
      legacyReadbackSha256: string;
    }
  | { command: "revoke"; propertyId: string; approvalRef: string; reason: string }
  | {
      command: "attach";
      propertyId: string;
      /** The existing Channex property the fresh target property takes over. */
      externalPropertyId: string;
      approvalRef: string;
      legacyDisabledAt: string;
      legacyReadbackSha256: string;
      /** The reviewed room and rate mapping (a file for the CLI); its sha binds the plan. */
      manifest: unknown;
      manifestSha256: string;
    }
  | { command: "open-sales"; propertyId: string; approvalRef: string }
  | { command: "close-sales"; propertyId: string; approvalRef: string };
type SalesInput = Extract<
  ChannexHandoverInput,
  { command: "open-sales" } | { command: "close-sales" }
>;
type AttachInput = Extract<ChannexHandoverInput, { command: "attach" }>;

/** One adopted Channex rate plan: booking intake maps OTA stays through it (0006 mappings). */
export type ChannexAttachRatePlan = {
  externalRatePlanId: string;
  name: string;
  sellMode: "per_room" | "per_person";
  currency: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
};
export type ChannexAttachManifest = {
  capabilities: string[];
  roomTypes: Array<{
    roomTypeId: string;
    externalRoomTypeId: string;
    ratePlans: ChannexAttachRatePlan[];
  }>;
  /** Active room types deliberately kept off the OTAs; every other active one must be mapped. */
  unmappedRoomTypeIds: string[];
};

/** The attach plan: the manifest resolved against the property's rows, bound to their versions. */
export type ChannexAttachPlan = {
  command: "attach";
  propertyId: string;
  /** NULL when the property never had a Channex connection row; apply inserts one. */
  connectionId: string | null;
  externalPropertyId: string;
  claimId: string | null;
  state: Record<string, string | null>;
  capabilities: string[];
  roomTypes: Array<{
    roomTypeId: string;
    externalRoomTypeId: string;
    /** An existing mapping row to re-activate (after a revoke), else NULL to insert. */
    mappingId: string | null;
    ratePlans: Array<
      ChannexAttachRatePlan & {
        code: string;
        /** An existing pms.rate_plans row to reuse, else NULL to insert. */
        ratePlanId: string | null;
        mappingId: string | null;
      }
    >;
  }>;
  unmappedRoomTypeIds: string[];
  evidence: Record<string, string>;
};

/**
 * Offer targets whose sales state the command changes, bound to their active version, its binding
 * and their last change; opening also binds the owning claim.
 */
export type ChannexSalesPlan = {
  command: "open-sales" | "close-sales";
  propertyId: string;
  claimId: string | null;
  targets: Array<{
    id: string;
    offerId: string;
    activeVersion: string | null;
    bindingGeneration: string | null;
    externalRatePlanId: string | null;
    changedAt: string | null;
  }>;
  evidence: Record<string, string>;
};

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
  /** Revoke closes every open offer target of the property in the same transaction. */
  salesOpenTargetIds?: string[];
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
  input: Exclude<ChannexHandoverInput, SalesInput | AttachInput>,
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
    // After a revoke the worker no longer serves the hotel, so nothing could close them later.
    salesOpenTargetIds: (
      await client.query<{ id: string }>(
        `SELECT target.id::text FROM pms.channex_offer_targets target
         WHERE target.property_id = $1::uuid AND target.sales_state = 'open'
         ORDER BY target.id ${lock ? "FOR UPDATE OF target" : ""}`,
        [input.propertyId],
      )
    ).rows.map((row) => row.id),
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
    validateInput(input);
    // A reviewed plan applies once; re-running it reports the recorded result, unless a later
    // handover command has run since (an old revoke must not report a live hotel as revoked).
    const replayed = (
      await client.query<{
        id: string;
        evidence: Record<string, unknown> | null;
        occurredAt: string;
        superseded: boolean;
      }>(
        `SELECT event.id::text, event.redacted_payload->'evidence' AS evidence,
           to_char(event.occurred_at AT TIME ZONE 'UTC', ${UTC}) AS "occurredAt",
           EXISTS (SELECT 1 FROM platform.product_audit_events later
             WHERE later.product = 'pms' AND later.property_id = event.property_id
               AND later.audit_key LIKE 'channex.handover:%'
               AND later.occurred_at > event.occurred_at) AS superseded
         FROM platform.product_audit_events event
         WHERE event.product = 'pms' AND event.audit_key = $1`,
        [auditKey(input, planSha256)],
      )
    ).rows[0];
    if (replayed) {
      if (
        Object.entries(inputEvidence(input)).some(
          ([key, value]) => replayed.evidence?.[key] !== value,
        )
      )
        refuse("replay_mismatch");
      if (replayed.superseded) refuse("plan_superseded");
      await client.query("COMMIT");
      return {
        replayed: true as const,
        planSha256,
        auditId: replayed.id,
        occurredAt: replayed.occurredAt,
      };
    }
    if (input.command === "attach") {
      const attach = await planChannexAttach(client, input, true);
      if (attach.planSha256 !== planSha256) refuse("plan_changed");
      const { claimId, connectionId } = await applyAttach(client, attach.plan);
      const auditId = await audit(client, input, planSha256, "pms.channex.handover.attached", {
        ...attach.plan,
        claimId,
        connectionId,
      });
      await client.query("COMMIT");
      return { replayed: false as const, ...attach, auditId };
    }
    if (input.command === "open-sales" || input.command === "close-sales") {
      const sales = await planChannexSales(client, input, true);
      if (sales.planSha256 !== planSha256) refuse("plan_changed");
      const state = input.command === "open-sales" ? "open" : "closed";
      const updated = await client.query(
        `UPDATE pms.channex_offer_targets SET sales_state = $2, sales_state_changed_at = now()
         WHERE id = ANY($1::uuid[]) AND sales_state <> $2`,
        [sales.plan.targets.map((target) => target.id), state],
      );
      if (updated.rowCount !== sales.plan.targets.length) refuse("state_changed");
      const auditId = await audit(
        client,
        input,
        planSha256,
        `pms.channex.sales.${state}`,
        sales.plan,
      );
      await client.query("COMMIT");
      return { replayed: false as const, ...sales, auditId };
    }
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
      const closing = plan.salesOpenTargetIds ?? [];
      if (closing.length)
        changed(
          await client.query(
            `UPDATE pms.channex_offer_targets SET sales_state = 'closed', sales_state_changed_at = now()
             WHERE id = ANY($1::uuid[]) AND sales_state = 'open'`,
            [closing],
          ),
          closing.length,
        );
    }
    const auditId = await audit(
      client,
      input,
      planSha256,
      `pms.channex.handover.${plan.command === "activate" ? "activated" : "revoked"}`,
      { ...plan, claimId },
    );
    await client.query("COMMIT");
    return { replayed: false as const, ...sealed, auditId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

function auditKey(input: ChannexHandoverInput, planSha256: string) {
  return `channex.handover:${input.command}:${input.propertyId}:${planSha256}`;
}

/** The evidence a plan takes from its input; a replay must repeat it exactly. */
function inputEvidence(input: ChannexHandoverInput): Record<string, string> {
  if (input.command === "activate")
    return {
      approvalRef: input.approvalRef,
      legacyDisabledAt: new Date(input.legacyDisabledAt).toISOString(),
      legacyReadbackSha256: input.legacyReadbackSha256,
    };
  if (input.command === "revoke") return { approvalRef: input.approvalRef, reason: input.reason };
  if (input.command === "attach")
    return {
      approvalRef: input.approvalRef,
      externalPropertyId: input.externalPropertyId.toLowerCase(),
      legacyDisabledAt: new Date(input.legacyDisabledAt).toISOString(),
      legacyReadbackSha256: input.legacyReadbackSha256,
      manifestSha256: input.manifestSha256,
    };
  return { approvalRef: input.approvalRef };
}

/**
 * Attach: a fresh target property (normal onboarding, never imported) takes over the Channex
 * property the old system ran. The claim, the connected connection, the room-type mappings and
 * the adopted rate plans are written together; a booking resync job follows in the same commit.
 * It refuses whenever another target property holds the Channex id, in any claim state.
 */
export async function planChannexAttach(client: Client, input: AttachInput, lock = false) {
  validateInput(input);
  const manifest = parseAttachManifest(input.manifest);
  const external = input.externalPropertyId.toLowerCase();
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
    ).rows[0] ?? null;
  if (connection && (connection.status === "connected" || connection.external !== null))
    refuse("connection_already_bound");
  // An imported cohort row carries its own legacy id and gates (cohort, capabilities): activate.
  if (
    connection &&
    ("migrationCohortRunId" in connection.metadata ||
      "legacyExternalPropertyId" in connection.metadata)
  )
    refuse("use_activate");
  const claims = (
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
  const own = claims.find((claim) => claim.propertyId === input.propertyId) ?? null;
  if (claims.some((claim) => claim !== own)) refuse("claim_conflict");
  if (
    own &&
    !(
      own.state === "released" &&
      own.source === "handover" &&
      own.external.toLowerCase() === external
    )
  )
    refuse("claim_exists");
  const otherConnection = await client.query(
    `SELECT 1 FROM pms.channel_connections WHERE provider = 'channex'
       AND lower(external_property_id) = $2 AND property_id <> $1::uuid`,
    [input.propertyId, external],
  );
  if (otherConnection.rowCount) refuse("claim_conflict");
  const running = await client.query(
    `SELECT 1 FROM platform.jobs WHERE queue_name = 'pms.channex.management'
       AND property_id = $1::uuid AND status = 'running'`,
    [input.propertyId],
  );
  if (running.rowCount) refuse("management_job_running");
  const property = await client.query(
    `SELECT 1 FROM hotel_catalog.properties WHERE id = $1::uuid ${lock ? "FOR SHARE" : ""}`,
    [input.propertyId],
  );
  if (!property.rowCount) refuse("property_missing");
  const rooms = (
    await client.query<{ id: string; updatedAt: string }>(
      `SELECT id::text, to_char(updated_at AT TIME ZONE 'UTC', ${UTC}) AS "updatedAt"
       FROM pms.room_types WHERE property_id = $1::uuid AND active ORDER BY id ${lock ? "FOR SHARE" : ""}`,
      [input.propertyId],
    )
  ).rows;
  const active = new Set(rooms.map((room) => room.id));
  // Trigger 0137 refuses a rate plan in another currency at apply; refuse it when planning.
  const configuredCurrency =
    (
      await client.query<{ currency: string }>(
        `SELECT currency FROM pms.property_pricing_settings WHERE property_id = $1::uuid
         UNION ALL
         SELECT currency FROM (SELECT DISTINCT currency FROM pms.room_types
           WHERE property_id = $1::uuid AND active AND currency IS NOT NULL) room
         ORDER BY 1 LIMIT 1`,
        [input.propertyId],
      )
    ).rows[0]?.currency ?? null;
  if (
    configuredCurrency &&
    manifest.roomTypes.some((room) =>
      room.ratePlans.some((rate) => rate.currency !== configuredCurrency),
    )
  )
    refuse("currency_mismatch");
  const named = [
    ...manifest.roomTypes.map((room) => room.roomTypeId),
    ...manifest.unmappedRoomTypeIds,
  ];
  if (named.some((id) => !active.has(id))) refuse("room_type_unknown");
  if (active.size !== named.length) refuse("room_type_unmapped");
  // Rows an earlier attach left behind (revoke disables, never deletes) are reused when they say
  // the same thing; anything else on the connection is a conflict the manifest cannot resolve.
  const existingRooms = connection
    ? (
        await client.query<{ id: string; roomTypeId: string; external: string; status: string }>(
          `SELECT m.id::text, m.room_type_id::text AS "roomTypeId", m.external_room_type_id AS external, m.status
           FROM pms.channel_room_type_mappings m WHERE m.connection_id = $1::uuid ORDER BY m.id
           ${lock ? "FOR UPDATE OF m" : ""}`,
          [connection.id],
        )
      ).rows
    : [];
  const existingRates = connection
    ? (
        await client.query<{
          id: string;
          roomTypeId: string;
          ratePlanId: string;
          externalRoom: string;
          external: string;
          channel: string;
        }>(
          `SELECT m.id::text, m.room_type_id::text AS "roomTypeId", m.rate_plan_id::text AS "ratePlanId",
             m.external_room_type_id AS "externalRoom", m.external_rate_plan_id AS external, m.channel
           FROM pms.channel_rate_plan_mappings m WHERE m.connection_id = $1::uuid ORDER BY m.id
           ${lock ? "FOR UPDATE OF m" : ""}`,
          [connection.id],
        )
      ).rows
    : [];
  const ratePlanRows = (
    await client.query<{
      id: string;
      roomTypeId: string;
      code: string;
      rateType: string;
      currency: string;
    }>(
      `SELECT id::text, room_type_id::text AS "roomTypeId", code, rate_type AS "rateType", currency
       FROM pms.rate_plans WHERE property_id = $1::uuid AND code LIKE 'CH-%'
       ORDER BY id ${lock ? "FOR UPDATE" : ""}`,
      [input.propertyId],
    )
  ).rows;
  // The rate-owner registry (0314) is immutable: a Channex rate plan an offer target owns, or a
  // mapping row other than the one reused here, cannot be adopted.
  const owners = connection
    ? (
        await client.query<{ external: string; kind: string; ownerId: string }>(
          `SELECT external_rate_plan_id AS external, owner_kind AS kind, owner_id::text AS "ownerId"
           FROM pms.channex_external_rate_owners WHERE connection_id = $1::uuid`,
          [connection.id],
        )
      ).rows
    : [];
  const roomTypes = manifest.roomTypes.map((room) => {
    const mapping = existingRooms.find((row) => row.roomTypeId === room.roomTypeId) ?? null;
    if (mapping && mapping.external !== room.externalRoomTypeId) refuse("mapping_conflict");
    if (
      existingRooms.some(
        (row) => row.external === room.externalRoomTypeId && row.roomTypeId !== room.roomTypeId,
      )
    )
      refuse("mapping_conflict");
    return {
      roomTypeId: room.roomTypeId,
      externalRoomTypeId: room.externalRoomTypeId,
      mappingId: mapping?.id ?? null,
      ratePlans: room.ratePlans.map((rate) => {
        const code = `CH-${rate.externalRatePlanId.slice(0, 8)}`;
        const plan = ratePlanRows.find((row) => row.code === code) ?? null;
        if (
          plan &&
          (plan.roomTypeId !== room.roomTypeId ||
            plan.rateType !== rate.rateType ||
            plan.currency !== rate.currency)
        )
          refuse("mapping_conflict");
        const rateMapping =
          existingRates.find((row) => row.external === rate.externalRatePlanId) ?? null;
        const owner = owners.find((row) => row.external === rate.externalRatePlanId);
        if (owner && !(owner.kind === "legacy" && owner.ownerId === rateMapping?.id))
          refuse("rate_owned");
        if (
          rateMapping &&
          (rateMapping.roomTypeId !== room.roomTypeId ||
            rateMapping.externalRoom !== room.externalRoomTypeId ||
            rateMapping.channel !== "direct" ||
            rateMapping.ratePlanId !== plan?.id)
        )
          refuse("mapping_conflict");
        if (
          plan &&
          existingRates.some(
            (row) => row.ratePlanId === plan.id && row.external !== rate.externalRatePlanId,
          )
        )
          refuse("mapping_conflict");
        return { ...rate, code, ratePlanId: plan?.id ?? null, mappingId: rateMapping?.id ?? null };
      }),
    };
  });
  const keep = new Set([
    ...roomTypes.map((room) => room.mappingId),
    ...roomTypes.flatMap((room) => room.ratePlans.map((rate) => rate.mappingId)),
  ]);
  if (
    existingRooms.some((row) => row.status === "active" && !keep.has(row.id)) ||
    existingRates.some(
      (row) => !keep.has(row.id) && roomTypes.some((room) => room.roomTypeId === row.roomTypeId),
    )
  )
    refuse("mapping_conflict");
  const plan: ChannexAttachPlan = {
    command: "attach",
    propertyId: input.propertyId,
    connectionId: connection?.id ?? null,
    externalPropertyId: external,
    claimId: own?.id ?? null,
    state: {
      connectionUpdatedAt: connection?.updatedAt ?? null,
      claimUpdatedAt: own?.updatedAt ?? null,
      roomTypesSha256: createHash("sha256").update(JSON.stringify(rooms)).digest("hex"),
    },
    capabilities: manifest.capabilities,
    roomTypes,
    unmappedRoomTypeIds: [...manifest.unmappedRoomTypeIds].sort(),
    evidence: inputEvidence(input),
  };
  return { plan, planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

async function applyAttach(client: Client, plan: ChannexAttachPlan) {
  const changed = (result: { rowCount: number | null }, expected = 1) => {
    if (result.rowCount !== expected) refuse("state_changed");
  };
  // The claim must exist before the connection gets its id, or trigger 0128 refuses the write.
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
  const claimId = claim.rows[0]!.id;
  const attachEvidence = JSON.stringify({
    channexHandover: "completed",
    channexAttach: {
      approvalRef: plan.evidence["approvalRef"],
      legacyDisabledAt: plan.evidence["legacyDisabledAt"],
      legacyReadbackSha256: plan.evidence["legacyReadbackSha256"],
      manifestSha256: plan.evidence["manifestSha256"],
    },
  });
  const connection = plan.connectionId
    ? await client.query<{ id: string; generation: string }>(
        `UPDATE pms.channel_connections SET external_property_id = $2, connection_status = 'connected',
           capabilities = $3::text[], messaging_app_installed = 'message' = ANY($3::text[]),
           connection_metadata = (connection_metadata - 'connectedChannels' - 'inventoryRules'
             - 'airbnbCreationEvidence') || $4::jsonb,
           updated_at = now()
         WHERE id = $1::uuid RETURNING id::text, binding_generation::text AS generation`,
        [plan.connectionId, plan.externalPropertyId, plan.capabilities, attachEvidence],
      )
    : await client.query<{ id: string; generation: string }>(
        `INSERT INTO pms.channel_connections (property_id, provider, connection_status, external_property_id,
           capabilities, messaging_app_installed, connection_metadata)
         VALUES ($1::uuid, 'channex', 'connected', $2, $3::text[], 'message' = ANY($3::text[]), $4::jsonb)
         RETURNING id::text, binding_generation::text AS generation`,
        [plan.propertyId, plan.externalPropertyId, plan.capabilities, attachEvidence],
      );
  changed(connection);
  const { id: connectionId, generation } = connection.rows[0]!;
  for (const room of plan.roomTypes) {
    changed(
      room.mappingId
        ? await client.query(
            `UPDATE pms.channel_room_type_mappings SET status = 'active', updated_at = now()
             WHERE id = $1::uuid AND external_room_type_id = $2`,
            [room.mappingId, room.externalRoomTypeId],
          )
        : await client.query(
            `INSERT INTO pms.channel_room_type_mappings
               (property_id, connection_id, room_type_id, external_room_type_id, status, mapping_metadata)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', '{"source":"channex_attach"}'::jsonb)`,
            [plan.propertyId, connectionId, room.roomTypeId, room.externalRoomTypeId],
          ),
    );
    for (const rate of room.ratePlans) {
      const ratePlan = rate.ratePlanId
        ? await client.query<{ id: string }>(
            `UPDATE pms.rate_plans SET name = $2, active = TRUE, updated_at = now()
             WHERE id = $1::uuid RETURNING id::text`,
            [rate.ratePlanId, rate.name],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO pms.rate_plans (property_id, room_type_id, code, name, rate_type, currency)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6) RETURNING id::text`,
            [plan.propertyId, room.roomTypeId, rate.code, rate.name, rate.rateType, rate.currency],
          );
      changed(ratePlan);
      changed(
        rate.mappingId
          ? await client.query(
              `UPDATE pms.channel_rate_plan_mappings SET status = 'active', sell_mode = $2, updated_at = now()
               WHERE id = $1::uuid AND external_rate_plan_id = $3`,
              [rate.mappingId, rate.sellMode, rate.externalRatePlanId],
            )
          : await client.query(
              `INSERT INTO pms.channel_rate_plan_mappings (property_id, connection_id, room_type_id, rate_plan_id,
                 channel, external_room_type_id, external_rate_plan_id, sell_mode, status, mapping_metadata)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'direct', $5, $6, $7, 'active',
                 '{"source":"channex_attach"}'::jsonb)`,
              [
                plan.propertyId,
                connectionId,
                room.roomTypeId,
                ratePlan.rows[0]!.id,
                room.externalRoomTypeId,
                rate.externalRatePlanId,
                rate.sellMode,
              ],
            ),
      );
    }
  }
  // The copy of the hotel's upcoming OTA bookings; the claimed booking worker runs it.
  await client.query(
    `INSERT INTO platform.jobs (job_key, queue_name, job_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, max_attempts, payload)
     VALUES ($1::text || ':' || $4::text || ':' || $5::text, $2::text, $1::text, 'property', $3::uuid, 'pms',
       'channel_connection', $3::uuid::text, 3,
       jsonb_build_object('propertyId', $3::uuid::text, 'providerPropertyId', $6::text, 'bindingGeneration', $5::text))
     ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [
      RESYNC_TYPE,
      RESYNC_QUEUE,
      plan.propertyId,
      plan.propertyId,
      generation,
      plan.externalPropertyId,
    ],
  );
  return { claimId, connectionId };
}

function parseAttachManifest(value: unknown): ChannexAttachManifest {
  const record = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) refuse("manifest_invalid");
    return item as Record<string, unknown>;
  };
  const list = (item: unknown): unknown[] => {
    if (!Array.isArray(item)) refuse("manifest_invalid");
    return item;
  };
  const uuid = (item: unknown): string => {
    if (typeof item !== "string" || !UUID.test(item)) refuse("manifest_invalid");
    return item;
  };
  const text = (item: unknown): string => {
    if (typeof item !== "string" || !MANIFEST_TEXT.test(item)) refuse("manifest_invalid");
    return item;
  };
  const root = record(value);
  if (Object.keys(root).sort().join(",") !== "capabilities,roomTypes,unmappedRoomTypeIds")
    refuse("manifest_invalid");
  const capabilities = list(root["capabilities"]).map(text);
  if (
    !capabilities.includes("booking") ||
    !capabilities.includes("ari") ||
    capabilities.some((item) => !CAPABILITIES.has(item)) ||
    new Set(capabilities).size !== capabilities.length
  )
    refuse("capabilities_invalid");
  const roomTypes = list(root["roomTypes"]).map((item) => {
    const room = record(item);
    if (Object.keys(room).sort().join(",") !== "externalRoomTypeId,ratePlans,roomTypeId")
      refuse("manifest_invalid");
    const ratePlans = list(room["ratePlans"]).map((entry) => {
      const rate = record(entry);
      if (
        Object.keys(rate).sort().join(",") !== "currency,externalRatePlanId,name,rateType,sellMode"
      )
        refuse("manifest_invalid");
      const sellMode = text(rate["sellMode"]);
      const rateType = text(rate["rateType"]);
      const currency = text(rate["currency"]);
      if (!SELL_MODES.has(sellMode) || !RATE_TYPES.has(rateType) || !CURRENCY.test(currency))
        refuse("manifest_invalid");
      return {
        externalRatePlanId: uuid(rate["externalRatePlanId"]),
        name: text(rate["name"]),
        sellMode: sellMode as ChannexAttachRatePlan["sellMode"],
        currency,
        rateType: rateType as ChannexAttachRatePlan["rateType"],
      };
    });
    if (!ratePlans.length) refuse("manifest_invalid");
    return {
      roomTypeId: uuid(room["roomTypeId"]),
      externalRoomTypeId: uuid(room["externalRoomTypeId"]),
      ratePlans,
    };
  });
  const unmappedRoomTypeIds = list(root["unmappedRoomTypeIds"]).map(uuid);
  const roomIds = [...roomTypes.map((room) => room.roomTypeId), ...unmappedRoomTypeIds];
  const externalRooms = roomTypes.map((room) => room.externalRoomTypeId);
  const externalRates = roomTypes.flatMap((room) =>
    room.ratePlans.map((rate) => rate.externalRatePlanId),
  );
  if (
    !roomTypes.length ||
    new Set(roomIds).size !== roomIds.length ||
    new Set(externalRooms).size !== externalRooms.length ||
    new Set(externalRates).size !== externalRates.length ||
    new Set(externalRates.map((id) => id.slice(0, 8))).size !== externalRates.length
  )
    refuse("manifest_invalid");
  return { capabilities, roomTypes, unmappedRoomTypeIds };
}

async function audit(
  client: Client,
  input: ChannexHandoverInput,
  planSha256: string,
  action: string,
  payload: object,
) {
  // clock_timestamp(), taken after the advisory lock, so audit order is apply order (the
  // replay's superseded check compares it); now() is when the transaction began.
  const row = await client.query<{ id: string }>(
    `INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at, tenant_scope,
       property_id, actor_type, target_resource_product, target_resource_type, target_resource_id,
       redacted_payload, audit_metadata, retention_class, privacy_scope)
     VALUES ($1, 'pms', $2, clock_timestamp(), 'property', $3::uuid, 'migration', 'pms', 'channex_connection',
       $3::uuid::text, $4::jsonb, jsonb_build_object('sessionUser', session_user::text),
       'security', 'restricted')
     RETURNING id::text`,
    [
      auditKey(input, planSha256),
      action,
      input.propertyId,
      JSON.stringify({ ...payload, planSha256 }),
    ],
  );
  return row.rows[0]!.id;
}

/**
 * Opening needs a completed handover on the live binding and targets of that binding; closing
 * works for any open target of the property. The database change is all: the ongoing ARI
 * delivery turns sales_state into stop_sell (engineering/channex-ongoing-offer-ari.md).
 */
export async function planChannexSales(client: Client, input: SalesInput, lock = false) {
  validateInput(input);
  const open = input.command === "open-sales";
  let claimId: string | null = null;
  if (open) {
    const owned = await client.query<{ claimId: string }>(
      `SELECT claim.id::text AS "claimId" FROM pms.channel_connections connection
       JOIN pms.channel_binding_claims claim ON claim.property_id = connection.property_id
         AND claim.provider = connection.provider
         AND claim.external_property_id = connection.external_property_id
         AND claim.claim_state = 'active' AND claim.claim_source = 'handover'
       WHERE connection.property_id = $1::uuid AND connection.provider = 'channex'
         AND connection.connection_status = 'connected'
         AND connection.connection_metadata->>'channexHandover' = 'completed'
       ${lock ? "FOR SHARE OF connection, claim" : ""}`,
      [input.propertyId],
    );
    claimId = owned.rows[0]?.claimId ?? refuse("handover_not_completed");
  }
  const targets = (
    await client.query<ChannexSalesPlan["targets"][number]>(
      `SELECT target.id::text, target.offer_id AS "offerId",
         target.active_version::text AS "activeVersion",
         version.binding_generation::text AS "bindingGeneration",
         version.external_rate_plan_id AS "externalRatePlanId",
         to_char(target.sales_state_changed_at AT TIME ZONE 'UTC', ${UTC}) AS "changedAt"
       FROM pms.channex_offer_targets target
       LEFT JOIN pms.channex_offer_target_versions version
         ON version.target_id = target.id AND version.version = target.active_version
       JOIN pms.channel_connections connection ON connection.id = target.connection_id
       WHERE target.property_id = $1::uuid AND target.sales_state <> $2
         AND (NOT $3::boolean OR connection.binding_generation = version.binding_generation)
       ORDER BY target.id ${lock ? "FOR UPDATE OF target" : ""}`,
      [input.propertyId, open ? "open" : "closed", open],
    )
  ).rows;
  if (!targets.length) refuse("sales_state_unchanged");
  const plan: ChannexSalesPlan = {
    command: input.command,
    propertyId: input.propertyId,
    claimId,
    targets,
    evidence: { approvalRef: input.approvalRef },
  };
  return { plan, planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
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
  if (input.command === "activate" || input.command === "attach") {
    const at = Date.parse(input.legacyDisabledAt);
    if (!ISO_INSTANT.test(input.legacyDisabledAt) || !Number.isFinite(at) || at > Date.now())
      refuse("legacy_disabled_at_invalid");
    if (!SHA256.test(input.legacyReadbackSha256)) refuse("legacy_readback_invalid");
    if (input.command === "attach") {
      const external = input.externalPropertyId.toLowerCase();
      if (!UUID.test(external)) refuse("external_id_invalid");
      if (RESERVED_IDS.has(external) || RESERVED_IDS.has(input.propertyId))
        refuse("reserved_identity");
      if (!SHA256.test(input.manifestSha256)) refuse("manifest_invalid");
    }
  } else if (input.command === "revoke" && !/^[\x20-\x7e]{3,500}$/.test(input.reason))
    refuse("reason_invalid");
}

/** Revoke binds to its claim and binding, not to row ids a busy hotel keeps changing. */
function seal(plan: ChannexHandoverPlan) {
  const bound =
    plan.command === "revoke"
      ? {
          ...plan,
          roomTypeMappingIds: [],
          ratePlanMappingIds: [],
          bookingMappingIds: [],
          salesOpenTargetIds: [],
        }
      : plan;
  return { plan, planSha256: createHash("sha256").update(JSON.stringify(bound)).digest("hex") };
}
