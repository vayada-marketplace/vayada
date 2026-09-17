import { readChannexInitialAriHistory } from "./channexInitialAriHistory.js";
import { verifyChannexStagedNightPrices } from "../integrations/channexStagedPriceReadback.js";
import { verifyChannexMinimumStayCapability } from "../integrations/channexMinimumStayCapability.js";
import { verifyChannexAriTaskFinish } from "../integrations/channexAriTaskReadback.js";
import {
  prepareChannexAriReceiptPersistence,
  prepareChannexAriTransportFailurePersistence,
} from "./channexAriReceiptStore.js";
import {
  admitChannexInitialAriDate,
  selectNextChannexInitialAriDate,
} from "./channexInitialAriDate.js";
import { prepareChannexAdultNightPrices } from "../integrations/channexNightlyPrices.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  verifyChannexStagedNightRestrictions,
  verifyChannexNightRestrictions,
} from "../integrations/channexRestrictionReadback.js";
import {
  prepareChannexReceiptPersistence,
  prepareChannexTransportFailurePersistence,
} from "./channexCreationReceiptStore.js";
import {
  verifyChannexOfferRoom,
  verifyChannexOfferConfiguration,
} from "../integrations/channexOfferConfiguration.js";
import {
  channexCreationReceiptsResolved,
  readChannexCreationReceiptIdentity,
} from "./channexCreationReceiptGate.js";
import {
  planChannexOfferConfiguration,
  readChannexCreatedRateIdentity,
} from "../integrations/channexOfferConfiguration.js";
import { performance } from "node:perf_hooks";
import {
  lockChannexPricingJobLease,
  type ChannexPricingJobLeaseInput,
} from "../jobs/pmsChannexPricingJobLease.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockCurrentChannexRoomAvailability } from "./channexRoomAvailabilityCoordinator.js";
import { readCurrentPricingSnapshot, PricingStorageError } from "./replacementPricingSnapshot.js";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { parsePricingConfiguration, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import {
  lockBookingPricingOfferTerms,
  lockBookingPricingTermsSource,
  projectBookingPricingDraftTerms,
  type BookingPricingDraft,
} from "./bookingPricingOfferTerms.js";
import {
  lockFinanceReplacementPricingReadiness,
  type FinanceReplacementPricingReadiness,
} from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsPricingRoomScope, lockPmsPricingRoomCapacity } from "./pmsPricingRoomScope.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import {
  lockReplacementChargeCoverage,
  type ReplacementChargeCoverage,
} from "./replacementChargeCoverage.js";
import type {
  PricingStorageScope,
  PricingStorageSnapshot,
  PricingStorageSources,
} from "./replacementPricingStore.js";

export type ReplacementPricingOfferOwners =
  | {
      kind: "verified";
      terms: readonly ReplacementOfferTerms[];
      finance: Extract<FinanceReplacementPricingReadiness, { kind: "ready" }>;
      charges: ReplacementChargeCoverage;
    }
  | {
      kind: "unavailable";
      reason:
        | "invalid"
        | "denied"
        | "room_unavailable"
        | "room_source_stale"
        | "terms_stale"
        | "terms_source_stale"
        | "finance_unavailable"
        | "finance_source_stale"
        | "charges_stale";
      financeReason?: Extract<
        FinanceReplacementPricingReadiness,
        { kind: "unavailable" }
      >["reason"];
    };

type DraftPricingOwners = ReplacementPricingOfferOwners | { kind: "awaiting_charge_confirmation" };

/** Drafts may await confirmation; a supplied declaration must still match. */
export function lockReplacementPricingDraftOwners(
  client: PoolClient,
  context: RequestContext | null,
  scope: PricingStorageScope,
  proposed: unknown,
  sources: PricingStorageSources,
  draft?: BookingPricingDraft,
): Promise<DraftPricingOwners> {
  return lockOwners(client, context, scope, proposed, sources, "draft", draft);
}

/** Caller must BEGIN/COMMIT the transaction. Rechecks live manage authorization and
 * holds PMS/Booking/Finance locks until its end and verifies the charge declaration.
 * Rechecks room/terms/Finance sources through their owners. Other source keys and
 * currency conversion still require explicit validation before publication. */
export async function lockReplacementPricingOfferOwners(
  client: PoolClient,
  context: RequestContext | null,
  scope: PricingStorageScope,
  proposed: unknown,
  sources: PricingStorageSources,
): Promise<ReplacementPricingOfferOwners> {
  const result = await lockOwners(client, context, scope, proposed, sources, "publish");
  return result.kind === "awaiting_charge_confirmation"
    ? { kind: "unavailable", reason: "charges_stale" }
    : result;
}

async function lockOwners(
  client: PoolClient,
  context: RequestContext | null,
  scope: PricingStorageScope,
  proposed: unknown,
  sources: PricingStorageSources,
  intent: "draft" | "publish",
  draft?: BookingPricingDraft,
): Promise<DraftPricingOwners> {
  if (!(await lockReplacementPricingAuthorization(client, context, scope, "manage")))
    return { kind: "unavailable", reason: "denied" };
  return lockOwnerSources(
    client,
    scope,
    proposed,
    sources,
    intent,
    draft ? { context, scope, draft } : undefined,
  );
}

