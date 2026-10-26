import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { verifyChannexAriTaskFinish } from "../integrations/channexAriTaskReadback.js";
import { DEFAULT_FULL_ARI_DAYS_AHEAD } from "../jobs/pmsChannexAriHorizon.js";
import {
  lockChannexPricingJobLease,
  type ChannexPricingJobLeaseInput,
} from "../jobs/pmsChannexPricingJobLease.js";
import {
  prepareChannexOfferDeliveryReceiptPersistence,
  prepareChannexOfferDeliveryTransportFailurePersistence,
} from "./channexAriReceiptStore.js";
import { channexPropertyLocalDate } from "./channexInitialAriDate.js";
import {
  channexOfferAriValueSha256,
  channexOfferAriValueWithoutDate,
  type ChannexOfferAriValue,
} from "./channexOfferDesiredAri.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  readChannexOfferDesiredAri,
  readPublishedPricingForChannexJob,
} from "./replacementPricingOfferOwners.js";

/** Ongoing offer ARI delivery (VAY-2108 D3, engineering/channex-ongoing-offer-ari.md).
 *
 * Inside a full `channex.sync_ari` job, after activation: for every active target of the owned
 * hotel, compare the desired values (D2b) with what Channex last accepted, collapse the changed
 * dates into ranges, record one `pms.channex_offer_ari_deliveries` row (plus its per-date values)
 * and POST it. Reconciliation settles earlier deliveries from Channex task readback first. */

/** Channex accepts at most 100 `values[]` entries per restrictions POST. */
export const CHANNEX_OFFER_ARI_DELIVERY_ENTRY_LIMIT = 100;
/** Deliveries settled per run; more means the job comes back for the rest. */
const RECONCILIATION_BATCH = 10;

type DeliveryRequest = Readonly<{ method: "POST"; path: "/api/v1/restrictions"; body: unknown }>;
export type ChannexOfferDeliverySkip = Readonly<{ targetId: string; reason: string }>;

const unavailable = (reason: string) => ({ kind: "unavailable" as const, reason });
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
const sha256 = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const addDays = (date: string, days: number) => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

/** Collapses the changed dates into Channex range entries: consecutive dates whose value without
 * its date is identical (and equally priced) share one `date_from`/`date_to` entry. Exported for
 * the unit test; the entry order follows the dates. */
export function collapseChannexOfferAriValues(
  values: readonly Readonly<{ date: string; priced: boolean; value: ChannexOfferAriValue }>[],
) {
  const entries: Array<Record<string, unknown> & { date_from: string; date_to: string }> = [];
  let open: { from: string; to: string; priced: boolean; rest: Record<string, unknown> } | null =
    null;
  const flush = () => {
    if (open) entries.push({ ...open.rest, date_from: open.from, date_to: open.to });
    open = null;
  };
  for (const item of values) {
    const rest = channexOfferAriValueWithoutDate(item.value) as Record<string, unknown>;
    if (
      open &&
      addDays(open.to, 1) === item.date &&
      open.priced === item.priced &&
      isDeepStrictEqual(open.rest, rest)
    ) {
      open.to = item.date;
      continue;
    }
    flush();
    open = { from: item.date, to: item.date, priced: item.priced, rest };
  }
  flush();
  return entries;
}

/** Reconciles every unresolved delivery of the owned hotel before new work. A delivery with an
 * accepted provider receipt is settled by Channex task readback (the task payload must equal the
 * posted body). A delivery whose receipt shows a transport error, a provider rejection or an
 * unclear answer is closed as unverified: its dates never count as sent, so the next run sends
 * them again (ARI writes are idempotent). A delivery without any receipt whose job attempt is no
 * longer running was provably never answered, and is released. */
