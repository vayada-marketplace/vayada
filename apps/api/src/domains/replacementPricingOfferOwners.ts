import { randomUUID } from "node:crypto";
import { prepareChannexReceiptPersistence } from "./channexCreationReceiptStore.js";
import { verifyChannexOfferRoom, verifyChannexOfferConfiguration } from "../integrations/channexOfferConfiguration.js";
import { channexCreationReceiptsResolved, readChannexCreationReceiptIdentity } from "./channexCreationReceiptGate.js";
import { planChannexOfferConfiguration, readChannexCreatedRateIdentity } from "../integrations/channexOfferConfiguration.js";
import { performance } from "node:perf_hooks";
import { lockChannexPricingJobLease, type ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { readCurrentPricingSnapshot, PricingStorageError } from "./replacementPricingSnapshot.js";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { parsePricingConfiguration, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockBookingPricingOfferTerms, lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness, type FinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsPricingRoomScope, lockPmsPricingRoomCapacity } from "./pmsPricingRoomScope.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockReplacementChargeDeclaration, type ReplacementChargeDeclaration } from "./replacementChargeDeclarations.js";
import type { PricingStorageScope, PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";

export type ReplacementPricingOfferOwners =
  | { kind: "verified"; terms: readonly ReplacementOfferTerms[]; finance: Extract<FinanceReplacementPricingReadiness, { kind: "ready" }>; charges: ReplacementChargeDeclaration }
  | { kind: "unavailable"; reason: "invalid" | "denied" | "room_unavailable" | "room_source_stale" | "terms_stale" | "terms_source_stale" | "finance_unavailable" | "finance_source_stale" | "charges_stale";
      financeReason?: Extract<FinanceReplacementPricingReadiness, { kind: "unavailable" }>["reason"] };

type DraftPricingOwners = ReplacementPricingOfferOwners | { kind: "awaiting_charge_confirmation" };

/** Drafts may await confirmation; a supplied declaration must still match. */
export async function lockReplacementPricingDraftOwners(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, proposed: unknown, sources: PricingStorageSources): Promise<DraftPricingOwners> {
  if (!await lockReplacementPricingAuthorization(client, context, scope, "manage")) return { kind: "unavailable", reason: "denied" };
  return lockOwners(client, scope, proposed, sources, "draft");
}

/** Caller must BEGIN/COMMIT the transaction. Rechecks live manage authorization and
 * holds PMS/Booking/Finance locks until its end and verifies the charge declaration.
 * Rechecks room/terms/Finance sources through their owners. Other source keys and
 * currency conversion still require explicit validation before publication. */
export async function lockReplacementPricingOfferOwners(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, proposed: unknown, sources: PricingStorageSources): Promise<ReplacementPricingOfferOwners> {
  if (!await lockReplacementPricingAuthorization(client, context, scope, "manage")) return { kind: "unavailable", reason: "denied" };
  const result = await lockOwners(client, scope, proposed, sources, "publish");
  return result.kind === "awaiting_charge_confirmation" ? { kind: "unavailable", reason: "charges_stale" } : result;
}

async function lockOwners(client: PoolClient,
  scope: Pick<PricingStorageScope, "propertyId">, proposed: unknown, sources: PricingStorageSources, intent: "draft" | "publish"): Promise<DraftPricingOwners> {
  const unavailable = (reason: Extract<ReplacementPricingOfferOwners, { kind: "unavailable" }>["reason"]): ReplacementPricingOfferOwners => ({ kind: "unavailable", reason });
  if (!pricingObject(proposed) || !pricingKeys(proposed, ["currency", "rooms", "ownerReferences"]) ||
      typeof proposed.currency !== "string" || !Array.isArray(proposed.rooms) || !proposed.rooms.length || !pricingObject(proposed.ownerReferences) ||
      !Object.entries(proposed.ownerReferences).every(([key, value]) => key.length > 0 && key === key.trim() && typeof value === "string" && value.length > 0 && value === value.trim()) ||
      typeof proposed.ownerReferences.finance !== "string") return unavailable("invalid");
  const rooms = Array.from(proposed.rooms, parsePricingConfiguration);
  const revision = rooms[0]?.revision, currency = proposed.currency, expectedEvidenceId = proposed.ownerReferences.finance;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!revision || revision > 2147483647 || rooms.some((r) => !r || !uuid.test(r.roomTypeId) ||
      r.propertyId !== scope.propertyId.toLowerCase() || r.currency !== currency || r.revision !== revision) ||
      new Set(rooms.map((r) => r!.roomTypeId.toLowerCase())).size !== rooms.length) return unavailable("invalid");
  const snapshot: PricingStorageSnapshot = { currency, rooms: rooms.map((r) => r!),
    ownerReferences: structuredClone(proposed.ownerReferences) as PricingStorageSources };
  const currentSources = structuredClone(sources);
  const roomSource = await lockPmsReplacementPricingRoomSource(client, scope.propertyId);
  const references = [];
  for (const room of rooms) {
    if (!await lockPmsPricingRoomScope(client, scope.propertyId, room!.roomTypeId)) return unavailable("room_unavailable");
    references.push(...room!.offers.map((o) => ({ roomTypeId: room!.roomTypeId, offerId: o.id, revision: o.termsRevision })));
  }
  if (!roomSource || currentSources.room !== roomSource) return unavailable("room_source_stale");
  const terms = await lockBookingPricingOfferTerms(client, scope.propertyId, references);
  if (!terms) return unavailable("terms_stale");
  const termsSource = await lockBookingPricingTermsSource(client, scope.propertyId);
  if (!termsSource || currentSources.terms !== termsSource) return unavailable("terms_source_stale");
  const financeSource = await lockFinanceReplacementPricingSource(client, scope.propertyId);
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId: scope.propertyId, currency, pricingRevision: revision, terms, expectedEvidenceId,
  });
  if (finance.kind !== "ready") return { kind: "unavailable", reason: "finance_unavailable", financeReason: finance.reason };
  if (!financeSource || currentSources.finance !== financeSource) return unavailable("finance_source_stale");
  if (intent === "draft" && snapshot.ownerReferences.charges === undefined) return { kind: "awaiting_charge_confirmation" };
  const charges = await lockReplacementChargeDeclaration(client, scope.propertyId, snapshot.ownerReferences.charges ?? "", snapshot, currentSources);
  return charges ? { kind: "verified", terms, finance, charges } : unavailable("charges_stale");
}

