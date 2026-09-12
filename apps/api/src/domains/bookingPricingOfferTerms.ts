import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { pricingInteger, pricingKeys, pricingObject } from "@vayada/domain-pms";
import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
export { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import type { Pool, PoolClient } from "pg";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockPmsPricingBaseRevision } from "./pmsPricingBaseRevision.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { PricingStorageError, type PricingStorageScope } from "./replacementPricingStore.js";

const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const fail = (code: "invalid" | "denied" | "stale" | "idempotency_conflict"): never => { throw new PricingStorageError(code); };

/** Complete Booking terms-head source inside a caller-authorized transaction.
 * The writer takes the same property lock, protecting new heads as well as updates.
 * Immutable terms are identified by revision; historical rows are not current sources. */
export async function lockBookingPricingTermsSource(client: PoolClient, propertyId: string): Promise<string | null> {
  if (!uuid(propertyId)) return null;
  propertyId = propertyId.toLowerCase();
  await lockPmsInventoryMutationScope(client, propertyId);
  const terms = (await client.query(`SELECT room_type_id,offer_id,revision FROM booking.pricing_v2_offer_term_heads
    WHERE property_id=$1 ORDER BY room_type_id,offer_id COLLATE "C" FOR SHARE`, [propertyId])).rows;
  return termsSource(propertyId, terms);
}

/** Booking-owned read port. Caller has authorized/locked the property transaction first.
 * Return only exact CURRENT references; historical accepted bookings use their stored evidence. */
export async function lockBookingPricingOfferTerms(client: PoolClient, propertyId: string,
  references: readonly Pick<ReplacementOfferTerms, "roomTypeId" | "offerId" | "revision">[]): Promise<readonly ReplacementOfferTerms[] | null> {
  if (!uuid(propertyId) || references.some((r) => !uuid(r.roomTypeId) || !text(r.offerId) || !uuid(r.revision)) ||
      new Set(references.map((r) => canonical([r.roomTypeId.toLowerCase(), r.offerId]))).size !== references.length) return null;
  const terms: ReplacementOfferTerms[] = [];
  for (const ref of references) {
    const row = (await client.query(`SELECT t.terms FROM booking.pricing_v2_offer_term_heads h
      JOIN booking.pricing_v2_offer_terms t USING(property_id,room_type_id,offer_id,revision)
      WHERE h.property_id=$1 AND h.room_type_id=$2 AND h.offer_id=$3 AND h.revision=$4 FOR SHARE OF h`,
    [propertyId, ref.roomTypeId, ref.offerId, ref.revision])).rows[0];
    const parsed = parseBookingPricingOfferTerms(row?.terms);
    if (!parsed) return null;
    terms.push(parsed);
  }
  return terms;
}

export type BookingPricingDraft = Readonly<{ draftId: string; baseRevision: number }>;
const draftValid = (draft: BookingPricingDraft) => pricingObject(draft) && pricingKeys(draft, ["draftId", "baseRevision"]) && uuid(draft.draftId) && pricingInteger(draft.baseRevision) && draft.baseRevision < 2147483647;
type TermsCommand = { requestId: string; expectedRevision: string | null; terms: unknown };

/** Caller owns the transaction. References must come from the complete proposed snapshot. */
export async function lockBookingPricingDraftTerms(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, draft: BookingPricingDraft,
  references: readonly Pick<ReplacementOfferTerms, "roomTypeId" | "offerId" | "revision">[], access: "read" | "manage" = "manage"): Promise<readonly ReplacementOfferTerms[] | null> {
  scope = structuredClone(scope); draft = structuredClone(draft); references = structuredClone(references);
  if (!draftValid(draft) || !references.length || references.some((r) => !uuid(r.roomTypeId) || !text(r.offerId) || !uuid(r.revision)) ||
      new Set(references.map((r) => canonical([r.roomTypeId.toLowerCase(), r.offerId]))).size !== references.length ||
      !await lockReplacementPricingAuthorization(client, context, scope, access) ||
      !await lockPmsPricingBaseRevision(client, scope.propertyId, draft.baseRevision)) return null;
  const result: ReplacementOfferTerms[] = [];
  for (const ref of references) {
    if (!await lockPmsPricingRoomScope(client, scope.propertyId, ref.roomTypeId)) return null;
    const active = await lockBookingPricingOfferTerms(client, scope.propertyId, [ref]);
    if (active) { result.push(...active); continue; }
    const row = (await client.query(`SELECT t.terms FROM booking.pricing_v2_offer_term_candidates c
      JOIN booking.pricing_v2_offer_terms t USING(property_id,room_type_id,offer_id,revision)
      LEFT JOIN booking.pricing_v2_offer_term_heads h USING(property_id,room_type_id,offer_id)
      WHERE c.property_id=$1 AND c.room_type_id=$2 AND c.offer_id=$3 AND c.revision=$4
        AND c.draft_id=$5 AND c.base_revision=$6 AND c.expected_revision IS NOT DISTINCT FROM h.revision`,
    [scope.propertyId, ref.roomTypeId, ref.offerId, ref.revision, draft.draftId, draft.baseRevision])).rows[0];
    const parsed = parseBookingPricingOfferTerms(row?.terms);
    if (!parsed) return null;
    result.push(parsed);
  }
  return result;
}

