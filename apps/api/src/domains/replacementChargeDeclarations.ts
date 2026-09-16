import { lockReplacementPricingDraftOwners } from "./replacementPricingOfferOwners.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { parsePricingConfiguration, pricingCurrencyScale, pricingInteger, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockBookingPricingOfferTerms, lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockPmsPricingRoomScope } from "./pmsPricingRoomScope.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { PricingStorageError, type PricingStorageScope, type PricingStorageSnapshot, type PricingStorageSources } from "./replacementPricingStore.js";

const declaration = "all_mandatory_charges_included" as const;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hashPattern = /^[a-f0-9]{64}$/;
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const fail = (code: "invalid" | "denied" | "stale" | "idempotency_conflict"): never => { throw new PricingStorageError(code); };
const references = (v: unknown): v is PricingStorageSources => pricingObject(v) && Object.entries(v).every(([k, x]) =>
  k.length > 0 && k === k.trim() && typeof x === "string" && x.length > 0 && x === x.trim());
const withoutSelf = (v: PricingStorageSources) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== "charges"));
export type ReplacementChargeDeclaration = { id: string; fingerprint: string; declaration: typeof declaration };

/** Exclude only the declaration's own reference; attaching it must not invalidate itself. */
export function replacementChargeFingerprint(propertyId: string, snapshot: PricingStorageSnapshot, sources: PricingStorageSources): string | null {
  if (!uuid(propertyId) || !pricingObject(snapshot) || !pricingKeys(snapshot, ["currency", "rooms", "ownerReferences"]) ||
      pricingCurrencyScale(snapshot.currency) === null || !Array.isArray(snapshot.rooms) || !snapshot.rooms.length ||
      !references(snapshot.ownerReferences) || !references(sources)) return null;
  const rooms = Array.from(snapshot.rooms, parsePricingConfiguration);
  if (rooms.some((r) => !r || r.propertyId !== propertyId.toLowerCase() || r.currency !== snapshot.currency) ||
      new Set(rooms.map((r) => r!.roomTypeId)).size !== rooms.length) return null;
  return hash({ version: "pricing.v2.charge_inclusion", propertyId: propertyId.toLowerCase(), currency: snapshot.currency,
    rooms: rooms.sort((a, b) => a!.roomTypeId.localeCompare(b!.roomTypeId)), ownerReferences: withoutSelf(snapshot.ownerReferences), sources: withoutSelf(sources) });
}

/** Owner port inside an authorized property transaction. No declaration means unavailable. */
export async function lockReplacementChargeDeclaration(client: PoolClient, propertyId: string, id: string,
  snapshot: PricingStorageSnapshot, sources: PricingStorageSources): Promise<ReplacementChargeDeclaration | null> {
  const fingerprint = replacementChargeFingerprint(propertyId, snapshot, sources);
  if (!fingerprint || !uuid(id)) return null;
  const row = (await client.query(`SELECT id,fingerprint,declaration FROM pms.pricing_v2_charge_declarations
    WHERE property_id=$1 AND id=$2 AND fingerprint=$3`, [propertyId, id, fingerprint])).rows[0];
  return row ? { id: row.id, fingerprint: row.fingerprint, declaration: row.declaration } : null;
}