/** Server-only worker entrypoint. No payload identities or user impersonation.
 * A successful coherent snapshot is not a send permit. Delivery must recheck
 * authority, publication, owners and mapping generation in a fresh transaction.
 * Contention/serialization/timeouts propagate for durable-worker retry.
 */
type TargetSelection = Readonly<{
  roomTypeId: string;
  offerId: string;
  operationKey: string;
  primaryOccupancy: number;
}>;

export async function readPublishedPricingForChannexJob(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
) {
  const result = await withPublishedChannexPricing(pool, input);
  if (result.kind !== "available") return result;
  const {
    reservation: _reservation,
    createClaim: _createClaim,
    identification: _identification,
    configurationIdentity: _configurationIdentity,
    ...evidence
  } = result;
  return evidence;
}

/** Reserves local work only; neither a provider configuration nor activation permission. */
export async function reservePublishedChannexOfferTarget(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
) {
  const result = await withSelectedChannexTarget(pool, input, selection, "reserve");
  if (result.kind !== "available") return result;
  if (!result.reservation) throw new Error("Target reservation missing");
  return { kind: "reserved" as const, ...result.reservation };
}

/** Records a first creation attempt only; provider preflight/dispatch remain separate. */
export async function claimPublishedChannexOfferCreate(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
) {
  const result = await withSelectedChannexTarget(pool, input, selection, "claim");
  if (result.kind !== "available") return result;
  if (!result.createClaim) throw new Error("Creation claim missing");
  return { kind: "claimed" as const, ...result.createClaim };
}