/** Single replacement terms writer. Saving requested deposits does not approve Finance capability. */
export function createBookingPricingOfferTermsStore(pool: Pool) {
  async function transaction<T>(context: RequestContext | null, scope: PricingStorageScope, operation: "read" | "manage",
    work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (!await lockReplacementPricingAuthorization(client, context, scope, operation)) return fail("denied");
      const result = await work(client);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function write(context: RequestContext | null, scope: PricingStorageScope,
      input: TermsCommand, candidate?: BookingPricingDraft): Promise<ReplacementOfferTerms> {
      if ((candidate !== undefined && !draftValid(candidate)) || !text(input.requestId) || !(input.expectedRevision === null || uuid(input.expectedRevision)) ||
          !pricingObject(input.terms) || !pricingKeys(input.terms, ["roomTypeId", "offerId", "cancellation", "payment"])) return fail("invalid");
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      const terms = parseBookingPricingOfferTerms({ ...input.terms, revision: randomUUID() });
      if (!terms) return fail("invalid");
      const draft = candidate ? { ...candidate, draftId: candidate.draftId.toLowerCase() } : null;
      const requestId = input.requestId, expected = input.expectedRevision?.toLowerCase() ?? null;
      const hash = createHash("sha256").update(canonical({ scope, requestId, expected, ...(draft ? { draft } : {}), terms: { ...terms, revision: null } })).digest("hex");
      return transaction(context, scope, "manage", async (client) => {
        if (!await lockPmsPricingRoomScope(client, scope.propertyId, terms.roomTypeId)) return fail("denied");
        const prior = (await client.query("SELECT terms,request_hash FROM booking.pricing_v2_offer_terms WHERE property_id=$1 AND request_id=$2", [scope.propertyId, requestId])).rows[0];
        if (prior) { if (prior.request_hash !== hash) return fail("idempotency_conflict"); return parseBookingPricingOfferTerms(prior.terms) ?? fail("invalid"); }
        if (draft && !await lockPmsPricingBaseRevision(client, scope.propertyId, draft.baseRevision)) return fail("stale");
        const head = (await client.query("SELECT revision FROM booking.pricing_v2_offer_term_heads WHERE property_id=$1 AND room_type_id=$2 AND offer_id=$3 FOR UPDATE", [scope.propertyId, terms.roomTypeId, terms.offerId])).rows[0];
        if ((head?.revision ?? null) !== expected) return fail("stale");
        await client.query(`INSERT INTO booking.pricing_v2_offer_terms
          (property_id,room_type_id,offer_id,revision,terms,request_id,request_hash,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision, canonical(terms), requestId, hash, scope.actorUserId]);
        if (draft) await client.query(`INSERT INTO booking.pricing_v2_offer_term_candidates
          (property_id,room_type_id,offer_id,revision,draft_id,base_revision,expected_revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision, draft.draftId, draft.baseRevision, expected]);
        else await client.query(`INSERT INTO booking.pricing_v2_offer_term_heads(property_id,room_type_id,offer_id,revision)
          VALUES($1,$2,$3,$4) ON CONFLICT(property_id,room_type_id,offer_id) DO UPDATE SET revision=$4`, [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision]);
        await policyEffects(client, scope, terms, requestId, !!draft);
        return terms;
      });
    }
  return {
    save: (context: RequestContext | null, scope: PricingStorageScope, input: TermsCommand) => write(context, scope, input),
    stage: (context: RequestContext | null, scope: PricingStorageScope, input: TermsCommand, draft: BookingPricingDraft) => draftValid(draft) ? write(context, scope, input, draft) : Promise.reject(new PricingStorageError("invalid")),
    read(context: RequestContext | null, scope: PricingStorageScope, roomTypeId: string, offerId: string) {
      if (!uuid(roomTypeId) || !text(offerId)) return Promise.reject(new PricingStorageError("invalid"));
      return transaction(context, scope, "read", async (client) => {
        if (!await lockPmsPricingRoomScope(client, scope.propertyId, roomTypeId)) return fail("denied");
        const row = (await client.query(`SELECT t.terms FROM booking.pricing_v2_offer_term_heads h
          JOIN booking.pricing_v2_offer_terms t USING(property_id,room_type_id,offer_id,revision)
          WHERE h.property_id=$1 AND h.room_type_id=$2 AND h.offer_id=$3`, [scope.propertyId, roomTypeId, offerId])).rows[0];
        return row ? parseBookingPricingOfferTerms(row.terms) ?? fail("invalid") : null;
      });
    },
  };
}

async function policyEffects(client: PoolClient, scope: PricingStorageScope, terms: ReplacementOfferTerms, requestId: string, staged: boolean) {
  const eventType = staged ? "booking.pricing_terms.staged" : "booking.pricing_terms.revised";
  const key = `booking.pricing_terms:${scope.propertyId}:${requestId}`, payload = canonical({ roomTypeId: terms.roomTypeId, offerId: terms.offerId, revision: terms.revision });
  const event = (await client.query(`INSERT INTO platform.domain_events
    (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload)
    VALUES('booking',$1,$6,now(),'property',$2::uuid,'booking','offer_terms',$3,'user',$4,$5) RETURNING id`,
  [key, scope.propertyId, terms.revision, scope.actorUserId, payload, eventType])).rows[0].id;
  await client.query(`INSERT INTO platform.product_audit_events
    (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,domain_event_id)
    VALUES($1,'booking',$6,now(),'property',$2,'user',$3,'booking','offer_terms',$4,$5)`, [key, scope.propertyId, scope.actorUserId, terms.revision, event, eventType]);
  if (!staged) await client.query(`INSERT INTO platform.outbox_events
    (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
    VALUES($1,$2,'pricing.v2','booking.pricing_terms.revised','property',$3,'booking','offer_terms',$4,$5)`, [event, key, scope.propertyId, terms.revision, payload]);
}

type TermsHead = { room_type_id: string; offer_id: string; revision: string };
function termsSource(propertyId: string, terms: TermsHead[]): string {
  terms.sort((a, b) => a.room_type_id < b.room_type_id ? -1 : a.room_type_id > b.room_type_id ? 1 : Buffer.compare(Buffer.from(a.offer_id), Buffer.from(b.offer_id)));
  return "booking.pricing.terms.v2:" + createHash("sha256").update(canonical({ propertyId: propertyId.toLowerCase(), terms })).digest("hex");
}

/** Projection only; all selected references must belong to the complete proposed snapshot. */
export async function projectBookingPricingDraftTerms(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, draft: BookingPricingDraft,
  references: readonly Pick<ReplacementOfferTerms, "roomTypeId" | "offerId" | "revision">[], access: "read" | "manage" = "manage") {
  scope = structuredClone(scope);
  const terms = await lockBookingPricingDraftTerms(client, context, scope, draft, references, access);
  if (!terms) return null;
  const heads: TermsHead[] = (await client.query(`SELECT room_type_id,offer_id,revision FROM booking.pricing_v2_offer_term_heads
    WHERE property_id=$1 FOR SHARE`, [scope.propertyId])).rows;
  const changes: ReplacementOfferTerms[] = [];
  for (const term of terms) {
    const index = heads.findIndex((h) => h.room_type_id === term.roomTypeId && h.offer_id === term.offerId);
    if (index >= 0 && heads[index]!.revision === term.revision) continue;
    changes.push(term);
    const head = { room_type_id: term.roomTypeId, offer_id: term.offerId, revision: term.revision };
    if (index < 0) heads.push(head); else heads[index] = head;
  }
  return { terms, changes, source: termsSource(scope.propertyId, heads) };
}

/** Only the pricing publisher calls this inside its transaction, after exact draft/Finance/charge validation.
 * No commit or standalone endpoint. Caller must roll back on any failure. */
export async function activateBookingPricingDraftTerms(client: PoolClient, context: RequestContext | null,
  scope: PricingStorageScope, draft: BookingPricingDraft,
  references: readonly Pick<ReplacementOfferTerms, "roomTypeId" | "offerId" | "revision">[], expectedSource: string) {
  scope = structuredClone(scope);
  const projected = await projectBookingPricingDraftTerms(client, context, scope, draft, references);
  if (!projected || projected.source !== expectedSource) return fail("stale");
  for (const terms of projected.changes) {
    await client.query(`INSERT INTO booking.pricing_v2_offer_term_heads(property_id,room_type_id,offer_id,revision)
      VALUES($1,$2,$3,$4) ON CONFLICT(property_id,room_type_id,offer_id) DO UPDATE SET revision=$4`,
    [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision]);
    await policyEffects(client, scope, terms, `activate:${terms.revision}`, false);
  }
  if (await lockBookingPricingTermsSource(client, scope.propertyId) !== expectedSource) return fail("stale");
}
