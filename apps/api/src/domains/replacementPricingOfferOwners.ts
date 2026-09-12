import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { parsePricingConfiguration, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { PoolClient } from "pg";
import { lockBookingPricingOfferTerms, lockBookingPricingTermsSource, projectBookingPricingDraftTerms, type BookingPricingDraft } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness, type FinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
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
export function lockReplacementPricingDraftOwners(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, proposed: unknown, sources: PricingStorageSources, draft?: BookingPricingDraft): Promise<DraftPricingOwners> {
  return lockOwners(client, context, scope, proposed, sources, "draft", draft);
}

/** Caller must BEGIN/COMMIT the transaction. Rechecks live manage authorization and
 * holds PMS/Booking/Finance locks until its end and verifies the charge declaration.
 * Rechecks room/terms/Finance sources through their owners. Other source keys and
 * currency conversion still require explicit validation before publication. */
export async function lockReplacementPricingOfferOwners(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, proposed: unknown, sources: PricingStorageSources): Promise<ReplacementPricingOfferOwners> {
  const result = await lockOwners(client, context, scope, proposed, sources, "publish");
  return result.kind === "awaiting_charge_confirmation" ? { kind: "unavailable", reason: "charges_stale" } : result;
}

async function lockOwners(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, proposed: unknown, sources: PricingStorageSources, intent: "draft" | "publish", draft?: BookingPricingDraft): Promise<DraftPricingOwners> {
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
  if (!await lockReplacementPricingAuthorization(client, context, scope, "manage")) return unavailable("denied");
  const roomSource = await lockPmsReplacementPricingRoomSource(client, scope.propertyId);
  const references = [];
  for (const room of rooms) {
    if (!await lockPmsPricingRoomScope(client, scope.propertyId, room!.roomTypeId)) return unavailable("room_unavailable");
    references.push(...room!.offers.map((o) => ({ roomTypeId: room!.roomTypeId, offerId: o.id, revision: o.termsRevision })));
  }
  if (!roomSource || currentSources.room !== roomSource) return unavailable("room_source_stale");
  const projection = draft ? await projectBookingPricingDraftTerms(client, context, scope, draft, references) : null;
  const terms = draft ? projection?.terms : await lockBookingPricingOfferTerms(client, scope.propertyId, references);
  if (!terms) return unavailable("terms_stale");
  const termsSource = draft ? projection?.source : await lockBookingPricingTermsSource(client, scope.propertyId);
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
