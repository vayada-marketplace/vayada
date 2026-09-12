"use client";

import { parsePricingConfiguration, pricingInteger, pricingKeys, pricingObject, type PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { parseBookingPricingOfferTerms, type ReplacementOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { ApiErrorResponse } from "./client";
import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

type Http = Pick<typeof pmsOperationsClient, "get" | "put" | "post">;
export type PricingSources = { room: string; terms: string; finance: string };
export type PricingSnapshot = { currency: string; rooms: readonly PricingConfiguration[]; ownerReferences: { finance: string; charges?: string } };
export type PricingDraft = { draftId: string; revision: number; baseRevision: number; sources: PricingSources; snapshot: PricingSnapshot; stale: boolean };
export type PricingChargeReview = PricingDraft & { fingerprint: string; declaration: "all_mandatory_charges_included" };
export class PricingResponseError extends Error { constructor() { super("Pricing data could not be verified. Reload before continuing."); } }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => pricingObject(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const bad = (): never => { throw new PricingResponseError(); };
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => pricingObject(v) && pricingKeys(v, keys);
const rev = (v: unknown, min = 0): v is number => pricingInteger(v, min) && v <= 2147483647;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const evidence = (v: unknown, prefix: string) => typeof v === "string" && v.startsWith(prefix) && hash(v.slice(prefix.length));
function sources(value: unknown): PricingSources {
  if (!exact(value, ["room", "terms", "finance"]) || !evidence(value.room, "pms.pricing.rooms.v2:") ||
      !evidence(value.terms, "booking.pricing.terms.v2:") || !evidence(value.finance, "finance.pricing.source.v2:")) return bad();
  return { room: value.room as string, terms: value.terms as string, finance: value.finance as string };
}
function snapshot(value: unknown, propertyId: string, revision?: number): PricingSnapshot {
  if (!exact(value, ["currency", "rooms", "ownerReferences"]) || typeof value.currency !== "string" || !Array.isArray(value.rooms) ||
      !value.rooms.length || !pricingObject(value.ownerReferences) || !evidence(value.ownerReferences.finance, "finance.pricing.v2:") ||
      Object.keys(value.ownerReferences).some((key) => !["finance", "charges"].includes(key)) ||
      (Object.hasOwn(value.ownerReferences, "charges") && !uuid(value.ownerReferences.charges))) return bad();
  const rooms = value.rooms.map(parsePricingConfiguration), expected = revision ?? rooms[0]?.revision;
  if (!rev(expected, 1) || rooms.some((room) => !room || !uuid(room.roomTypeId) || room.propertyId !== propertyId || room.currency !== value.currency || room.revision !== expected) ||
      new Set(rooms.map((room) => room!.roomTypeId.toLowerCase())).size !== rooms.length) return bad();
  return structuredClone({ currency: value.currency, rooms: rooms as PricingConfiguration[], ownerReferences: {
    finance: value.ownerReferences.finance as string,
    ...(value.ownerReferences.charges ? { charges: value.ownerReferences.charges as string } : {}),
  } });
}

/** Bind the selected canonical property once; never switch scope during a retry. */
export function createReplacementPricingClient(propertyId: string, http: Http = pmsOperationsClient) {
  if (!uuid(propertyId)) return bad();
  propertyId = propertyId.toLowerCase();
  const base = `/api/pms/properties/${propertyId}/pricing-v2`;
  const options = (requestId?: string): RequestInit => {
    const headers = { ...pmsOperationsRequestOptions.headers as Record<string, string> };
    if (requestId) headers["Idempotency-Key"] = requestId;
    return { ...pmsOperationsRequestOptions, headers, cache: "no-store" };
  };
  const path = (id: string) => uuid(id) ? `${base}/drafts/${id.toLowerCase()}` : bad();
  function draft(value: unknown, id: string): PricingDraft {
    if (!uuid(id) || !exact(value, ["snapshot", "revision", "baseRevision", "sources", "stale"]) || !rev(value.revision, 1) || !rev(value.baseRevision) ||
        value.baseRevision === 2147483647 || typeof value.stale !== "boolean") return bad();
    return { draftId: id.toLowerCase(), revision: value.revision, baseRevision: value.baseRevision, stale: value.stale,
      snapshot: snapshot(value.snapshot, propertyId, value.baseRevision + 1), sources: sources(value.sources) };
  }
  function review(value: unknown, id: string): PricingChargeReview {
    if (!uuid(id) || !exact(value, ["draftId", "snapshot", "revision", "baseRevision", "sources", "stale", "fingerprint", "declaration"]) ||
        value.draftId !== id.toLowerCase() || !hash(value.fingerprint) || value.declaration !== "all_mandatory_charges_included" || value.stale !== false) return bad();
    const stored = { snapshot: value.snapshot, revision: value.revision, baseRevision: value.baseRevision, sources: value.sources, stale: value.stale };
    return { ...draft(stored, id), fingerprint: value.fingerprint, declaration: value.declaration };
  }
  const missing = Symbol("missing");
  async function optionalRead(url: string) {
    try { return await http.get<unknown>(url, options()); }
    catch (error) { if (error instanceof ApiErrorResponse && error.status === 404 && error.data.code === "not_found") return missing; throw error; }
  }
  return {
    async readTerms(roomTypeId: string, offerId: string, revision: string): Promise<ReplacementOfferTerms | null> {
      if (!uuid(roomTypeId) || !uuid(revision) || !offerId || offerId !== offerId.trim() || offerId.length > 200) return bad();
      const value = await optionalRead(`${base}/rooms/${roomTypeId.toLowerCase()}/offers/${encodeURIComponent(offerId)}/terms`);
      if (value === missing) return null;
      const parsed = parseBookingPricingOfferTerms(value);
      if (!parsed || parsed.roomTypeId !== roomTypeId.toLowerCase() || parsed.offerId !== offerId) return bad();
      if (parsed.revision !== revision.toLowerCase()) throw new ApiErrorResponse(409, { code: "stale", detail: "These terms changed. Reload pricing to review the current rate." });
      return parsed;
    },
    async read() {
      const value = await optionalRead(base);
      if (value === missing) return null;
      if (!exact(value, ["currency", "rooms", "ownerReferences", "revision", "sources", "stale"]) || !rev(value.revision, 1) || typeof value.stale !== "boolean") return bad();
      return { ...snapshot({ currency: value.currency, rooms: value.rooms, ownerReferences: value.ownerReferences }, propertyId, value.revision),
        revision: value.revision, sources: sources(value.sources), stale: value.stale };
    },
    async prepare(input: Pick<PricingSnapshot, "currency" | "rooms">) {
      const sent = structuredClone(input), value = await http.post<unknown>(`${base}/prepare`, sent, options());
      if (!exact(value, ["sources", "snapshot"])) return bad();
      const prepared = snapshot(value.snapshot, propertyId);
      if (prepared.ownerReferences.charges || canonical({ currency: prepared.currency, rooms: prepared.rooms }) !== canonical(sent)) return bad();
      return { sources: sources(value.sources), snapshot: prepared };
    },
    async readDraft(id: string) { const value = await optionalRead(path(id)); return value === missing ? null : draft(value, id); },
    async reviewCharges(id: string) { const value = await optionalRead(`${path(id)}/charge-review`); return value === missing ? null : review(value, id); },
    async saveDraft(input: Omit<PricingDraft, "revision" | "stale"> & { expectedDraftRevision: number }) {
      if (!rev(input.expectedDraftRevision) || input.expectedDraftRevision === 2147483647 || !rev(input.baseRevision) || input.baseRevision === 2147483647) return bad();
      const body = { expectedDraftRevision: input.expectedDraftRevision, baseRevision: input.baseRevision,
        sources: sources(input.sources), snapshot: snapshot(input.snapshot, propertyId, input.baseRevision + 1) };
      const value = await http.put<unknown>(path(input.draftId), body, options());
      if (!exact(value, ["revision"]) || value.revision !== body.expectedDraftRevision + 1) return bad();
      return value.revision as number;
    },
    confirmationAction(input: PricingChargeReview) {
      const reviewed = review(input, input.draftId), requestId = crypto.randomUUID();
      const body = { draftId: reviewed.draftId, expectedDraftRevision: reviewed.revision, claimedFingerprint: reviewed.fingerprint, declaration: reviewed.declaration };
      return async () => {
        const value = await http.post<unknown>(`${base}/charges`, structuredClone(body), options(requestId));
        if (!exact(value, ["id", "fingerprint", "declaration"]) || !uuid(value.id) || value.fingerprint !== reviewed.fingerprint || value.declaration !== reviewed.declaration) return bad();
        return { id: value.id, fingerprint: reviewed.fingerprint, declaration: reviewed.declaration };
      };
    },
    publicationAction(input: PricingDraft) {
      const { draftId, ...stored } = structuredClone(input), saved = draft(stored, draftId);
      if (!uuid(draftId) || saved.stale || !saved.snapshot.ownerReferences.charges) return bad();
      const requestId = crypto.randomUUID(), body = { expectedRevision: saved.baseRevision, sources: saved.sources, snapshot: saved.snapshot, draft: { id: saved.draftId, revision: saved.revision } };
      return async () => {
        const value = await http.post<unknown>(`${base}/publish`, structuredClone(body), options(requestId));
        if (!exact(value, ["revision", "replayed"]) || value.revision !== saved.baseRevision + 1 || typeof value.replayed !== "boolean") return bad();
        return { revision: value.revision as number, replayed: value.replayed };
      };
    },
  };
}