export async function reconcilePendingChannexOfferAriDeliveries(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const lease = { ...input };
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  const candidates = (
    await pool.query<{
      id: string;
      targetId: string;
      jobAttemptId: string;
      workerId: string;
      externalPropertyId: string;
      request: unknown;
      attemptRunning: boolean;
    }>(
      `SELECT d.id::text AS id,d.target_id::text AS "targetId",d.job_attempt_id::text AS "jobAttemptId",
         d.worker_id AS "workerId",d.external_property_id AS "externalPropertyId",d.request_body AS request,
         EXISTS (SELECT 1 FROM platform.job_attempts a JOIN platform.jobs j ON j.id=a.job_id
           WHERE a.id=d.job_attempt_id AND a.status='running' AND a.finished_at IS NULL
             AND j.status='running' AND j.locked_by=d.worker_id AND j.attempts_count=a.attempt_number
             AND j.locked_at > clock_timestamp() - interval '5 minutes') AS "attemptRunning"
       FROM pms.channex_offer_ari_deliveries d
       JOIN pms.channex_offer_targets t ON t.id=d.target_id
       WHERE t.property_id=$1 AND t.connection_id=$2 AND d.state='unresolved'
       ORDER BY d.created_at,d.id LIMIT $3`,
      [current.authority.lease.propertyId, current.authority.connectionId, RECONCILIATION_BATCH + 1],
    )
  ).rows;
  for (const candidate of candidates.slice(0, RECONCILIATION_BATCH)) {
    const result = await reconcileDelivery(pool, lease, candidate, get);
    if (result.kind !== "delivery_reconciled" && result.kind !== "delivery_released") return result;
  }
  return candidates.length > RECONCILIATION_BATCH
    ? unavailable("delivery_reconciliation_batch_pending")
    : {
        kind: "pending_deliveries_reconciled" as const,
        count: candidates.length,
      };
}

async function reconcileDelivery(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  delivery: {
    id: string;
    targetId: string;
    jobAttemptId: string;
    workerId: string;
    externalPropertyId: string;
    request: unknown;
    attemptRunning: boolean;
  },
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const receipts = (
    await pool.query<{
      id: string;
      outcome: string;
      httpStatus: number | null;
      hasWarnings: boolean;
      taskIds: string[];
    }>(
      `SELECT id::text AS id,outcome,http_status AS "httpStatus",has_warnings AS "hasWarnings",task_ids AS "taskIds"
       FROM pms.channex_offer_ari_delivery_receipts WHERE delivery_id=$1 ORDER BY captured_at,id`,
      [delivery.id],
    )
  ).rows;
  if (receipts.length === 0) {
    // The current attempt's own delivery is answered inside its dispatch, never here.
    if (delivery.attemptRunning) return unavailable("delivery_in_flight");
    const released = await settleDelivery(pool, lease, delivery.id, "released", null);
    return released.kind === "settled" ? { kind: "delivery_released" as const } : released;
  }
  if (receipts.length !== 1) return unavailable("delivery_receipt_conflict");
  const [receipt] = receipts;
  const accepted =
    receipt.outcome === "complete_json" &&
    receipt.httpStatus === 200 &&
    !receipt.hasWarnings &&
    receipt.taskIds.length > 0;
  if (!accepted) {
    // A definitive provider refusal (any 4xx body shape) parks this body; 408/425/429 are
    // transient like a 5xx or a transport error and are simply sent again.
    const rejected =
      receipt.httpStatus !== null &&
      receipt.httpStatus >= 400 &&
      receipt.httpStatus < 500 &&
      ![408, 425, 429].includes(receipt.httpStatus);
    const settled = await settleDelivery(pool, lease, delivery.id, "reconciled", {
      schemaVersion: 1,
      completionBasis: rejected ? "provider_rejected" : "unverified",
      originalReceiptId: receipt.id,
      receiptOutcome: receipt.outcome,
      httpStatus: receipt.httpStatus,
      requestSha256: sha256(delivery.request),
    });
    return settled.kind === "settled" ? { kind: "delivery_reconciled" as const } : settled;
  }
  let observations: unknown[];
  try {
    observations = await boundedProviderCall(async (signal) => {
      const result = [];
      for (const taskId of receipt.taskIds) {
        signal.throwIfAborted();
        result.push(
          await verifyChannexAriTaskFinish(
            { taskId, externalPropertyId: delivery.externalPropertyId, request: delivery.request },
            (_method, path) => {
              signal.throwIfAborted();
              return get(path, signal);
            },
          ),
        );
      }
      return result;
    });
  } catch {
    return unavailable("delivery_task_observation_unavailable");
  }
  const settled = await settleDelivery(pool, lease, delivery.id, "reconciled", {
    schemaVersion: 1,
    completionBasis: "finished_task_fifo",
    originalReceiptId: receipt.id,
    taskCount: observations.length,
    observationsSha256: createHash("sha256")
      .update(JSON.stringify(observations))
      .digest("hex"),
    requestSha256: sha256(delivery.request),
  });
  return settled.kind === "settled" ? { kind: "delivery_reconciled" as const } : settled;
}

