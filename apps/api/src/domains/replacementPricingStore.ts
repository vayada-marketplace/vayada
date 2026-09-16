import type { BookingPricingDraft } from "./bookingPricingOfferTerms.js";
import { createHash } from "node:crypto";
import { isCompletePricingCurrencyConversion, pricingInteger, pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockReplacementPricingFxObservation } from "./replacementPricingFxStore.js";

export type PricingStorageScope = Readonly<{ propertyId: string; organizationId: string; actorUserId: string }>;
export { PricingStorageError, type PricingStorageSources, type PricingStorageSnapshot, type StoredPricingRevision } from "./replacementPricingSnapshot.js";
import { PricingStorageError, parsePricingStorageSnapshot as snapshot, readCurrentPricingSnapshot as current,
  type PricingStorageSources, type PricingStorageSnapshot, type StoredPricingRevision } from "./replacementPricingSnapshot.js";
export interface PricingStorageGuard {
  /** Recheck current access and lock current source revisions until transaction end.
   * Runs even for historical retries; must not require proposed owner references to remain current. */
  lock(client: PoolClient, scope: PricingStorageScope, access: "read" | "manage"): Promise<PricingStorageSources | null>;
  /** Validate every proposed room/owner/terms reference against its owner and hold relevant locks.
   * Required for new publications and drafts, after historical receipt lookup. No default allow. */
  validate(client: PoolClient, scope: PricingStorageScope, proposed: PricingStorageSnapshot, sources: PricingStorageSources, intent: "draft" | "publish", draft?: BookingPricingDraft): Promise<boolean>;
  /** Optional draft-policy support. Missing ports must fail closed for projected sources. */
  project?(client: PoolClient, scope: PricingStorageScope, proposed: PricingStorageSnapshot, sources: PricingStorageSources, draft: BookingPricingDraft, access: "read" | "manage"): Promise<PricingStorageSources | null>;
  activate?(client: PoolClient, scope: PricingStorageScope, proposed: PricingStorageSnapshot, sources: PricingStorageSources, draft: BookingPricingDraft): Promise<void>;
  /** Additional owner approval: verify separately owned amounts and conversion obligations.
   * Storage independently enforces persisted FX and complete PMS room conversion. No default allow. */
  allowCurrencyChange(client: PoolClient, scope: PricingStorageScope, before: StoredPricingRevision,
    after: PricingStorageSnapshot): Promise<boolean>;
}
const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fail = (code: PricingStorageError["code"]): never => { throw new PricingStorageError(code); };
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim();
const references = (v: unknown): v is PricingStorageSources => pricingObject(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => text(k) && text(x));
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
/** Infrastructure primitive only. Routes/preview/publication orchestration belong to VAY-1541. */
export function createReplacementPricingStore(pool: Pool, guard: PricingStorageGuard) {
  async function transaction<T>(scope: PricingStorageScope, access: "read" | "manage", work: (client: PoolClient, sources: PricingStorageSources) => Promise<T>): Promise<T> {
    if (![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid)) return fail("invalid");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockPmsInventoryMutationScope(client, scope.propertyId);
      const sources = await guard.lock(client, scope, access);
      if (!sources) return fail("denied");
      if (!references(sources)) return fail("invalid");
      const result = await work(client, sources);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function effects(client: PoolClient, scope: PricingStorageScope, revision: number, operation: string, requestId: string, publish: boolean) {
    const key = `pricing.v2:${scope.propertyId}:${operation}:${requestId}`;
    const event = (await client.query(`INSERT INTO platform.domain_events
      (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,actor_type,actor_user_id,payload)
      VALUES('pms',$1,$2,now(),'property',$3::uuid,'pms','pricing_revision',$3::text,'user',$4,$5) RETURNING id`,
    [key, operation, scope.propertyId, scope.actorUserId, JSON.stringify({ revision })])).rows[0].id;
    await client.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,domain_event_id)
      VALUES($1,'pms',$2,now(),'property',$3::uuid,'user',$4,'pms','pricing_revision',$3::text,$5)`, [key, operation, scope.propertyId, scope.actorUserId, event]);
    if (publish) await client.query(`INSERT INTO platform.outbox_events
      (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      VALUES($1,$2,'pricing.v2',$3,'property',$4::uuid,'pms','pricing_revision',$4::text,$5)`,
    [event, key, operation, scope.propertyId, JSON.stringify({ revision })]);
  }
  return {
    read(scope: PricingStorageScope) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      return transaction(scope, "read", async (client, sources) => {
        const result = await current(client, scope.propertyId);
        return result && { ...result, stale: canonical(result.sources) !== canonical(sources) };
      });
    },
    save(scope: PricingStorageScope, input: { requestId: string; expectedRevision: number; sources: PricingStorageSources; effectiveSources?: PricingStorageSources; snapshot: unknown;
      draft?: Readonly<{ id: string; revision: number }> }) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!text(input.requestId) || input.requestId.length > 200 || !pricingInteger(input.expectedRevision) || input.expectedRevision >= 2147483647 || !references(input.sources)) return Promise.reject(new PricingStorageError("invalid"));
      if (input.effectiveSources !== undefined && (!references(input.effectiveSources) || !input.draft)) return Promise.reject(new PricingStorageError("invalid"));
      if (input.draft !== undefined && (!pricingObject(input.draft) || !pricingKeys(input.draft, ["id", "revision"]) ||
          typeof input.draft.id !== "string" || !uuid(input.draft.id) || !pricingInteger(input.draft.revision, 1) || input.draft.revision > 2147483647)) return Promise.reject(new PricingStorageError("invalid"));
      const next = snapshot(input.snapshot, scope.propertyId, input.expectedRevision + 1);
      const command = structuredClone({ ...input, snapshot: next, ...(input.draft ? { draft: { ...input.draft, id: input.draft.id.toLowerCase() } } : {}) });
      const hash = createHash("sha256").update(canonical({ ...command, scope })).digest("hex");
      return transaction(scope, "manage", async (client, sources) => {
        const prior = (await client.query("SELECT revision,request_hash FROM pms.pricing_v2_revisions WHERE property_id=$1 AND request_id=$2", [scope.propertyId, command.requestId])).rows[0];
        if (prior) { if (prior.request_hash !== hash) return fail("idempotency_conflict"); return { revision: prior.revision as number, replayed: true }; }
        if (command.draft) {
          const draft = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2 FOR UPDATE", [scope.propertyId, command.draft.id])).rows[0];
          if (!draft || draft.draft_revision !== command.draft.revision || draft.base_revision !== command.expectedRevision ||
              canonical(draft.source_revisions) !== canonical(command.sources) || canonical(draft.effective_source_revisions) !== canonical(command.effectiveSources ?? null) || canonical(draft.snapshot) !== canonical(next)) return fail("stale");
        }
        if (canonical(sources) !== canonical(command.sources)) return fail("stale");
        const previous = await current(client, scope.propertyId);
        if ((previous?.revision ?? 0) !== command.expectedRevision) return fail("stale");
        const effective = command.effectiveSources ?? sources;
        if (command.effectiveSources) {
          const draftContext = { draftId: command.draft!.id, baseRevision: command.expectedRevision };
          const projected = await guard.project?.(client, scope, next, sources, draftContext, "manage");
          if (!projected || canonical(projected) !== canonical(effective)) return fail("stale");
          if (!next.ownerReferences.charges || !await guard.validate(client, scope, next, effective, "draft", draftContext) || !guard.activate) return fail("denied");
          await guard.activate(client, scope, next, effective, draftContext);
          const activated = await guard.lock(client, scope, "manage");
          if (canonical(activated) !== canonical(effective)) return fail("stale");
        }
        if (!await guard.validate(client, scope, next, effective, "publish")) return fail("denied");
        const currencyChange = previous && previous.currency !== next.currency;
        if (currencyChange) {
          const rate = await lockReplacementPricingFxObservation(client, next.ownerReferences.fx ?? "", previous.currency, next.currency);
          const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
          if (!rate || !isCompletePricingCurrencyConversion(previous.rooms, next.rooms, rate, now.getTime()) ||
              !await guard.allowCurrencyChange(client, scope, previous, next)) return fail("currency_conversion_required");
        }
        await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1) ON CONFLICT DO NOTHING", [scope.propertyId]);
        const revision = command.expectedRevision + 1;
        await client.query(`INSERT INTO pms.pricing_v2_revisions
          (property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scope.propertyId, revision, next.currency, canonical(effective), canonical(next.ownerReferences), command.requestId, hash, scope.actorUserId, next.rooms.length]);
        for (const room of next.rooms) await client.query(`INSERT INTO pms.pricing_v2_rooms
          (property_id,revision,room_type_id,currency,configuration) VALUES($1,$2,$3,$4,$5)`, [scope.propertyId, revision, room.roomTypeId, next.currency, JSON.stringify(room)]);
        await client.query("UPDATE pms.pricing_v2_heads SET revision=$2 WHERE property_id=$1", [scope.propertyId, revision]);
        await effects(client, scope, revision, "pricing.v2.revised", command.requestId, true);
        // A slow write/effect must not extend FX validity. Failure rolls back the entire publication.
        if (currencyChange && !await lockReplacementPricingFxObservation(client, next.ownerReferences.fx ?? "", previous.currency, next.currency)) return fail("currency_conversion_required");
        return { revision, replayed: false };
      });
    },
    saveDraft(scope: PricingStorageScope, input: { draftId: string; expectedDraftRevision: number; baseRevision: number; sources: PricingStorageSources; effectiveSources?: PricingStorageSources; snapshot: unknown }) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!uuid(input.draftId) || !pricingInteger(input.expectedDraftRevision) || input.expectedDraftRevision >= 2147483647 || !pricingInteger(input.baseRevision) || input.baseRevision >= 2147483647 || !references(input.sources)) return Promise.reject(new PricingStorageError("invalid"));
      if (input.effectiveSources !== undefined && !references(input.effectiveSources)) return Promise.reject(new PricingStorageError("invalid"));
      const next = snapshot(input.snapshot, scope.propertyId, input.baseRevision + 1);
      const command = structuredClone({ ...input, snapshot: next });
      return transaction(scope, "manage", async (client, sources) => {
        if (canonical(sources) !== canonical(command.sources) || ((await current(client, scope.propertyId))?.revision ?? 0) !== command.baseRevision) return fail("stale");
        const draftContext = command.effectiveSources ? { draftId: command.draftId, baseRevision: command.baseRevision } : undefined;
        if (draftContext) {
          const projected = await guard.project?.(client, scope, next, sources, draftContext, "manage");
          if (!projected || canonical(projected) !== canonical(command.effectiveSources)) return fail("stale");
        }
        if (!await guard.validate(client, scope, next, command.effectiveSources ?? sources, "draft", draftContext)) return fail("denied");
        const previous = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2", [scope.propertyId, command.draftId])).rows[0];
        if (previous?.draft_revision === command.expectedDraftRevision + 1 && previous.base_revision === command.baseRevision && canonical(previous.snapshot) === canonical(next) && canonical(previous.source_revisions) === canonical(sources) && canonical(previous.effective_source_revisions) === canonical(command.effectiveSources ?? null)) return previous.draft_revision as number;
        if ((previous?.draft_revision ?? 0) !== command.expectedDraftRevision) return fail("stale");
        await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1) ON CONFLICT DO NOTHING", [scope.propertyId]);
        const revision = command.expectedDraftRevision + 1;
        await client.query(`INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id,effective_source_revisions)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(property_id,draft_id) DO UPDATE SET
          draft_revision=$3,base_revision=$4,source_revisions=$5,snapshot=$6,actor_user_id=$7,effective_source_revisions=$8`,
        [scope.propertyId, command.draftId, revision, command.baseRevision, canonical(sources), canonical(next), scope.actorUserId, command.effectiveSources ? canonical(command.effectiveSources) : null]);
        await effects(client, scope, revision, "pricing.v2.drafted", `${command.draftId}:${revision}`, false);
        return revision;
      });
    },
    readDraft(scope: PricingStorageScope, draftId: string) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!uuid(draftId)) return Promise.reject(new PricingStorageError("invalid"));
      return transaction(scope, "read", async (client, sources) => {
        const draft = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2", [scope.propertyId, draftId])).rows[0];
        const projected = draft?.effective_source_revisions ? await guard.project?.(client, scope,
          snapshot(draft.snapshot, scope.propertyId, draft.base_revision + 1), sources, { draftId, baseRevision: draft.base_revision }, "read") : null;
        return draft ? { ...(draft.effective_source_revisions ? { effectiveSources: draft.effective_source_revisions as PricingStorageSources } : {}),
          snapshot: snapshot(draft.snapshot, scope.propertyId, draft.base_revision + 1), revision: draft.draft_revision as number,
          baseRevision: draft.base_revision as number, sources: draft.source_revisions as PricingStorageSources, stale: (draft.effective_source_revisions !== null && canonical(projected) !== canonical(draft.effective_source_revisions)) || canonical(draft.source_revisions) !== canonical(sources) || ((await current(client, scope.propertyId))?.revision ?? 0) !== draft.base_revision } : null;
      });
    },
  };
}