type TargetWork =
  | "reserve"
  | "claim"
  | { kind: "retained"; attemptId: string }
  | { kind: "configuration"; attemptId: string; observation?: Awaited<ReturnType<typeof verifyChannexOfferConfiguration>> }
  | { kind: "dispatch"; attemptId: string; jobAttemptId: string; workerId: string }
  | ({ attemptId: string } & ReturnType<typeof readChannexCreatedRateIdentity>);

/** Records identity only; fresh authority still applies to late provider observations. */
export async function recordPublishedChannexOfferCreate(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  receipt: { attemptId: string; response: unknown },
) {
  if (
    !receipt ||
    typeof receipt.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const work = {
    attemptId: receipt.attemptId,
    ...readChannexCreatedRateIdentity(receipt.response),
  };
  const result = await withSelectedChannexTarget(pool, input, selection, work);
  if (result.kind !== "available") return result;
  if (!result.identification) throw new Error("Creation identification missing");
  return { kind: "identified" as const, ...result.identification };
}

/** Reconcile only durable original-dispatch evidence; current authority is still required. */
export async function recordRetainedChannexOfferCreate(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const result = await withSelectedChannexTarget(pool, input, selection, {
    kind: "retained",
    attemptId,
  });
  if (result.kind !== "available") return result;
  if (!result.identification) throw new Error("Creation identification missing");
  return { kind: "identified" as const, ...result.identification };
}

/** Retains a validated metadata observation only; never seals or activates a target. */
export async function retainChannexOfferConfiguration(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const before = await withSelectedChannexTarget(pool, lease, selected, {
    kind: "configuration",
    attemptId,
  });
  if (before.kind !== "available") return before;
  if (!before.configurationIdentity) throw new Error("Configuration identity missing");
  const room = before.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const observation = await verifyChannexOfferConfiguration(
    room,
    selected.offerId,
    selected.primaryOccupancy,
    before.configurationIdentity,
    (_method, path) => boundedProviderCall((signal) => get(path, signal)),
  );
  const after = await withSelectedChannexTarget(pool, lease, selected, {
    kind: "configuration",
    attemptId,
    observation,
  });
  if (after.kind !== "available") return after;
  return { kind: "configuration_retained" as const, attemptId };
}

/** Only a newly committed claim can create this one-shot closure. No runtime adapter is wired. */
export async function prepareChannexOfferDispatch(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
) {
  const lease = { ...input },
    selected = { ...selection };
  const claimed = await withSelectedChannexTarget(pool, lease, selected, "claim");
  if (claimed.kind !== "available") return claimed;
  const claim = claimed.createClaim;
  if (!claim) throw new Error("Creation claim missing");
  const request = claim.request;
  const room = claimed.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const body = claim.request.body as { rate_plan: { property_id: string; room_type_id: string } };
  const work = {
    kind: "dispatch" as const,
    attemptId: claim.attemptId,
    jobAttemptId: claim.jobAttemptId,
    workerId: claim.workerId,
  };
  let used = false;
  return {
    kind: "prepared" as const,
    async dispatch(ports: {
      getRoom(path: string, signal: AbortSignal): Promise<unknown>;
      create(payload: typeof request, signal: AbortSignal): Promise<Response>;
    }) {
      if (used) return { kind: "unavailable" as const, reason: "dispatch_already_used" };
      used = true;
      const before = await withSelectedChannexTarget(pool, lease, selected, work);
      if (before.kind !== "available") return before;
      let response: Response;
      try {
        await verifyChannexOfferRoom(
          room,
          {
            externalPropertyId: body.rate_plan.property_id,
            externalRoomTypeId: body.rate_plan.room_type_id,
          },
          (_method, path) => boundedProviderCall((signal) => ports.getRoom(path, signal)),
        );
        const current = await withSelectedChannexTarget(pool, lease, selected, work);
        if (current.kind !== "available") return current;
        response = await boundedProviderCall((signal) =>
          ports.create(structuredClone(claim.request), signal),
        );
      } catch {
        return { kind: "unavailable" as const, reason: "creation_reconciliation_required" };
      }
      const persist = await prepareChannexReceiptPersistence(
        pool,
        {
          receiptId: randomUUID(),
          attemptId: claim.attemptId,
          jobAttemptId: claim.jobAttemptId,
          workerId: claim.workerId,
          propertyId: claimed.authority.lease.propertyId,
          connectionId: claimed.authority.connectionId,
        },
        response,
      );
      try {
        await persist();
        return { kind: "retained" as const, attemptId: claim.attemptId };
      } catch {
        return { kind: "receipt_pending" as const, persist };
      }
    },
  };
}

async function boundedProviderCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Channex request deadline"));
    }, 15000);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function withSelectedChannexTarget(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  work: TargetWork,
) {
  if (
    !selection ||
    ![selection.roomTypeId, selection.offerId, selection.operationKey].every(
      (value) => typeof value === "string" && value.length > 0 && value === value.trim(),
    )
  )
    return { kind: "unavailable" as const, reason: "invalid_selection" };
  if (!Number.isSafeInteger(selection.primaryOccupancy) || selection.primaryOccupancy < 1)
    return { kind: "unavailable" as const, reason: "invalid_primary_occupancy" };
  return withPublishedChannexPricing(pool, input, { ...selection }, work);
}