/** Moves one unresolved delivery to a terminal state under the current lease and target lock.
 * The 0520 guard refuses releasing a delivery that has a receipt, so a release can never hide a
 * provider answer that arrived meanwhile. */
async function settleDelivery(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  deliveryId: string,
  state: "reconciled" | "released",
  evidence: Record<string, unknown> | null,
) {
  return withSerializable(pool, async (client) => {
    if (!(await lockChannexPricingJobLease(client, lease))) return unavailable("lease_unavailable");
    const locked = await client.query(
      `SELECT d.id FROM pms.channex_offer_ari_deliveries d
       JOIN pms.channex_offer_targets t ON t.id=d.target_id
       WHERE d.id=$1 AND d.state='unresolved' FOR UPDATE OF t,d NOWAIT`,
      [deliveryId],
    );
    if (!locked.rowCount) return unavailable("delivery_unavailable");
    const updated = await client.query(
      `UPDATE pms.channex_offer_ari_deliveries SET state=$2,reconciliation_evidence=$3::jsonb
       WHERE id=$1 AND state='unresolved' RETURNING id`,
      [deliveryId, state, JSON.stringify(evidence ?? {})],
    );
    return updated.rowCount ? { kind: "settled" as const } : unavailable("delivery_unavailable");
  });
}

/** Selects the first active target of the owned hotel with a difference between desired and last
 * sent values and claims one delivery for it. Targets that are no longer current are skipped and
 * reported; a vanished offer is closed instead (every night `stop_sell`), so a rate plan whose
 * offer left the publication never keeps selling. */
export async function prepareNextChannexOfferAriDelivery(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
) {
  const lease = { ...input };
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  const targets = (
    await pool.query<{ id: string }>(
      `SELECT t.id::text AS id FROM pms.channex_offer_targets t
       WHERE t.property_id=$1 AND t.connection_id=$2 AND t.active_version IS NOT NULL
       ORDER BY t.room_type_id::text COLLATE "C",t.offer_id`,
      [current.authority.lease.propertyId, current.authority.connectionId],
    )
  ).rows;
  const skipped: ChannexOfferDeliverySkip[] = [];
  for (const target of targets) {
    const claimed = await claimDelivery(pool, lease, target.id);
    if (claimed.kind === "current") continue;
    if (claimed.kind === "skipped") {
      skipped.push({ targetId: target.id, reason: claimed.reason });
      continue;
    }
    if (claimed.kind !== "claimed") return claimed;
    return prepareDispatch(pool, lease, claimed);
  }
  return { kind: "offer_ari_current" as const, targetCount: targets.length, skipped };
}

type Claimed = Readonly<{
  kind: "claimed";
  deliveryId: string;
  targetId: string;
  version: string;
  jobAttemptId: string;
  workerId: string;
  propertyId: string;
  connectionId: string;
  bindingGeneration: string;
  request: DeliveryRequest;
}>;