async function lockOwnerSources(
  client: PoolClient,
  scope: Pick<PricingStorageScope, "propertyId">,
  proposed: unknown,
  sources: PricingStorageSources,
  intent: "draft" | "publish",
  draftProjection?: Readonly<{
    context: RequestContext | null;
    scope: PricingStorageScope;
    draft: BookingPricingDraft;
  }>,
): Promise<DraftPricingOwners> {
  const unavailable = (
    reason: Extract<ReplacementPricingOfferOwners, { kind: "unavailable" }>["reason"],
  ): ReplacementPricingOfferOwners => ({ kind: "unavailable", reason });
  if (
    !pricingObject(proposed) ||
    !pricingKeys(proposed, ["currency", "rooms", "ownerReferences"]) ||
    typeof proposed.currency !== "string" ||
    !Array.isArray(proposed.rooms) ||
    !proposed.rooms.length ||
    !pricingObject(proposed.ownerReferences) ||
    !Object.entries(proposed.ownerReferences).every(
      ([key, value]) =>
        key.length > 0 &&
        key === key.trim() &&
        typeof value === "string" &&
        value.length > 0 &&
        value === value.trim(),
    ) ||
    typeof proposed.ownerReferences.finance !== "string"
  )
    return unavailable("invalid");
  const rooms = Array.from(proposed.rooms, parsePricingConfiguration);
  const revision = rooms[0]?.revision,
    currency = proposed.currency,
    expectedEvidenceId = proposed.ownerReferences.finance;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !revision ||
    revision > 2147483647 ||
    rooms.some(
      (r) =>
        !r ||
        !uuid.test(r.roomTypeId) ||
        r.propertyId !== scope.propertyId.toLowerCase() ||
        r.currency !== currency ||
        r.revision !== revision,
    ) ||
    new Set(rooms.map((r) => r!.roomTypeId.toLowerCase())).size !== rooms.length
  )
    return unavailable("invalid");
  const snapshot: PricingStorageSnapshot = {
    currency,
    rooms: rooms.map((r) => r!),
    ownerReferences: structuredClone(proposed.ownerReferences) as PricingStorageSources,
  };
  const currentSources = structuredClone(sources);
  const roomSource = await lockPmsReplacementPricingRoomSource(client, scope.propertyId);
  const references = [];
  for (const room of rooms) {
    if (!(await lockPmsPricingRoomScope(client, scope.propertyId, room!.roomTypeId)))
      return unavailable("room_unavailable");
    references.push(
      ...room!.offers.map((o) => ({
        roomTypeId: room!.roomTypeId,
        offerId: o.id,
        revision: o.termsRevision,
      })),
    );
  }
  if (!roomSource || currentSources.room !== roomSource) return unavailable("room_source_stale");
  const projection = draftProjection
    ? await projectBookingPricingDraftTerms(
        client,
        draftProjection.context,
        draftProjection.scope,
        draftProjection.draft,
        references,
      )
    : null;
  const terms = draftProjection
    ? projection?.terms
    : await lockBookingPricingOfferTerms(client, scope.propertyId, references);
  if (!terms) return unavailable("terms_stale");
  const termsSource = draftProjection
    ? projection?.source
    : await lockBookingPricingTermsSource(client, scope.propertyId);
  if (!termsSource || currentSources.terms !== termsSource)
    return unavailable("terms_source_stale");
  const financeSource = await lockFinanceReplacementPricingSource(client, scope.propertyId);
  const finance = await lockFinanceReplacementPricingReadiness(client, {
    propertyId: scope.propertyId,
    currency,
    pricingRevision: revision,
    terms,
    expectedEvidenceId,
  });
  if (finance.kind !== "ready")
    return { kind: "unavailable", reason: "finance_unavailable", financeReason: finance.reason };
  if (!financeSource || currentSources.finance !== financeSource)
    return unavailable("finance_source_stale");
  if (intent === "draft" && snapshot.ownerReferences.charges === undefined)
    return { kind: "awaiting_charge_confirmation" };
  const charges = await lockReplacementChargeCoverage(
    client,
    scope.propertyId,
    snapshot.ownerReferences.charges ?? "",
    snapshot,
    currentSources,
  );
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
    ariClaim: _ariClaim,
    ariRequest: _ariRequest,
    stagedAri: _stagedAri,
    nextAriDate: _nextAriDate,
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

/** Commits local initial upload ownership only; no dispatch or activation permission. */
export async function claimPublishedChannexInitialAri(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  date: string,
) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const result = await withSelectedChannexTarget(pool, input, selection, {
    kind: "ari_claim",
    attemptId,
    date,
  });
  if (result.kind !== "available") return result;
  if (!result.ariClaim) throw new Error("Initial ARI claim missing");
  return { kind: "ari_claimed" as const, ...result.ariClaim };
}

type TargetWork =
  | "reserve"
  | "claim"
  | {
      kind: "ari_observe";
      attemptId: string;
      ariAttemptId: string;
      taskRead?: true;
      reconciliation?: { expected: unknown; evidence: unknown };
    }
  | { kind: "ari_claim"; attemptId: string; date: string }
  | {
      kind: "ari_dispatch";
      attemptId: string;
      date: string;
      ariAttemptId: string;
      jobAttemptId: string;
      workerId: string;
    }
  | { kind: "retained"; attemptId: string }
  | {
      kind: "configuration";
      attemptId: string;
      observation?: Awaited<ReturnType<typeof verifyChannexOfferConfiguration>>;
      nextDate?: true;
    }
  | { kind: "activate"; attemptId: string }
  | { kind: "dispatch"; attemptId: string; jobAttemptId: string; workerId: string }
  | ({ attemptId: string } & ReturnType<typeof readChannexCreatedRateIdentity>);

