import { createHash } from "node:crypto";
import { parsePricingConfiguration, pricingCurrencyScale, pricingInteger, pricingKeys, pricingObject,
  type PricingConfiguration } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

export type PricingStorageScope = Readonly<{ propertyId: string; organizationId: string; actorUserId: string }>;
export type PricingStorageSources = Readonly<Record<string, string>>;
export type PricingStorageSnapshot = Readonly<{ currency: string; rooms: readonly PricingConfiguration[];
  ownerReferences: PricingStorageSources }>;
export type StoredPricingRevision = PricingStorageSnapshot & Readonly<{ revision: number; sources: PricingStorageSources }>;
export interface PricingStorageGuard {
  /** Authenticate scope; validate every proposed room/owner/terms reference against its owner;
   * lock the validated sources until transaction end. proposed=null for reads. No default allow. */
  lock(client: PoolClient, scope: PricingStorageScope, proposed: PricingStorageSnapshot | null): Promise<PricingStorageSources | null>;
  /** Verify complete conversion of every room AND owner-owned amount, with authoritative FX evidence. */
  allowCurrencyChange(client: PoolClient, scope: PricingStorageScope, before: StoredPricingRevision,
    after: PricingStorageSnapshot): Promise<boolean>;
}
export class PricingStorageError extends Error {
  constructor(readonly code: "invalid" | "denied" | "stale" | "idempotency_conflict" | "currency_conversion_required") { super(code); }
}
const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fail = (code: PricingStorageError["code"]): never => { throw new PricingStorageError(code); };
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim();
const references = (v: unknown): v is PricingStorageSources => pricingObject(v) && Object.keys(v).length > 0 && Object.entries(v).every(([k, x]) => text(k) && text(x));
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => pricingObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
function snapshot(value: unknown, propertyId: string, revision: number): PricingStorageSnapshot {
  if (!pricingObject(value) || !pricingKeys(value, ["currency", "rooms", "ownerReferences"]) ||
      typeof value.currency !== "string" || pricingCurrencyScale(value.currency) === null || !references(value.ownerReferences) || !Array.isArray(value.rooms)) return fail("invalid");
  const rooms = Array.from(value.rooms, parsePricingConfiguration);
  if (rooms.some((r) => !r || r.propertyId !== propertyId || r.revision !== revision || r.currency !== value.currency) ||
      new Set(rooms.map((r) => r!.roomTypeId)).size !== rooms.length) return fail("invalid");
  return structuredClone({ currency: value.currency, rooms: rooms as PricingConfiguration[], ownerReferences: value.ownerReferences });
}
/** Infrastructure primitive only. Routes/preview/publication orchestration belong to VAY-1541. */
export function createReplacementPricingStore(pool: Pool, guard: PricingStorageGuard) {
  async function transaction<T>(scope: PricingStorageScope, proposed: PricingStorageSnapshot | null, work: (client: PoolClient, sources: PricingStorageSources) => Promise<T>): Promise<T> {
    if (![scope.propertyId, scope.organizationId, scope.actorUserId].every(uuid)) return fail("invalid");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockPmsInventoryMutationScope(client, scope.propertyId);
      const sources = await guard.lock(client, scope, proposed);
      if (!sources) return fail("denied");
      if (!references(sources)) return fail("invalid");
      const result = await work(client, sources);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async function current(client: PoolClient, propertyId: string): Promise<StoredPricingRevision | null> {
    const row = (await client.query(`SELECT r.revision,r.currency,r.source_revisions,r.owner_references
      FROM pms.pricing_v2_heads h JOIN pms.pricing_v2_revisions r USING(property_id,revision) WHERE h.property_id=$1`, [propertyId])).rows[0];
    if (!row) return null;
    const rooms = (await client.query("SELECT configuration FROM pms.pricing_v2_rooms WHERE property_id=$1 AND revision=$2 ORDER BY room_type_id", [propertyId, row.revision])).rows.map((r) => r.configuration);
    return { ...snapshot({ currency: row.currency, ownerReferences: row.owner_references, rooms }, propertyId, row.revision), revision: row.revision, sources: row.source_revisions };
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
      return transaction(scope, null, async (client, sources) => {
        const result = await current(client, scope.propertyId);
        return result && { ...result, stale: canonical(result.sources) !== canonical(sources) };
      });
    },
    save(scope: PricingStorageScope, input: { requestId: string; expectedRevision: number; sources: PricingStorageSources; snapshot: unknown }) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!text(input.requestId) || input.requestId.length > 200 || !pricingInteger(input.expectedRevision) || input.expectedRevision >= 2147483647 || !references(input.sources)) return Promise.reject(new PricingStorageError("invalid"));
      const next = snapshot(input.snapshot, scope.propertyId, input.expectedRevision + 1);
      const command = structuredClone({ ...input, snapshot: next });
      const hash = createHash("sha256").update(canonical({ ...command, scope })).digest("hex");
      return transaction(scope, next, async (client, sources) => {
        const prior = (await client.query("SELECT revision,request_hash FROM pms.pricing_v2_revisions WHERE property_id=$1 AND request_id=$2", [scope.propertyId, command.requestId])).rows[0];
        if (prior) { if (prior.request_hash !== hash) return fail("idempotency_conflict"); return { revision: prior.revision as number, replayed: true }; }
        if (canonical(sources) !== canonical(command.sources)) return fail("stale");
        const previous = await current(client, scope.propertyId);
        if ((previous?.revision ?? 0) !== command.expectedRevision) return fail("stale");
        if (previous && previous.currency !== next.currency && !await guard.allowCurrencyChange(client, scope, previous, next)) return fail("currency_conversion_required");
        await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1) ON CONFLICT DO NOTHING", [scope.propertyId]);
        const revision = command.expectedRevision + 1;
        await client.query(`INSERT INTO pms.pricing_v2_revisions
          (property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scope.propertyId, revision, next.currency, canonical(sources), canonical(next.ownerReferences), command.requestId, hash, scope.actorUserId, next.rooms.length]);
        for (const room of next.rooms) await client.query(`INSERT INTO pms.pricing_v2_rooms
          (property_id,revision,room_type_id,currency,configuration) VALUES($1,$2,$3,$4,$5)`, [scope.propertyId, revision, room.roomTypeId, next.currency, JSON.stringify(room)]);
        await client.query("UPDATE pms.pricing_v2_heads SET revision=$2 WHERE property_id=$1", [scope.propertyId, revision]);
        await effects(client, scope, revision, "pricing.v2.revised", command.requestId, true);
        return { revision, replayed: false };
      });
    },
    saveDraft(scope: PricingStorageScope, input: { draftId: string; expectedDraftRevision: number; baseRevision: number; sources: PricingStorageSources; snapshot: unknown }) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!uuid(input.draftId) || !pricingInteger(input.expectedDraftRevision) || input.expectedDraftRevision >= 2147483647 || !pricingInteger(input.baseRevision) || input.baseRevision >= 2147483647 || !references(input.sources)) return Promise.reject(new PricingStorageError("invalid"));
      const next = snapshot(input.snapshot, scope.propertyId, input.baseRevision + 1);
      const command = structuredClone({ ...input, snapshot: next });
      return transaction(scope, next, async (client, sources) => {
        if (canonical(sources) !== canonical(command.sources) || ((await current(client, scope.propertyId))?.revision ?? 0) !== command.baseRevision) return fail("stale");
        const previous = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2", [scope.propertyId, command.draftId])).rows[0];
        if (previous?.draft_revision === command.expectedDraftRevision + 1 && previous.base_revision === command.baseRevision && canonical(previous.snapshot) === canonical(next) && canonical(previous.source_revisions) === canonical(sources)) return previous.draft_revision as number;
        if ((previous?.draft_revision ?? 0) !== command.expectedDraftRevision) return fail("stale");
        await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1) ON CONFLICT DO NOTHING", [scope.propertyId]);
        const revision = command.expectedDraftRevision + 1;
        await client.query(`INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(property_id,draft_id) DO UPDATE SET
          draft_revision=$3,base_revision=$4,source_revisions=$5,snapshot=$6,actor_user_id=$7`,
        [scope.propertyId, command.draftId, revision, command.baseRevision, canonical(sources), canonical(next), scope.actorUserId]);
        await effects(client, scope, revision, "pricing.v2.drafted", `${command.draftId}:${revision}`, false);
        return revision;
      });
    },
    readDraft(scope: PricingStorageScope, draftId: string) {
      scope = { propertyId: scope.propertyId.toLowerCase(), organizationId: scope.organizationId.toLowerCase(), actorUserId: scope.actorUserId.toLowerCase() };
      if (!uuid(draftId)) return Promise.reject(new PricingStorageError("invalid"));
      return transaction(scope, null, async (client, sources) => {
        const draft = (await client.query("SELECT * FROM pms.pricing_v2_drafts WHERE property_id=$1 AND draft_id=$2", [scope.propertyId, draftId])).rows[0];
        return draft ? { snapshot: snapshot(draft.snapshot, scope.propertyId, draft.base_revision + 1), revision: draft.draft_revision as number,
          baseRevision: draft.base_revision as number, stale: canonical(draft.source_revisions) !== canonical(sources) || ((await current(client, scope.propertyId))?.revision ?? 0) !== draft.base_revision } : null;
      });
    },
  };
}