async function claimDelivery(pool: Pool, lease: ChannexPricingJobLeaseInput, targetId: string) {
  return withSerializable(pool, async (client) => {
    const leased = await lockChannexPricingJobLease(client, lease);
    if (!leased) return unavailable("lease_unavailable");
    await lockPmsInventoryMutationScope(client, leased.propertyId);
    const planned = await resolvePlan(client, lease, targetId);
    if (planned.kind !== "plan") return planned;
    const plan = planned.plan;
    const blocked = (
      await client.query<{ reason: string }>(
        `SELECT 'delivery_reconciliation_required' AS reason FROM pms.channex_offer_ari_deliveries
         WHERE target_id=$1 AND state='unresolved'
         UNION ALL
         SELECT 'ari_reconciliation_required' FROM pms.channex_offer_ari_attempts
         WHERE target_id=$1 AND state='unresolved' LIMIT 1`,
        [targetId],
      )
    ).rows[0];
    if (blocked) return unavailable(blocked.reason);
    const lastSent = await readLastSent(client, plan);
    const changed = plan.values.filter((item) => lastSent.get(item.date) !== item.valueSha256);
    if (changed.length === 0) return { kind: "current" as const };
    const entries = collapseChannexOfferAriValues(changed).slice(
      0,
      CHANNEX_OFFER_ARI_DELIVERY_ENTRY_LIMIT,
    );
    const through = entries[entries.length - 1]!.date_to;
    const covered = changed.filter((item) => item.date <= through);
    const body = {
      values: entries.map((entry) => ({
        property_id: plan.externalPropertyId,
        rate_plan_id: plan.externalRatePlanId,
        ...entry,
      })),
    };
    const requestSha256 = sha256(body);
    // Channex refused exactly this body last time: do not loop on it until the inputs change.
    const rejected = await client.query(
      `SELECT 1 FROM pms.channex_offer_ari_deliveries
       WHERE target_id=$1 AND state='reconciled'
         AND reconciliation_evidence->>'completionBasis'='provider_rejected'
         AND reconciliation_evidence->>'requestSha256'=$2
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [targetId, requestSha256],
    );
    if (rejected.rowCount) return { kind: "skipped" as const, reason: "provider_rejected" };
    const version = (
      await client.query<{ version: string; externalRoomTypeId: string; connectionId: string }>(
        `SELECT t.active_version::text AS version,v.external_room_type_id AS "externalRoomTypeId",
           t.connection_id::text AS "connectionId"
         FROM pms.channex_offer_targets t
         JOIN pms.channex_offer_target_versions v ON v.target_id=t.id AND v.version=t.active_version
         WHERE t.id=$1 FOR UPDATE OF t NOWAIT`,
        [targetId],
      )
    ).rows[0];
    if (!version) return unavailable("target_unavailable");
    const delivery = (
      await client.query<{ id: string; jobAttemptId: string; workerId: string }>(
        `INSERT INTO pms.channex_offer_ari_deliveries
           (target_id,version,binding_generation,external_property_id,external_room_type_id,
            external_rate_plan_id,job_attempt_id,worker_id,request_body)
         SELECT $1,$2::bigint,$3::uuid,$4,$5,$6,a.id,a.worker_id,$7::jsonb
         FROM platform.job_attempts a
         WHERE a.job_id=$8 AND a.attempt_number=$9 AND a.worker_id=$10
         RETURNING id::text AS id,job_attempt_id::text AS "jobAttemptId",worker_id AS "workerId"`,
        [
          targetId,
          version.version,
          plan.bindingGeneration,
          plan.externalPropertyId,
          version.externalRoomTypeId,
          plan.externalRatePlanId,
          JSON.stringify(body),
          lease.jobId,
          lease.attemptNumber,
          lease.workerId,
        ],
      )
    ).rows[0];
    if (!delivery) return unavailable("delivery_attempt_unavailable");
    await client.query(
      `INSERT INTO pms.channex_offer_ari_delivery_dates
         (delivery_id,service_date,binding_generation,external_property_id,external_rate_plan_id,
          delivered_at,value,value_sha256)
       SELECT $1,d,$2::uuid,$3,$4,clock_timestamp(),v,s
       FROM unnest($5::date[],$6::jsonb[],$7::text[]) AS covered(d,v,s)`,
      [
        delivery.id,
        plan.bindingGeneration,
        plan.externalPropertyId,
        plan.externalRatePlanId,
        covered.map((item) => item.date),
        covered.map((item) => JSON.stringify(item.value)),
        covered.map((item) => item.valueSha256),
      ],
    );
    return {
      kind: "claimed" as const,
      deliveryId: delivery.id,
      targetId,
      version: version.version,
      jobAttemptId: delivery.jobAttemptId,
      workerId: delivery.workerId,
      propertyId: leased.propertyId,
      connectionId: version.connectionId,
      bindingGeneration: plan.bindingGeneration,
      request: { method: "POST", path: "/api/v1/restrictions", body } as DeliveryRequest,
    };
  });
}

type DeliveryPlan = Readonly<{
  bindingGeneration: string;
  externalPropertyId: string;
  externalRatePlanId: string;
  from: string;
  through: string;
  values: readonly Readonly<{
    date: string;
    priced: boolean;
    value: ChannexOfferAriValue;
    valueSha256: string;
  }>[];
}>;

/** D2b's classification decides per target: current values, a skip, or closing a vanished offer. */
async function resolvePlan(client: PoolClient, lease: ChannexPricingJobLeaseInput, targetId: string) {
  const desired = await readChannexOfferDesiredAri(client, { ...lease, targetId });
  if (desired.kind === "desired") return { kind: "plan" as const, plan: desired as DeliveryPlan };
  if (
    desired.reason === "active_offer_configuration_changed" ||
    desired.reason === "active_offer_binding_changed"
  )
    return { kind: "skipped" as const, reason: desired.reason };
  if (desired.reason !== "selection_unavailable") return desired;
  const closed = await closedPlan(client, lease, targetId);
  return closed.kind === "closed" ? { kind: "plan" as const, plan: closed as DeliveryPlan } : closed;
}

type ClosedPlan = Readonly<{
  kind: "closed";
  bindingGeneration: string;
  externalPropertyId: string;
  externalRatePlanId: string;
  from: string;
  through: string;
  values: readonly Readonly<{
    date: string;
    priced: boolean;
    value: ChannexOfferAriValue;
    valueSha256: string;
  }>[];
}>;

/** Every night closed for a target whose offer left the publication, over the same horizon. */
async function closedPlan(client: PoolClient, lease: ChannexPricingJobLeaseInput, targetId: string) {
  const authority = await lockChannexPricingPropertyAuthority(client, lease);
  if (authority.kind !== "authorized") return authority;
  const row = (
    await client.query<{
      bindingGeneration: string;
      externalPropertyId: string;
      externalRatePlanId: string;
      timeZone: unknown;
      now: Date;
    }>(
      `SELECT v.binding_generation::text AS "bindingGeneration",v.external_property_id AS "externalPropertyId",
         v.external_rate_plan_id AS "externalRatePlanId",location.timezone AS "timeZone",clock_timestamp() AS now
       FROM pms.channex_offer_targets t
       JOIN pms.channex_offer_target_versions v ON v.target_id=t.id AND v.version=t.active_version
       JOIN pms.channel_connections c ON c.id=t.connection_id AND c.binding_generation=v.binding_generation
       LEFT JOIN hotel_catalog.property_locations location ON location.property_id=t.property_id
       WHERE t.id=$1 AND t.property_id=$2 AND t.connection_id=$3 AND v.external_property_id=$4
       FOR SHARE OF t NOWAIT`,
      [targetId, authority.lease.propertyId, authority.connectionId, authority.externalPropertyId],
    )
  ).rows[0];
  if (!row) return { kind: "skipped" as const, reason: "active_offer_binding_changed" };
  const today = channexPropertyLocalDate(row.timeZone, row.now);
  if (!today) return unavailable("property_timezone_unavailable");
  const through = addDays(today, DEFAULT_FULL_ARI_DAYS_AHEAD);
  const values = [];
  for (let date = today; date <= through; date = addDays(date, 1)) {
    const value: ChannexOfferAriValue = {
      property_id: row.externalPropertyId,
      rate_plan_id: row.externalRatePlanId,
      date,
      stop_sell: true,
    };
    values.push({ date, priced: false, value, valueSha256: channexOfferAriValueSha256(value) });
  }
  return {
    kind: "closed" as const,
    bindingGeneration: row.bindingGeneration,
    externalPropertyId: row.externalPropertyId,
    externalRatePlanId: row.externalRatePlanId,
    from: today,
    through,
    values,
  };
}

/** Last accepted value per date for the key: the latest task-verified delivery date or initial
 * ARI attempt, by write time. Unverified and rejected deliveries contribute nothing. */
async function readLastSent(
  client: PoolClient,
  plan: {
    bindingGeneration: string;
    externalPropertyId: string;
    externalRatePlanId: string;
    from: string;
    through: string;
  },
) {
  const rows = (
    await client.query<{ date: string; sha: string | null; value: unknown; sentAt: Date }>(
      `SELECT d.service_date::text AS date,d.value_sha256 AS sha,NULL::jsonb AS value,x.created_at AS "sentAt"
       FROM pms.channex_offer_ari_delivery_dates d
       JOIN pms.channex_offer_ari_deliveries x ON x.id=d.delivery_id
       WHERE x.state='reconciled' AND x.reconciliation_evidence->>'completionBasis'='finished_task_fifo'
         AND d.binding_generation=$1::uuid AND d.external_property_id=$2 AND d.external_rate_plan_id=$3
         AND d.service_date BETWEEN $4::date AND $5::date
       UNION ALL
       SELECT a.service_date::text,NULL,a.request_body->'values'->0,a.created_at
       FROM pms.channex_offer_ari_attempts a
       WHERE a.state='reconciled' AND a.reconciliation_evidence->>'completionBasis'='finished_task_fifo'
         AND a.binding_generation=$1::uuid AND a.external_property_id=$2 AND a.external_rate_plan_id=$3
         AND a.service_date BETWEEN $4::date AND $5::date
       ORDER BY 1,4 DESC`,
      [
        plan.bindingGeneration,
        plan.externalPropertyId,
        plan.externalRatePlanId,
        plan.from,
        plan.through,
      ],
    )
  ).rows;
  const last = new Map<string, string>();
  for (const row of rows) {
    if (last.has(row.date)) continue;
    last.set(
      row.date,
      row.sha ?? channexOfferAriValueSha256(row.value as ChannexOfferAriValue),
    );
  }
  return last;
}

/** A fresh claim creates one in-memory send capability; a retained delivery is never reopened. */
async function prepareDispatch(pool: Pool, lease: ChannexPricingJobLeaseInput, claim: Claimed) {
  let used = false;
  return {
    kind: "prepared" as const,
    deliveryId: claim.deliveryId,
    targetId: claim.targetId,
    async dispatch(post: (request: DeliveryRequest, signal: AbortSignal) => Promise<Response>) {
      if (used) return unavailable("dispatch_already_used");
      used = true;
      const fresh = await verifyBeforePost(pool, lease, claim);
      if (fresh.kind !== "verified") {
        const released = await settleDelivery(pool, lease, claim.deliveryId, "released", null);
        return released.kind === "settled"
          ? unavailable("delivery_stale")
          : unavailable("delivery_reconciliation_required");
      }
      let response: Response | null = null;
      try {
        response = await boundedProviderCall((signal) =>
          post(structuredClone(claim.request), signal),
        );
      } catch {
        /* A timed-out or thrown POST remains an unresolved provider mutation. */
      }
      const correlation = {
        receiptId: randomUUID(),
        deliveryId: claim.deliveryId,
        jobAttemptId: claim.jobAttemptId,
        workerId: claim.workerId,
        propertyId: claim.propertyId,
        connectionId: claim.connectionId,
      };
      const persist = await (response === null
        ? prepareChannexOfferDeliveryTransportFailurePersistence(pool, correlation)
        : prepareChannexOfferDeliveryReceiptPersistence(pool, correlation, response));
      // A transport failure or a 5xx is reported as a failed turn, so the worker retries with
      // its backoff and attempt ceiling instead of re-sending every second; the receipt stays and
      // the next reconciliation closes the delivery as unverified before the resend.
      const failed =
        response === null
          ? ("transport" as const)
          : response.status >= 500
            ? ("provider_unavailable" as const)
            : null;
      try {
        await persist();
      } catch {
        return { kind: "receipt_pending" as const, persist, deliveryId: claim.deliveryId, failed };
      }
      return failed
        ? { kind: "delivery_failed" as const, deliveryId: claim.deliveryId, reason: failed }
        : { kind: "retained" as const, deliveryId: claim.deliveryId };
    },
  };
}

/** The delivery must still be the unsent claim of this attempt on the same active version and
 * binding, under current authority, right before the POST. */
async function verifyBeforePost(pool: Pool, lease: ChannexPricingJobLeaseInput, claim: Claimed) {
  return withSerializable(pool, async (client) => {
    const authority = await lockChannexPricingPropertyAuthority(client, lease);
    if (authority.kind !== "authorized") return authority;
    if (
      authority.connectionId !== claim.connectionId ||
      authority.lease.propertyId !== claim.propertyId ||
      authority.lease.workerId !== claim.workerId
    )
      return unavailable("delivery_stale");
    const row = await client.query(
      `SELECT d.id FROM pms.channex_offer_ari_deliveries d
       JOIN pms.channex_offer_targets t ON t.id=d.target_id
       JOIN pms.channel_connections c ON c.id=t.connection_id
       WHERE d.id=$1 AND d.state='unresolved' AND d.job_attempt_id=$2 AND d.worker_id=$3
         AND d.request_body=$4::jsonb AND t.active_version=$5::bigint
         AND d.binding_generation=$6::uuid AND c.binding_generation=$6::uuid
         AND c.connection_status='connected'
         AND NOT EXISTS (SELECT 1 FROM pms.channex_offer_ari_delivery_receipts r WHERE r.delivery_id=d.id)
       FOR SHARE OF t,d,c NOWAIT`,
      [
        claim.deliveryId,
        claim.jobAttemptId,
        claim.workerId,
        JSON.stringify(claim.request.body),
        claim.version,
        claim.bindingGeneration,
      ],
    );
    return row.rowCount ? { kind: "verified" as const } : unavailable("delivery_stale");
  });
}

async function withSerializable<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let committed = false,
    discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const result = await run(client);
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    // Lock contention and serialization failures are retried by the next job turn, as in the
    // initial ARI path; every caller already handles an unavailable outcome.
    const code = (error as { code?: unknown })?.code;
    if (code === "55P03" || code === "40001" || code === "40P01" || code === "57014")
      return unavailable("delivery_contention");
    // The 0520 guard refused the write (a lease or identity that moved under the claim).
    if (code === "23514") return unavailable("delivery_refused");
    throw error;
  } finally {
    if (!committed) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}

async function boundedProviderCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Channex request deadline"));
    }, 15_000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}