async function withPublishedChannexPricing(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection?: TargetSelection,
  work: TargetWork = "reserve",
) {
  const leaseInput = {
    jobId: input.jobId,
    workerId: input.workerId,
    attemptNumber: input.attemptNumber,
  };
  const connection = await pool.connect();
  const started = performance.now();
  const deadlineError = () =>
    Object.assign(new Error("Pricing read deadline exceeded"), { code: "57014" });
  // Owner ports share this transaction client, so their loops cannot reset the
  // aggregate budget. Cleanup uses the original connection even after expiry.
  const client = new Proxy(connection, {
    get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (sql: string, values?: unknown[]) => {
        const remaining = Math.floor(5_000 - (performance.now() - started));
        if (remaining <= 0) throw deadlineError();
        await target.query("SELECT set_config('statement_timeout',$1,true)", [`${remaining}ms`]);
        if (performance.now() - started >= 5_000) throw deadlineError();
        return target.query(sql, values);
      };
    },
  });
  const unavailable = (reason: string) => ({ kind: "unavailable" as const, reason });
  try {
    await connection.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout='150ms'");

    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    const lease = await lockChannexPricingJobLease(client, leaseInput);
    if (!lease) return unavailable("lease_unavailable");
    await lockPmsInventoryMutationScope(client, lease.propertyId);
    const authority = await lockChannexPricingPropertyAuthority(client, leaseInput);
    if (authority.kind !== "authorized") return authority;
    const snapshot = await readCurrentPricingSnapshot(client, lease.propertyId);
    if (!snapshot) return unavailable("publication_missing");
    if (
      Object.keys(snapshot.sources).length !== 3 ||
      !["room", "terms", "finance"].every((key) => typeof snapshot.sources[key] === "string") ||
      Object.keys(snapshot.ownerReferences).length !== 2 ||
      !["finance", "charges"].every((key) => typeof snapshot.ownerReferences[key] === "string")
    )
      return unavailable("publication_invalid");
    const proposed = {
      currency: snapshot.currency,
      rooms: snapshot.rooms,
      ownerReferences: snapshot.ownerReferences,
    };
    const owners = await lockOwners(client, lease, proposed, snapshot.sources, "publish");
    if (owners.kind !== "verified")
      return unavailable(
        owners.kind === "unavailable" && owners.reason.endsWith("_source_stale")
          ? "sources_stale"
          : "owner_unavailable",
      );
    for (const room of snapshot.rooms)
      if (
        !(await lockPmsPricingRoomCapacity(
          client,
          lease.propertyId,
          room.roomTypeId,
          room.capacity,
        ))
      )
        return unavailable("owner_unavailable");
    let reservation: { targetId: string; intentId: string; version: string } | undefined;
    let createClaim:
      | {
          attemptId: string;
          targetId: string;
          intentId: string;
          version: string;
          bindingGeneration: string;
          jobAttemptId: string;
          workerId: string;
          request: { method: "POST"; path: "/api/v1/rate_plans"; body: unknown };
        }
      | undefined;
    let identification: { attemptId: string; externalRatePlanId: string } | undefined;
    let configurationIdentity: ReturnType<typeof readChannexCreatedRateIdentity> | undefined;
    if (selection) {
      const room = snapshot.rooms.find((room) => room.roomTypeId === selection.roomTypeId);
      if (!room || !room.offers.some((offer) => offer.id === selection.offerId))
        return unavailable("selection_unavailable");
      const plan = planChannexOfferConfiguration(
        room,
        selection.offerId,
        selection.primaryOccupancy,
      );
      if (plan.kind !== "planned") return plan;
      const binding = (
        await client.query(
          "SELECT binding_generation FROM pms.channel_connections WHERE id=$1 FOR SHARE NOWAIT",
          [authority.connectionId],
        )
      ).rows[0];
      if (!binding) return unavailable("connection_unavailable");
      const proposal = JSON.stringify({
        publicationRevision: snapshot.revision,
        sources: snapshot.sources,
        ownerReferences: snapshot.ownerReferences,
        currency: snapshot.currency,
        bindingGeneration: binding.binding_generation,
        externalPropertyId: authority.externalPropertyId,
        room,
        offerId: selection.offerId,
        primaryOccupancy: selection.primaryOccupancy,
        providerConfiguration: plan.configuration,
      });
      await client.query(
        `INSERT INTO pms.channex_offer_targets
        (property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(connection_id,room_type_id,offer_id) DO NOTHING`,
        [lease.propertyId, authority.connectionId, room.roomTypeId, selection.offerId],
      );
      const target = (
        await client.query(
          `SELECT id FROM pms.channex_offer_targets
        WHERE connection_id=$1 AND room_type_id=$2 AND offer_id=$3 FOR UPDATE NOWAIT`,
          [authority.connectionId, room.roomTypeId, selection.offerId],
        )
      ).rows[0];
      const existing = (
        await client.query(
          `SELECT id,version,status,proposal=$3::jsonb AS matches
        FROM pms.channex_offer_target_intents WHERE target_id=$1 AND operation_key=$2`,
          [target.id, selection.operationKey, proposal],
        )
      ).rows[0];
      if (existing && (!existing.matches || existing.status !== "pending"))
        return unavailable("operation_conflict");
      if (
        !existing &&
        (
          await client.query(
            `SELECT 1 FROM pms.channex_offer_target_intents
        WHERE target_id=$1 AND status='pending'`,
            [target.id],
          )
        ).rowCount
      )
        return unavailable("pending_conflict");
      const intent =
        existing ??
        (
          await client.query(
            `INSERT INTO pms.channex_offer_target_intents
        (target_id,operation_key,proposal) VALUES($1,$2,$3::jsonb) RETURNING id,version`,
            [target.id, selection.operationKey, proposal],
          )
        ).rows[0];
      reservation = { targetId: target.id, intentId: intent.id, version: intent.version };
      if (work !== "reserve") {
        const recorded = (
          await client.query(
            `SELECT state FROM pms.channex_offer_create_attempts
           WHERE target_id=$1 AND (intent_id=$2 OR state='unresolved')`,
            [target.id, intent.id],
          )
        ).rows[0];
        if (work === "claim" && recorded)
          return unavailable(
            recorded.state === "unresolved"
              ? "creation_reconciliation_required"
              : "creation_already_identified",
          );
        if (work === "claim" && !(await channexCreationReceiptsResolved(client, target.id)))
          return unavailable("creation_reconciliation_required");
        const mapping = (
          await client.query(
            `SELECT external_room_type_id FROM pms.channel_room_type_mappings
           WHERE connection_id=$1 AND property_id=$2 AND room_type_id=$3 AND status='active'
           FOR SHARE NOWAIT`,
            [authority.connectionId, lease.propertyId, room.roomTypeId],
          )
        ).rows[0];
        if (
          !mapping ||
          typeof mapping.external_room_type_id !== "string" ||
          !mapping.external_room_type_id.trim() ||
          mapping.external_room_type_id !== mapping.external_room_type_id.trim()
        )
          return unavailable("room_mapping_unavailable");
        const body = {
          rate_plan: {
            ...plan.configuration,
            property_id: authority.externalPropertyId,
            room_type_id: mapping.external_room_type_id,
            // Display only. Recovery must never adopt a provider rate by this title.
            title: `Vayada offer ${target.id} v${intent.version}`,
            inherit_stop_sell: false,
            auto_rate_settings: null,
          },
        };
        if (work === "claim") {
          const attempt = (
            await client.query(
              `INSERT INTO pms.channex_offer_create_attempts
           (target_id,intent_id,version,binding_generation,external_property_id,external_room_type_id,request_body,job_attempt_id,worker_id)
           SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,a.id,a.worker_id
           FROM platform.job_attempts a
           WHERE a.job_id=$8 AND a.attempt_number=$9 AND a.worker_id=$10
           RETURNING id,job_attempt_id,worker_id`,
              [
                target.id,
                intent.id,
                intent.version,
                binding.binding_generation,
                authority.externalPropertyId,
                mapping.external_room_type_id,
                JSON.stringify(body),
                lease.jobId,
                lease.attemptNumber,
                lease.workerId,
              ],
            )
          ).rows[0];
          if (!attempt) return unavailable("creation_attempt_unavailable");
          createClaim = {
            ...reservation,
            attemptId: attempt.id,
            jobAttemptId: attempt.job_attempt_id,
            workerId: attempt.worker_id,
            bindingGeneration: binding.binding_generation,
            request: { method: "POST", path: "/api/v1/rate_plans", body },
          };
        } else {
          const attempt = (
            await client.query(
              `SELECT id,state,external_rate_plan_id,job_attempt_id,worker_id,
              binding_generation=$4 AND external_property_id=$5 AND external_room_type_id=$6 AND request_body=$7::jsonb AS matches
             FROM pms.channex_offer_create_attempts WHERE id=$1 AND target_id=$2 AND intent_id=$3 FOR UPDATE NOWAIT`,
              [
                work.attemptId,
                target.id,
                intent.id,
                binding.binding_generation,
                authority.externalPropertyId,
                mapping.external_room_type_id,
                JSON.stringify(body),
              ],
            )
          ).rows[0];
          if (!attempt || !attempt.matches) return unavailable("creation_attempt_unavailable");
          if ("kind" in work && work.kind === "configuration") {
            if (
              attempt.state !== "identified" ||
              !(await channexCreationReceiptsResolved(client, target.id))
            )
              return unavailable("creation_reconciliation_required");
            configurationIdentity = {
              externalPropertyId: authority.externalPropertyId,
              externalRoomTypeId: mapping.external_room_type_id as string,
              externalRatePlanId: attempt.external_rate_plan_id as string,
            };
            if (work.observation) {
              const observed = work.observation;
              if (
                observed.externalPropertyId !== configurationIdentity.externalPropertyId ||
                observed.externalRoomTypeId !== configurationIdentity.externalRoomTypeId ||
                observed.externalRatePlanId !== configurationIdentity.externalRatePlanId ||
                JSON.stringify(observed.configuration) !== JSON.stringify(plan.configuration)
              )
                return unavailable("configuration_observation_mismatch");
              const evidence = JSON.stringify({
                schemaVersion: 1,
                attemptId: attempt.id,
                intentId: intent.id,
                version: intent.version,
                bindingGeneration: binding.binding_generation,
                observation: observed,
              });
              const saved = await client.query(
                `UPDATE pms.channex_offer_target_intents
                 SET result_evidence=jsonb_set(result_evidence,'{configuration}',$2::jsonb)
                 WHERE id=$1 AND status='pending' AND
                   (NOT result_evidence ? 'configuration' OR result_evidence->'configuration'=$2::jsonb)
                 RETURNING id`,
                [intent.id, evidence],
              );
              if (!saved.rowCount) return unavailable("configuration_evidence_conflict");
            }
          } else if ("kind" in work && work.kind === "dispatch") {
            if (
              attempt.state !== "unresolved" ||
              attempt.job_attempt_id !== work.jobAttemptId ||
              attempt.worker_id !== work.workerId ||
              lease.workerId !== work.workerId
            )
              return unavailable("creation_attempt_unavailable");
            const original = await client.query(
              "SELECT id FROM platform.job_attempts WHERE id=$1 AND job_id=$2 AND attempt_number=$3",
              [work.jobAttemptId, lease.jobId, lease.attemptNumber],
            );
            if (
              !original.rows.length ||
              (
                await client.query(
                  "SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1 LIMIT 1",
                  [attempt.id],
                )
              ).rows.length ||
              !(await channexCreationReceiptsResolved(client, target.id, attempt.id))
            )
              return unavailable("creation_reconciliation_required");
          } else {
            let identity;
            if ("kind" in work) {
              if (!attempt.job_attempt_id || !attempt.worker_id)
                return unavailable("creation_reconciliation_required");
              const receipts = (
                await client.query(
                  `SELECT outcome,http_status,has_warnings,identity_evidence FROM pms.channex_offer_create_receipts
                 WHERE attempt_id=$1 AND job_attempt_id=$2 AND worker_id=$3 LIMIT 1001`,
                  [attempt.id, attempt.job_attempt_id, attempt.worker_id],
                )
              ).rows;
              if (!receipts.length || receipts.length > 1000)
                return unavailable("creation_reconciliation_required");
              identity = readChannexCreationReceiptIdentity(receipts[0]);
              if (
                !identity ||
                receipts.some((receipt) => {
                  const other = readChannexCreationReceiptIdentity(receipt);
                  return (
                    !other ||
                    other.externalPropertyId !== identity!.externalPropertyId ||
                    other.externalRoomTypeId !== identity!.externalRoomTypeId ||
                    other.externalRatePlanId !== identity!.externalRatePlanId
                  );
                }) ||
                !(await channexCreationReceiptsResolved(client, target.id, attempt.id))
              )
                return unavailable("creation_reconciliation_required");
            } else identity = work;
            if (
              identity.externalPropertyId !== authority.externalPropertyId ||
              identity.externalRoomTypeId !== mapping.external_room_type_id
            )
              return unavailable("creation_identity_mismatch");
            if (
              attempt.state === "identified" &&
              attempt.external_rate_plan_id !== identity.externalRatePlanId
            )
              return unavailable("creation_identity_conflict");
            if (attempt.state === "unresolved")
              await client.query(
                "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
                [attempt.id, identity.externalRatePlanId],
              );
            identification = {
              attemptId: attempt.id,
              externalRatePlanId: identity.externalRatePlanId,
            };
          }
        }
      }
    }
    // Held source/owner locks protect existing evidence; repeat time-sensitive
    // readiness and authority at the final boundary before returning any prices.
    const finalOwners = await lockOwners(client, lease, proposed, snapshot.sources, "publish");
    if (finalOwners.kind !== "verified") return unavailable("owner_unavailable");
    const finalAuthority = await lockChannexPricingPropertyAuthority(client, leaseInput);
    if (finalAuthority.kind !== "authorized") return finalAuthority;
    const readAt = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    if (performance.now() - started >= 5_000) throw deadlineError();
    await client.query("COMMIT");
    return structuredClone({
      kind: "available" as const,
      readAt: readAt.toISOString(),
      authority: finalAuthority,
      publication: snapshot,
      owners: finalOwners,
      reservation,
      createClaim,
      identification,
      configurationIdentity,
    });
  } catch (error) {
    if (error instanceof PricingStorageError && error.code === "invalid")
      return unavailable("publication_invalid");
    throw error;
  } finally {
    try {
      await connection.query("ROLLBACK");
    } finally {
      connection.release();
    }
  }
}