/** Seals every ready target for this property and advances its active pointer. */
export async function activatePublishedChannexOffers(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
) {
  const current = await readPublishedPricingForChannexJob(pool, input);
  if (current.kind !== "available") return current;
  const readState = () =>
    pool.query<{ total: number; active: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER (
         WHERE target.active_version IS NOT NULL
           AND version.binding_generation=connection.binding_generation
           AND intent.proposal->'publicationRevision'=$3::jsonb
           AND NOT EXISTS (SELECT 1 FROM pms.channex_offer_target_intents pending
             WHERE pending.target_id=target.id AND pending.status='pending'))::int AS active
       FROM pms.channex_offer_targets target
       JOIN pms.channel_connections connection ON connection.id=target.connection_id
       LEFT JOIN pms.channex_offer_target_versions version
         ON version.target_id=target.id AND version.version=target.active_version
       LEFT JOIN pms.channex_offer_target_intents intent ON intent.id=version.intent_id
       WHERE target.property_id=$1 AND target.connection_id=$2`,
      [
        current.authority.lease.propertyId,
        current.authority.connectionId,
        JSON.stringify(current.publication.revision),
      ],
    );
  const state = (await readState()).rows[0];
  if (!state?.total) return { kind: "no_targets" as const };
  const candidates = await pool.query<{
    creationAttemptId: string;
    roomTypeId: string;
    offerId: string;
    operationKey: string;
    primaryOccupancy: number;
  }>(
    `SELECT a.id AS "creationAttemptId",t.room_type_id AS "roomTypeId",t.offer_id AS "offerId",
       i.operation_key AS "operationKey",(i.proposal->>'primaryOccupancy')::int AS "primaryOccupancy"
     FROM pms.channex_offer_targets t
     JOIN pms.channex_offer_target_intents i ON i.target_id=t.id AND i.status='pending'
     JOIN pms.channex_offer_create_attempts a ON a.intent_id=i.id AND a.state='identified'
     WHERE t.property_id=$1 AND t.connection_id=$2
     ORDER BY t.room_type_id::text COLLATE "C",t.offer_id`,
    [current.authority.lease.propertyId, current.authority.connectionId],
  );
  if (!candidates.rows.length)
    return state.active === state.total
      ? { kind: "all_targets_active" as const, count: state.total }
      : { kind: "unavailable" as const, reason: "target_activation_pending" };
  if (state.active + candidates.rows.length !== state.total)
    return { kind: "unavailable" as const, reason: "target_activation_pending" };
  for (const candidate of candidates.rows) {
    const result = await withSelectedChannexTarget(pool, input, candidate, {
      kind: "activate",
      attemptId: candidate.creationAttemptId,
    });
    if (result.kind !== "available") return result;
    if (!result.activation) throw new Error("Target activation missing");
  }
  const completed = (await readState()).rows[0];
  return completed?.total === state.total && completed.active === completed.total
    ? { kind: "all_targets_active" as const, count: completed.total }
    : { kind: "unavailable" as const, reason: "target_activation_pending" };
}

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

/** Current pending-target observation only, never a send or activation permit. */
export async function readCurrentChannexNightRestrictions(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  date: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const work = { kind: "configuration" as const, attemptId };
  const before = await withSelectedChannexTarget(pool, lease, selected, work);
  if (before.kind !== "available") return before;
  if (!before.configurationIdentity || !before.reservation)
    throw new Error("Configuration identity missing");
  const room = before.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const observation = await verifyChannexNightRestrictions(
    room,
    {
      propertyId: before.authority.lease.propertyId,
      roomTypeId: selected.roomTypeId,
      offerId: selected.offerId,
      date,
      expectedRevision: before.publication.revision,
      expectedTermsRevisions: Object.fromEntries(
        before.owners.terms
          .filter((terms) => terms.roomTypeId === selected.roomTypeId)
          .map((terms) => [terms.offerId, terms.revision]),
      ),
    },
    {
      externalPropertyId: before.configurationIdentity.externalPropertyId,
      externalRatePlanId: before.configurationIdentity.externalRatePlanId,
    },
    (_method, path) => boundedProviderCall((signal) => get(path, signal)),
  );
  const after = await withSelectedChannexTarget(pool, lease, selected, work);
  if (after.kind !== "available") return after;
  if (
    !isDeepStrictEqual(before.reservation, after.reservation) ||
    !isDeepStrictEqual(before.configurationIdentity, after.configurationIdentity) ||
    !isDeepStrictEqual(before.publication, after.publication)
  )
    return { kind: "unavailable" as const, reason: "restriction_observation_stale" };
  return {
    kind: "restrictions_observed" as const,
    attemptId,
    ...before.reservation,
    observation,
  };
}

/** Observe the immutable upload under current ownership; never release or resend it. */
export async function readCurrentChannexStagedRestrictions(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  ariAttemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![attemptId, ariAttemptId].every((id) => typeof id === "string" && uuid.test(id)))
    return { kind: "unavailable" as const, reason: "invalid_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const work = { kind: "ari_observe" as const, attemptId, ariAttemptId };
  const before = await withSelectedChannexTarget(pool, lease, selected, work);
  if (before.kind !== "available") return before;
  if (!before.stagedAri) throw new Error("Staged ARI missing");
  const observation = await verifyChannexStagedNightRestrictions(
    before.stagedAri.request,
    (_method, path) => boundedProviderCall((signal) => get(path, signal)),
  );
  const after = await withSelectedChannexTarget(pool, lease, selected, work);
  if (after.kind !== "available") return after;
  if (
    !isDeepStrictEqual(before.stagedAri, after.stagedAri) ||
    !isDeepStrictEqual(before.reservation, after.reservation) ||
    !isDeepStrictEqual(before.configurationIdentity, after.configurationIdentity) ||
    !isDeepStrictEqual(before.publication, after.publication)
  )
    return { kind: "unavailable" as const, reason: "staged_restriction_observation_stale" };
  return {
    kind: "staged_restrictions_observed" as const,
    creationAttemptId: attemptId,
    ariAttemptId,
    ...before.reservation,
    observation,
  };
}
/** Observe the immutable upload under current ownership; never release or resend it. */
export async function readCurrentChannexStagedPrices(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  ariAttemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![attemptId, ariAttemptId].every((id) => typeof id === "string" && uuid.test(id)))
    return { kind: "unavailable" as const, reason: "invalid_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const work = { kind: "ari_observe" as const, attemptId, ariAttemptId };
  const before = await withSelectedChannexTarget(pool, lease, selected, work);
  if (before.kind !== "available") return before;
  if (!before.stagedAri || !before.configurationIdentity) throw new Error("Staged ARI missing");
  const room = before.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const observation = await boundedProviderCall((signal) =>
    verifyChannexStagedNightPrices(
      room,
      selected.offerId,
      selected.primaryOccupancy,
      before.configurationIdentity!,
      before.stagedAri!.request,
      (_method, path) => {
        signal.throwIfAborted();
        return get(path, signal);
      },
    ),
  );
  const after = await withSelectedChannexTarget(pool, lease, selected, work);
  if (after.kind !== "available") return after;
  if (
    !isDeepStrictEqual(before.stagedAri, after.stagedAri) ||
    !isDeepStrictEqual(before.reservation, after.reservation) ||
    !isDeepStrictEqual(before.configurationIdentity, after.configurationIdentity) ||
    !isDeepStrictEqual(before.publication, after.publication)
  )
    return { kind: "unavailable" as const, reason: "staged_price_observation_stale" };
  return {
    kind: "staged_prices_observed" as const,
    creationAttemptId: attemptId,
    ariAttemptId,
    ...before.reservation,
    observation,
  };
}
/** Task IDs come only from the retained original receipt; never a completion permit. */
export async function readCurrentChannexAriTaskFinishes(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  ariAttemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![attemptId, ariAttemptId].every((id) => typeof id === "string" && uuid.test(id)))
    return { kind: "unavailable" as const, reason: "invalid_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const work = { kind: "ari_observe" as const, attemptId, ariAttemptId, taskRead: true as const };
  const before = await withSelectedChannexTarget(pool, lease, selected, work);
  if (before.kind !== "available") return before;
  const original = before.stagedAri,
    identity = before.configurationIdentity;
  if (!original?.taskIds || !identity) throw new Error("Original ARI tasks missing");
  const observations = await boundedProviderCall(async (signal) => {
    const result = [];
    for (const taskId of original.taskIds!) {
      signal.throwIfAborted();
      result.push(
        await verifyChannexAriTaskFinish(
          { taskId, externalPropertyId: identity.externalPropertyId, request: original.request },
          (_method, path) => {
            signal.throwIfAborted();
            return get(path, signal);
          },
        ),
      );
    }
    return result;
  });
  const after = await withSelectedChannexTarget(pool, lease, selected, work);
  if (after.kind !== "available") return after;
  if (
    !isDeepStrictEqual(before.stagedAri, after.stagedAri) ||
    !isDeepStrictEqual(before.reservation, after.reservation) ||
    !isDeepStrictEqual(before.configurationIdentity, after.configurationIdentity) ||
    !isDeepStrictEqual(before.publication, after.publication)
  )
    return { kind: "unavailable" as const, reason: "ari_task_observation_stale" };
  return {
    kind: "ari_tasks_observed" as const,
    creationAttemptId: attemptId,
    ariAttemptId,
    ...before.reservation,
    observations,
  };
}
/** Reconcile one closed upload from original provider evidence; never activate or resend. */
export async function reconcileCurrentChannexInitialAri(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  ariAttemptId: string,
  get: (path: string, signal: AbortSignal) => Promise<unknown>,
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![attemptId, ariAttemptId].every((id) => typeof id === "string" && uuid.test(id)))
    return { kind: "unavailable" as const, reason: "invalid_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const work = { kind: "ari_observe" as const, attemptId, ariAttemptId, taskRead: true as const };
  const before = await withSelectedChannexTarget(pool, lease, selected, work);
  if (before.kind !== "available") return before;
  const original = before.stagedAri,
    identity = before.configurationIdentity;
  if (!original?.taskIds || !identity) throw new Error("Original ARI tasks missing");
  const room = before.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const evidence = await boundedProviderCall(async (signal) => {
    const read = (_method: "GET", path: string) => {
      signal.throwIfAborted();
      return get(path, signal);
    };
    const tasks = [];
    for (const taskId of original.taskIds!) {
      signal.throwIfAborted();
      tasks.push(
        await verifyChannexAriTaskFinish(
          { taskId, externalPropertyId: identity.externalPropertyId, request: original.request },
          read,
        ),
      );
    }
    const prices = await verifyChannexStagedNightPrices(
      room,
      selected.offerId,
      selected.primaryOccupancy,
      identity,
      original.request,
      read,
    );
    const restrictions = await verifyChannexStagedNightRestrictions(original.request, read);
    return {
      schemaVersion: 1,
      completionBasis: "finished_task_fifo",
      originalReceiptId: original.receiptId,
      taskCount: tasks.length,
      priceCount: prices.prices.length,
      // Original task IDs and requested values already live in immutable storage.
      // Keep the verification attestation bounded even for 100 tasks/occupancies.
      observationsSha256: createHash("sha256")
        .update(JSON.stringify({ tasks, prices, restrictions }))
        .digest("hex"),
      restrictions,
    };
  });
  const after = await withSelectedChannexTarget(pool, lease, selected, {
    ...work,
    reconciliation: {
      expected: {
        stagedAri: before.stagedAri,
        reservation: before.reservation,
        configurationIdentity: before.configurationIdentity,
        publication: before.publication,
      },
      evidence,
    },
  });
  if (after.kind !== "available") return after;
  return {
    kind: "ari_reconciled" as const,
    creationAttemptId: attemptId,
    ariAttemptId,
    ...after.reservation,
  };
}
/** Select from current verified coverage, then acquire a fresh one-use dispatch. */
export async function prepareNextChannexInitialAriDispatch(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
) {
  const lease = { ...input },
    selected = { ...selection };
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const next = await withSelectedChannexTarget(pool, lease, selected, {
    kind: "configuration",
    attemptId,
    nextDate: true,
  });
  if (next.kind !== "available") return next;
  if (next.nextAriDate === null) return { kind: "initial_dates_reconciled" as const };
  if (!next.nextAriDate) throw new Error("Initial ARI date missing");
  return prepareChannexInitialAriDispatch(pool, lease, selected, attemptId, next.nextAriDate);
}
/** A fresh claim grants one closed upload; recovery cannot recreate this closure. */
export async function prepareChannexInitialAriDispatch(
  pool: Pool,
  input: ChannexPricingJobLeaseInput,
  selection: TargetSelection,
  attemptId: string,
  date: string,
) {
  if (
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return { kind: "unavailable" as const, reason: "invalid_creation_attempt" };
  const lease = { ...input },
    selected = { ...selection };
  const claimed = await withSelectedChannexTarget(pool, lease, selected, {
    kind: "ari_claim",
    attemptId,
    date,
  });
  if (claimed.kind !== "available") return claimed;
  const claim = claimed.ariClaim,
    request = claimed.ariRequest,
    identity = claimed.configurationIdentity;
  if (!claim || !request || !identity) throw new Error("Initial ARI claim missing");
  const room = claimed.publication.rooms.find((r) => r.roomTypeId === selected.roomTypeId)!;
  const work = {
    kind: "ari_dispatch" as const,
    attemptId,
    date,
    ariAttemptId: claim.attemptId,
    jobAttemptId: claim.jobAttemptId,
    workerId: claim.workerId,
  };
  let used = false;
  return {
    kind: "prepared" as const,
    async dispatch(ports: {
      get(path: string, signal: AbortSignal): Promise<unknown>;
      post(payload: NonNullable<typeof request>, signal: AbortSignal): Promise<Response>;
    }) {
      if (used) return { kind: "unavailable" as const, reason: "dispatch_already_used" };
      used = true;
      const before = await withSelectedChannexTarget(pool, lease, selected, work);
      if (before.kind !== "available")
        return (await releaseChannexPrePostClaim(pool, "ari", claim))
          ? before
          : { kind: "unavailable" as const, reason: "ari_reconciliation_required" };
      const get = (_method: "GET", path: string) =>
        boundedProviderCall((signal) => ports.get(path, signal));
      try {
        await verifyChannexMinimumStayCapability(identity.externalPropertyId, get);
      } catch {
        return (await releaseChannexPrePostClaim(pool, "ari", claim))
          ? {
              kind: "unavailable" as const,
              reason: "ari_restriction_capability_unavailable",
            }
          : { kind: "unavailable" as const, reason: "ari_reconciliation_required" };
      }
      try {
        await verifyChannexOfferRoom(room, identity, get);
        await verifyChannexOfferConfiguration(
          room,
          selected.offerId,
          selected.primaryOccupancy,
          identity,
          get,
        );
      } catch {
        return (await releaseChannexPrePostClaim(pool, "ari", claim))
          ? { kind: "unavailable" as const, reason: "ari_preflight_unavailable" }
          : { kind: "unavailable" as const, reason: "ari_reconciliation_required" };
      }
      const after = await withSelectedChannexTarget(pool, lease, selected, work);
      if (after.kind !== "available")
        return (await releaseChannexPrePostClaim(pool, "ari", claim))
          ? after
          : { kind: "unavailable" as const, reason: "ari_reconciliation_required" };
      let response: Response | null = null;
      try {
        response = await boundedProviderCall((signal) =>
          ports.post(structuredClone(request), signal),
        );
      } catch {
        /* A timed-out or thrown POST remains an unresolved provider mutation. */
      }
      const correlation = {
        receiptId: randomUUID(),
        attemptId: claim.attemptId,
        jobAttemptId: claim.jobAttemptId,
        workerId: claim.workerId,
        propertyId: claimed.authority.lease.propertyId,
        connectionId: claimed.authority.connectionId,
      };
      const persist = await (response === null
        ? prepareChannexAriTransportFailurePersistence(pool, correlation)
        : prepareChannexAriReceiptPersistence(pool, correlation, response));
      try {
        await persist();
        return { kind: "retained" as const, attemptId: claim.attemptId };
      } catch {
        return { kind: "receipt_pending" as const, persist, attemptId: claim.attemptId };
      }
    },
  };
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
      if (before.kind !== "available")
        return (await releaseChannexPrePostClaim(pool, "creation", claim))
          ? before
          : { kind: "unavailable" as const, reason: "creation_reconciliation_required" };
      let response: Response | null = null;
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
        if (current.kind !== "available")
          return (await releaseChannexPrePostClaim(pool, "creation", claim))
            ? current
            : { kind: "unavailable" as const, reason: "creation_reconciliation_required" };
      } catch {
        return (await releaseChannexPrePostClaim(pool, "creation", claim))
          ? { kind: "unavailable" as const, reason: "creation_preflight_unavailable" }
          : { kind: "unavailable" as const, reason: "creation_reconciliation_required" };
      }
      try {
        response = await boundedProviderCall((signal) =>
          ports.create(structuredClone(claim.request), signal),
        );
      } catch {
        // Once create was invoked, failure is ambiguous even without HTTP headers.
      }
      const correlation = {
        receiptId: randomUUID(),
        attemptId: claim.attemptId,
        jobAttemptId: claim.jobAttemptId,
        workerId: claim.workerId,
        propertyId: claimed.authority.lease.propertyId,
        connectionId: claimed.authority.connectionId,
      };
      const persist = await (response === null
        ? prepareChannexTransportFailurePersistence(pool, correlation)
        : prepareChannexReceiptPersistence(pool, correlation, response));
      try {
        await persist();
        if (response === null)
          return { kind: "unavailable" as const, reason: "creation_reconciliation_required" };
        return { kind: "retained" as const, attemptId: claim.attemptId };
      } catch {
        return { kind: "receipt_pending" as const, persist };
      }
    },
  };
}

type ChannexPrePostClaim = Readonly<{
  attemptId: string;
  jobAttemptId: string;
  workerId: string;
}>;

/** Releases only a claim that provably has no provider observation. */
async function releaseChannexPrePostClaim(
  pool: Pool,
  kind: "creation" | "ari",
  claim: ChannexPrePostClaim,
): Promise<boolean> {
  const client = await pool.connect();
  let committed = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const attemptTable =
      kind === "creation" ? "pms.channex_offer_create_attempts" : "pms.channex_offer_ari_attempts";
    const receiptTable =
      kind === "creation" ? "pms.channex_offer_create_receipts" : "pms.channex_offer_ari_receipts";
    const target = await client.query(
      `SELECT t.id FROM pms.channex_offer_targets t
       JOIN ${attemptTable} a ON a.target_id=t.id
       WHERE a.id=$1 AND a.job_attempt_id=$2 AND a.worker_id=$3 AND a.state='unresolved'
       FOR UPDATE OF t NOWAIT`,
      [claim.attemptId, claim.jobAttemptId, claim.workerId],
    );
    if (!target.rowCount) {
      await client.query("ROLLBACK");
      committed = true;
      return false;
    }
    const released = await client.query(
      `UPDATE ${attemptTable} a SET state='released'
       WHERE a.id=$1 AND a.job_attempt_id=$2 AND a.worker_id=$3 AND a.state='unresolved'
         AND NOT EXISTS (SELECT 1 FROM ${receiptTable} r WHERE r.attempt_id=a.id)
       RETURNING a.id`,
      [claim.attemptId, claim.jobAttemptId, claim.workerId],
    );
    await client.query("COMMIT");
    committed = true;
    return released.rowCount === 1;
  } catch {
    return false;
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
    const owners = await lockOwnerSources(client, lease, proposed, snapshot.sources, "publish");
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
    let stagedAri:
      | {
          attemptId: string;
          request: unknown;
          history: unknown;
          taskIds?: string[];
          receiptId?: string;
        }
      | undefined;
    let ariRequest: { method: "POST"; path: "/api/v1/restrictions"; body: unknown } | undefined;
    let ariClaim:
      | {
          attemptId: string;
          targetId: string;
          intentId: string;
          version: string;
          jobAttemptId: string;
          workerId: string;
        }
      | undefined;
    let nextAriDate: string | null | undefined;
    let identification: { attemptId: string; externalRatePlanId: string } | undefined;
    let configurationIdentity: ReturnType<typeof readChannexCreatedRateIdentity> | undefined;
    let activation: { targetId: string; version: string } | undefined;
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
      await client.query(
        `INSERT INTO pms.channex_offer_targets
        (property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(connection_id,room_type_id,offer_id) DO NOTHING`,
        [lease.propertyId, authority.connectionId, room.roomTypeId, selection.offerId],
      );
      const target = (
        await client.query<{ id: string; active_version: string | null }>(
          `SELECT id,active_version FROM pms.channex_offer_targets
        WHERE connection_id=$1 AND room_type_id=$2 AND offer_id=$3 FOR UPDATE NOWAIT`,
          [authority.connectionId, room.roomTypeId, selection.offerId],
        )
      ).rows[0];
      const proposal = JSON.stringify({
        publicationRevision: snapshot.revision,
        sources: snapshot.sources,
        ownerReferences: snapshot.ownerReferences,
        currency: snapshot.currency,
        bindingGeneration: binding.binding_generation,
        externalPropertyId: authority.externalPropertyId,
        ...(target.active_version === null ? {} : { expectedActiveVersion: target.active_version }),
        room,
        offerId: selection.offerId,
        primaryOccupancy: selection.primaryOccupancy,
        providerConfiguration: plan.configuration,
      });
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
           WHERE target_id=$1 AND ((intent_id=$2 AND state<>'released') OR state='unresolved')`,
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
          if (
            "kind" in work &&
            (work.kind === "configuration" ||
              work.kind === "activate" ||
              work.kind === "ari_claim" ||
              work.kind === "ari_dispatch" ||
              work.kind === "ari_observe")
          ) {
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
            if (work.kind === "ari_observe") {
              const evidence = JSON.stringify({
                schemaVersion: 1,
                attemptId: attempt.id,
                intentId: intent.id,
                version: intent.version,
                bindingGeneration: binding.binding_generation,
                observation: {
                  ...configurationIdentity,
                  mealType: plan.configuration.meal_type,
                  configuration: plan.configuration,
                },
              });
              if (
                !(
                  await client.query(
                    "SELECT 1 FROM pms.channex_offer_target_intents WHERE id=$1 AND result_evidence->'configuration'=$2::jsonb",
                    [intent.id, evidence],
                  )
                ).rowCount
              )
                return unavailable("configuration_evidence_unavailable");
              const stored = (
                await client.query(
                  `SELECT id,request_body FROM pms.channex_offer_ari_attempts
                 WHERE id=$1 AND creation_attempt_id=$2 AND state='unresolved'
                   AND request_body#>>'{values,0,property_id}'=external_property_id
                   AND request_body#>>'{values,0,rate_plan_id}'=external_rate_plan_id
                   AND request_body#>>'{values,0,date}'=to_char(service_date,'YYYY-MM-DD')
                 FOR SHARE NOWAIT`,
                  [work.ariAttemptId, attempt.id],
                )
              ).rows[0];
              if (!stored) return unavailable("ari_attempt_unavailable");
              const history = (
                await client.query(
                  `SELECT a.id,a.state,COALESCE((SELECT jsonb_agg(r.id ORDER BY r.id)
                   FROM pms.channex_offer_ari_receipts r WHERE r.attempt_id=a.id),'[]'::jsonb) AS receipts
                 FROM pms.channex_offer_ari_attempts a
                 WHERE a.external_property_id=$1 AND a.external_rate_plan_id=$2 ORDER BY a.id`,
                  [
                    configurationIdentity.externalPropertyId,
                    configurationIdentity.externalRatePlanId,
                  ],
                )
              ).rows;
              stagedAri = { attemptId: stored.id, request: stored.request_body, history };
              if (work.taskRead) {
                const receipts = (
                  await client.query(
                    "SELECT id,outcome,http_status,has_warnings,task_ids FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1 ORDER BY id",
                    [stored.id],
                  )
                ).rows;
                const receipt = receipts[0];
                const tasks: unknown = receipt?.task_ids;
                const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
                if (
                  receipts.length !== 1 ||
                  receipt.outcome !== "complete_json" ||
                  receipt.http_status !== 200 ||
                  receipt.has_warnings !== false ||
                  !Array.isArray(tasks) ||
                  tasks.length === 0 ||
                  tasks.length > 100 ||
                  tasks.some((id) => typeof id !== "string" || !uuid.test(id)) ||
                  new Set(tasks).size !== tasks.length
                )
                  return unavailable("ari_receipt_history_unavailable");
                stagedAri.taskIds = tasks;
                stagedAri.receiptId = receipt.id;
              }
            }
            if (work.kind === "ari_claim" || work.kind === "ari_dispatch") {
              const location = (
                await client.query(
                  "SELECT timezone FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE NOWAIT",
                  [lease.propertyId],
                )
              ).rows[0];
              const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]
                .now as Date;
              const dateAdmission = admitChannexInitialAriDate(work.date, location?.timezone, now);
              if (dateAdmission.kind !== "admitted") return dateAdmission;
              const evidence = JSON.stringify({
                schemaVersion: 1,
                attemptId: attempt.id,
                intentId: intent.id,
                version: intent.version,
                bindingGeneration: binding.binding_generation,
                observation: {
                  ...configurationIdentity,
                  mealType: plan.configuration.meal_type,
                  configuration: plan.configuration,
                },
              });
              if (
                !(
                  await client.query(
                    "SELECT 1 FROM pms.channex_offer_target_intents WHERE id=$1 AND result_evidence->'configuration'=$2::jsonb",
                    [intent.id, evidence],
                  )
                ).rowCount
              )
                return unavailable("configuration_evidence_unavailable");
              const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
              if (
                ![
                  configurationIdentity.externalPropertyId,
                  configurationIdentity.externalRatePlanId,
                ].every((id) => uuid.test(id))
              )
                return unavailable("restriction_scope_unavailable");
              const prepared = prepareChannexAdultNightPrices(room, {
                propertyId: lease.propertyId,
                roomTypeId: room.roomTypeId,
                offerId: selection.offerId,
                date: work.date,
                expectedRevision: snapshot.revision,
                expectedTermsRevisions: Object.fromEntries(
                  owners.terms
                    .filter((t) => t.roomTypeId === room.roomTypeId)
                    .map((t) => [t.offerId, t.revision]),
                ),
              });
              if (prepared.kind !== "prepared") return prepared;
              // Channex requires strictly positive rates; never export a partial occupancy set.
              if (prepared.candidates.some((c) => BigInt(c.projection.night.totalMinor) <= 0n))
                return unavailable("provider_rate_unavailable");
              const request = {
                values: [
                  {
                    property_id: configurationIdentity.externalPropertyId,
                    rate_plan_id: configurationIdentity.externalRatePlanId,
                    date: prepared.candidates[0].projection.night.date,
                    rates: prepared.candidates.map(({ occupancy, rate }) => ({ occupancy, rate })),
                    ...prepared.candidates[0].restrictionCandidate,
                    // Pending rates must remain closed regardless of the desired sell state.
                    // Opening sales is a separate activation operation, never initial ARI.
                    stop_sell: true,
                  },
                ],
              };
              // Older dates must have service-verified completion, not a raw storage release.
              const prior = await readChannexInitialAriHistory(
                client,
                configurationIdentity,
                attempt.id,
                work.kind === "ari_dispatch" ? work.ariAttemptId : null,
              );
              if (prior.rows.some((row) => row.verified !== true))
                return unavailable("ari_reconciliation_required");
              if (prior.rows.some((row) => row.date === work.date))
                return unavailable("ari_date_already_reconciled");
              if (work.kind === "ari_dispatch") {
                const permitted = await client.query(
                  `SELECT a.id FROM pms.channex_offer_ari_attempts a
                   JOIN platform.job_attempts j ON j.id=a.job_attempt_id
                   WHERE a.id=$1 AND a.creation_attempt_id=$2 AND a.job_attempt_id=$3
                     AND a.worker_id=$4 AND j.job_id=$5 AND j.attempt_number=$6
                     AND a.state='unresolved' AND a.service_date=$7 AND a.request_body=$8::jsonb
                     AND NOT EXISTS (SELECT 1 FROM pms.channex_offer_ari_receipts r WHERE r.attempt_id=a.id)
                   FOR UPDATE OF a NOWAIT`,
                  [
                    work.ariAttemptId,
                    attempt.id,
                    work.jobAttemptId,
                    work.workerId,
                    lease.jobId,
                    lease.attemptNumber,
                    work.date,
                    JSON.stringify(request),
                  ],
                );
                if (!permitted.rowCount || work.workerId !== lease.workerId)
                  return unavailable("ari_dispatch_unavailable");
              } else {
                const created = (
                  await client.query(
                    `INSERT INTO pms.channex_offer_ari_attempts
                             (creation_attempt_id,job_attempt_id,worker_id,service_date,request_body)
                             SELECT $1,a.id,a.worker_id,$2,$3::jsonb FROM platform.job_attempts a
                             WHERE a.job_id=$4 AND a.attempt_number=$5 AND a.worker_id=$6
                             ON CONFLICT (external_property_id,external_rate_plan_id) WHERE state='unresolved'
                             DO NOTHING RETURNING id,job_attempt_id,worker_id`,
                    [
                      attempt.id,
                      work.date,
                      JSON.stringify(request),
                      lease.jobId,
                      lease.attemptNumber,
                      lease.workerId,
                    ],
                  )
                ).rows[0];
                if (!created) return unavailable("ari_reconciliation_required");
                ariClaim = {
                  ...reservation,
                  attemptId: created.id,
                  jobAttemptId: created.job_attempt_id,
                  workerId: created.worker_id,
                };
              }
              ariRequest = { method: "POST", path: "/api/v1/restrictions", body: request };
            }

            if (work.kind === "configuration" && work.nextDate) {
              const expected = {
                schemaVersion: 1,
                attemptId: attempt.id,
                intentId: intent.id,
                version: intent.version,
                bindingGeneration: binding.binding_generation,
                observation: {
                  ...configurationIdentity,
                  mealType: plan.configuration.meal_type,
                  configuration: plan.configuration,
                },
              };
              if (
                !(
                  await client.query(
                    "SELECT 1 FROM pms.channex_offer_target_intents WHERE id=$1 AND result_evidence->'configuration'=$2::jsonb",
                    [intent.id, JSON.stringify(expected)],
                  )
                ).rowCount
              )
                return unavailable("configuration_evidence_unavailable");
              const prior = await readChannexInitialAriHistory(
                client,
                configurationIdentity,
                attempt.id,
              );
              if (prior.rows.some((row) => row.verified !== true))
                return unavailable("ari_reconciliation_required");
              const location = (
                await client.query(
                  "SELECT timezone FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE NOWAIT",
                  [lease.propertyId],
                )
              ).rows[0];
              const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]
                .now as Date;
              const selectedDate = selectNextChannexInitialAriDate(
                location?.timezone,
                now,
                prior.rows.map((row) => row.date),
              );
              if (selectedDate.kind !== "selected") return selectedDate;
              nextAriDate = selectedDate.date;
            }
            if (work.kind === "configuration" && work.observation) {
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
            if (work.kind === "activate") {
              const configurationEvidence = {
                schemaVersion: 1,
                attemptId: attempt.id,
                intentId: intent.id,
                version: intent.version,
                bindingGeneration: binding.binding_generation,
                observation: {
                  ...configurationIdentity,
                  mealType: plan.configuration.meal_type,
                  configuration: plan.configuration,
                },
              };
              if (
                !(
                  await client.query(
                    "SELECT 1 FROM pms.channex_offer_target_intents WHERE id=$1 AND result_evidence->'configuration'=$2::jsonb",
                    [intent.id, JSON.stringify(configurationEvidence)],
                  )
                ).rowCount
              )
                return unavailable("configuration_evidence_unavailable");
              const initialAri = await readChannexInitialAriHistory(
                client,
                configurationIdentity,
                attempt.id,
              );
              if (!initialAri.rows.length || initialAri.rows.some((row) => row.verified !== true))
                return unavailable("ari_reconciliation_required");
              const location = (
                await client.query(
                  "SELECT timezone FROM hotel_catalog.property_locations WHERE property_id=$1 FOR SHARE NOWAIT",
                  [lease.propertyId],
                )
              ).rows[0];
              const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0]
                .now as Date;
              const horizon = selectNextChannexInitialAriDate(
                location?.timezone,
                now,
                initialAri.rows.map((row) => row.date),
              );
              if (horizon.kind !== "selected" || horizon.date !== null)
                return unavailable("initial_ari_incomplete");
              const availability = await lockCurrentChannexRoomAvailability(client, {
                propertyId: lease.propertyId,
                connectionId: authority.connectionId,
                externalPropertyId: authority.externalPropertyId,
                bindingGeneration: binding.binding_generation,
              });
              if (availability.kind !== "current") return availability;
              const readbackEvidence = {
                schemaVersion: 1,
                configuration: configurationEvidence,
                initialAri: {
                  from: initialAri.rows[0]!.date,
                  through: initialAri.rows.at(-1)!.date,
                  dayCount: initialAri.rows.length,
                  completionBasis: "verified_closed_readback",
                },
                availability,
              };
              const sealed = await client.query(
                `INSERT INTO pms.channex_offer_target_versions
                   (target_id,version,intent_id,binding_generation,external_property_id,
                    external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
                 RETURNING version`,
                [
                  target.id,
                  intent.version,
                  intent.id,
                  binding.binding_generation,
                  configurationIdentity.externalPropertyId,
                  configurationIdentity.externalRoomTypeId,
                  configurationIdentity.externalRatePlanId,
                  JSON.stringify(plan.configuration),
                  JSON.stringify(readbackEvidence),
                ],
              );
              const activated = await client.query(
                `UPDATE pms.channex_offer_targets SET active_version=$2
                 WHERE id=$1 AND active_version IS NOT DISTINCT FROM $3::bigint
                 RETURNING id`,
                [target.id, intent.version, target.active_version],
              );
              if (!sealed.rowCount || !activated.rowCount)
                return unavailable("activation_compare_and_swap_failed");
              activation = { targetId: target.id, version: String(intent.version) };
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
    if (
      typeof work === "object" &&
      "kind" in work &&
      work.kind === "ari_observe" &&
      work.reconciliation
    ) {
      if (
        !isDeepStrictEqual(work.reconciliation.expected, {
          stagedAri,
          reservation,
          configurationIdentity,
          publication: snapshot,
        })
      )
        return unavailable("ari_reconciliation_stale");
      const saved = await client.query(
        `UPDATE pms.channex_offer_ari_attempts
         SET state='reconciled',reconciliation_evidence=$2::jsonb
         WHERE id=$1 AND state='unresolved' RETURNING id`,
        [work.ariAttemptId, JSON.stringify(work.reconciliation.evidence)],
      );
      if (!saved.rowCount) return unavailable("ari_attempt_unavailable");
    }
    // Held source/owner locks protect existing evidence; repeat time-sensitive
    // readiness and authority at the final boundary before returning any prices.
    const finalOwners = await lockOwnerSources(
      client,
      lease,
      proposed,
      snapshot.sources,
      "publish",
    );
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
      ariClaim,
      ariRequest,
      stagedAri,
      nextAriDate,
      activation,
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
