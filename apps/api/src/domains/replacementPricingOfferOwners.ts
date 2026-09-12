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
type TargetSelection = Readonly<{ roomTypeId: string; offerId: string; operationKey: string }>;

export async function readPublishedPricingForChannexJob(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
) {
  const result = await withPublishedChannexPricing(pool, input);
  if (result.kind !== "available") return result;
  const { reservation: _reservation, ...evidence } = result;
  return evidence;
}

/** Reserves local work only; neither a provider configuration nor activation permission. */
export async function reservePublishedChannexOfferTarget(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
) {
  if (
    !selection ||
    ![selection.roomTypeId, selection.offerId, selection.operationKey].every(
      (value) => typeof value === "string" && value.length > 0 && value === value.trim(),
    )
  )
    return { kind: "unavailable" as const, reason: "invalid_selection" };
  const result = await withPublishedChannexPricing(pool, input, { ...selection });
  if (result.kind !== "available") return result;
  if (!result.reservation) throw new Error("Target reservation missing");
  return { kind: "reserved" as const, ...result.reservation };
}

async function withPublishedChannexPricing(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection?: TargetSelection,
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
    if (selection) {
      const room = snapshot.rooms.find((room) => room.roomTypeId === selection.roomTypeId);
      if (!room || !room.offers.some((offer) => offer.id === selection.offerId))
        return unavailable("selection_unavailable");
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
