import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import { parseFlexibleCancellationTerms, pricingInteger, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { PricingStorageError, type PricingStorageScope } from "./replacementPricingStore.js";

const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= 200;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const fail = (code: "invalid" | "denied" | "stale" | "idempotency_conflict"): never => { throw new PricingStorageError(code); };

/** Strict owner boundary; no defaults that silently change a saved policy. */
export function parseBookingPricingOfferTerms(value: unknown): ReplacementOfferTerms | null {
  if (!pricingObject(value) || !pricingKeys(value, ["roomTypeId", "offerId", "revision", "cancellation", "payment"]) ||
      !uuid(value.roomTypeId) || !text(value.offerId) || !uuid(value.revision) || !pricingObject(value.cancellation) || !pricingObject(value.payment)) return null;
  const c = value.cancellation, p = value.payment;
  if (!(c.kind === "non_refundable" && pricingKeys(c, ["kind"])) &&
      !(c.kind === "flexible" && pricingKeys(c, ["kind", "terms"]) && parseFlexibleCancellationTerms(c.terms))) return null;
  if (!(p.kind === "full" && pricingKeys(p, ["kind"])) &&
      !(p.kind === "deposit" && pricingKeys(p, ["kind", "basisPoints", "balanceDaysBeforeArrival"]) &&
        pricingInteger(p.basisPoints, 1) && p.basisPoints <= 10000 && pricingInteger(p.balanceDaysBeforeArrival))) return null;
  return structuredClone({ ...value, roomTypeId: value.roomTypeId.toLowerCase(), revision: value.revision.toLowerCase() }) as ReplacementOfferTerms;
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
  return {
    async save(context: RequestContext | null, scope: PricingStorageScope,
      input: { requestId: string; expectedRevision: string | null; terms: unknown }): Promise<ReplacementOfferTerms> {
      if (!text(input.requestId) || !(input.expectedRevision === null || uuid(input.expectedRevision)) ||
          !pricingObject(input.terms) || !pricingKeys(input.terms, ["roomTypeId", "offerId", "cancellation", "payment"])) return fail("invalid");
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      const terms = parseBookingPricingOfferTerms({ ...input.terms, revision: randomUUID() });
      if (!terms) return fail("invalid");
      const requestId = input.requestId, expected = input.expectedRevision?.toLowerCase() ?? null;
      const hash = createHash("sha256").update(canonical({ scope, requestId, expected, terms: { ...terms, revision: null } })).digest("hex");
      return transaction(context, scope, "manage", async (client) => {
        if (!await lockPmsPricingRoomScope(client, scope.propertyId, terms.roomTypeId)) return fail("denied");
        const prior = (await client.query("SELECT terms,request_hash FROM booking.pricing_v2_offer_terms WHERE property_id=$1 AND request_id=$2", [scope.propertyId, requestId])).rows[0];
        if (prior) { if (prior.request_hash !== hash) return fail("idempotency_conflict"); return parseBookingPricingOfferTerms(prior.terms) ?? fail("invalid"); }
        const head = (await client.query("SELECT revision FROM booking.pricing_v2_offer_term_heads WHERE property_id=$1 AND room_type_id=$2 AND offer_id=$3 FOR UPDATE", [scope.propertyId, terms.roomTypeId, terms.offerId])).rows[0];
        if ((head?.revision ?? null) !== expected) return fail("stale");
        await client.query(`INSERT INTO booking.pricing_v2_offer_terms
          (property_id,room_type_id,offer_id,revision,terms,request_id,request_hash,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision, canonical(terms), requestId, hash, scope.actorUserId]);
        await client.query(`INSERT INTO booking.pricing_v2_offer_term_heads(property_id,room_type_id,offer_id,revision)
          VALUES($1,$2,$3,$4) ON CONFLICT(property_id,room_type_id,offer_id) DO UPDATE SET revision=$4`, [scope.propertyId, terms.roomTypeId, terms.offerId, terms.revision]);
        const key = `booking.pricing_terms:${scope.propertyId}:${requestId}`, payload = canonical({ roomTypeId: terms.roomTypeId, offerId: terms.offerId, revision: terms.revision });
        const event = (await client.query(`INSERT INTO platform.domain_events
          (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload)
          VALUES('booking',$1,'booking.pricing_terms.revised',now(),'property',$2::uuid,'booking','offer_terms',$3,'user',$4,$5) RETURNING id`,
        [key, scope.propertyId, terms.revision, scope.actorUserId, payload])).rows[0].id;
        await client.query(`INSERT INTO platform.product_audit_events
          (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,domain_event_id)
          VALUES($1,'booking','booking.pricing_terms.revised',now(),'property',$2,'user',$3,'booking','offer_terms',$4,$5)`, [key, scope.propertyId, scope.actorUserId, terms.revision, event]);
        await client.query(`INSERT INTO platform.outbox_events
          (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
          VALUES($1,$2,'pricing.v2','booking.pricing_terms.revised','property',$3,'booking','offer_terms',$4,$5)`, [event, key, scope.propertyId, terms.revision, payload]);
        return terms;
      });
    },
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