export function createReplacementChargeDeclarationStore(pool: Pool) {
  return {
    async confirm(context: RequestContext | null, scope: PricingStorageScope, input: {
      draftId: string; expectedDraftRevision: number; claimedFingerprint: string; declaration: typeof declaration; requestId: string;
    }): Promise<ReplacementChargeDeclaration> {
      if (!uuid(input.draftId) || !pricingInteger(input.expectedDraftRevision, 1) || input.expectedDraftRevision > 2147483647 ||
          !hashPattern.test(input.claimedFingerprint) || input.declaration !== declaration || typeof input.requestId !== "string" ||
          input.requestId.length < 1 || input.requestId.length > 200 || input.requestId.trim() !== input.requestId) return fail("invalid");
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      const command = structuredClone({ ...input, draftId: input.draftId.toLowerCase() }), requestHash = hash({ scope, command });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!await lockReplacementPricingAuthorization(client, context, scope, "manage")) return fail("denied");
        const prior = (await client.query(`SELECT id,fingerprint,declaration,request_hash FROM pms.pricing_v2_charge_declarations
          WHERE property_id=$1 AND request_id=$2`, [scope.propertyId, command.requestId])).rows[0];
        if (prior) {
          if (prior.request_hash !== requestHash) return fail("idempotency_conflict");
          await client.query("COMMIT"); return { id: prior.id, fingerprint: prior.fingerprint, declaration: prior.declaration };
        }
        const currentSources = { room: await lockPmsReplacementPricingRoomSource(client, scope.propertyId),
          terms: await lockBookingPricingTermsSource(client, scope.propertyId), finance: await lockFinanceReplacementPricingSource(client, scope.propertyId) };
        const draft = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2 FOR UPDATE", [scope.propertyId, command.draftId])).rows[0];
        const head = (await client.query("SELECT revision FROM pms.pricing_v2_heads WHERE property_id=$1", [scope.propertyId])).rows[0];
        if (!draft || draft.draft_revision !== command.expectedDraftRevision || draft.base_revision !== (head?.revision ?? 0)) return fail("stale");
        const fingerprint = replacementChargeFingerprint(scope.propertyId, draft.snapshot, draft.effective_source_revisions ?? draft.source_revisions);
        if (!fingerprint || fingerprint !== command.claimedFingerprint || draft.snapshot.rooms.some((r: { revision: number }) => r.revision !== draft.base_revision + 1)) return fail("stale");
        if (draft.effective_source_revisions) {
          const owners = await lockReplacementPricingDraftOwners(client, context, scope, draft.snapshot, draft.effective_source_revisions,
            { draftId: command.draftId, baseRevision: draft.base_revision });
          if (owners.kind === "unavailable") return fail("denied");
        }
        for (const room of draft.snapshot.rooms as PricingStorageSnapshot["rooms"]) {
          if (!await lockPmsPricingRoomScope(client, scope.propertyId, room.roomTypeId)) return fail("denied");
          if (!draft.effective_source_revisions && !await lockBookingPricingOfferTerms(client, scope.propertyId, room.offers.map((o) => ({ roomTypeId: room.roomTypeId, offerId: o.id, revision: o.termsRevision })))) return fail("stale");
        }
        if (!currentSources.room || !currentSources.terms || !currentSources.finance ||
            canonical(currentSources) !== canonical(draft.source_revisions)) return fail("stale");
        const id = randomUUID(), key = `pricing.v2.charges:${scope.propertyId}:${command.requestId}`;
        await client.query(`INSERT INTO pms.pricing_v2_charge_declarations
          (id,property_id,fingerprint,declaration,draft_id,draft_revision,request_id,request_hash,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, scope.propertyId, fingerprint, declaration, command.draftId, command.expectedDraftRevision, command.requestId, requestHash, scope.actorUserId]);
        const event = (await client.query(`INSERT INTO platform.domain_events
          (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload)
          VALUES('pms',$1,'pricing.v2.charges.confirmed',now(),'property',$2,'pms','mandatory_charge_confirmation',$3,'user',$4,$5) RETURNING id`,
        [key, scope.propertyId, id, scope.actorUserId, canonical({ id, fingerprint })])).rows[0].id;
        await client.query(`INSERT INTO platform.product_audit_events
          (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,domain_event_id)
          VALUES($1,'pms','pricing.v2.charges.confirmed',now(),'property',$2,'user',$3,'pms','mandatory_charge_confirmation',$4,$5)`, [key, scope.propertyId, scope.actorUserId, id, event]);
        await client.query(`INSERT INTO platform.outbox_events
          (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
          VALUES($1,$2,'pricing.v2','pricing.v2.charges.confirmed','property',$3,'pms','mandatory_charge_confirmation',$4,$5)`, [event, key, scope.propertyId, id, canonical({ id, fingerprint })]);
        await client.query("COMMIT"); return { id, fingerprint, declaration };
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
  };
}
