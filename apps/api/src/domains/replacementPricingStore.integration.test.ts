import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createReplacementPricingStore, type PricingStorageSnapshot } from "./replacementPricingStore.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("replacement pricing PostgreSQL repository", () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const propertyId = randomUUID(), actorUserId = randomUUID(), roomTypeId = randomUUID(), organizationId = randomUUID();
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Pricing test')", [actorUserId, `${actorUserId}@example.test`]);
    await pool.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Pricing test')", [propertyId]);
    await pool.query("INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Room',100,'EUR')", [roomTypeId, propertyId]);
    const scope = { propertyId, actorUserId, organizationId };
    let policy = "1", conversion = false;
    const sources = () => ({ room: "1", guest: policy, currency: "1", terms: "1", finance: "1" });
    const store = createReplacementPricingStore(pool, {
      async lock(client, candidate) {
        if (candidate.organizationId !== organizationId || candidate.actorUserId !== actorUserId || candidate.propertyId !== propertyId) return null;
        await client.query("SELECT id FROM pms.room_types WHERE property_id=$1 FOR SHARE", [propertyId]);
        return sources();
      },
      async allowCurrencyChange(_client, _scope, before, after) {
        return conversion && before.currency === "EUR" && after.currency === "USD" && after.ownerReferences.fx === "verified-fx-2";
      },
    });
    const snapshot = (revision: number): PricingStorageSnapshot => ({ currency: "EUR", ownerReferences: { terms: "terms-1", finance: "finance-1", fx: "same-currency" }, rooms: [{
      version: "pricing.v2", propertyId, roomTypeId, revision, currency: "EUR", capacity: { total: 3, adults: 3, children: 1 },
      children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }] },
      offers: [{ id: "flex", termsRevision: "terms-1", meal: { kind: "half_board", charge: { kind: "person", adultMinor: "1500", childBandAmountsMinor: ["500"] } },
        price: { kind: "independent", calendar: { base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] },
          months: [], seasons: [], weekdays: [], dates: [] } },
        restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
    }] });
    const command = (expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision, sources: sources(), snapshot: snapshot(expectedRevision + 1) });
    return { scope, store, snapshot, command, sources, changeSources: () => { policy = "2"; }, allowConversion: () => { conversion = true; } };
  }
  it("round-trips complete independent tables and emits effects exactly once on replay", async () => {
    const f = await fixture(), command = f.command();
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: false });
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: true });
    expect(await f.store.read(f.scope)).toMatchObject({ ...command.snapshot, revision: 1, stale: false });
    for (const table of ["domain_events", "product_audit_events", "outbox_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(1);
    }
    await expect(f.store.save(f.scope, { ...command, snapshot: { ...command.snapshot, ownerReferences: { terms: "changed" } } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("serializes competing writes and rolls back a failed effect without moving the head", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.store.save(f.scope, f.command()), f.store.save(f.scope, f.command())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
    const next = f.command(1);
    // Force the existing platform uniqueness constraint to fail during the final audit write.
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'pms','fixture',now(),'property',$2::uuid,'pms','pricing_revision',$2::text)`,
    [`pricing.v2:${f.scope.propertyId}:pricing.v2.revised:${next.requestId}`, f.scope.propertyId]);
    await expect(f.store.save(f.scope, next)).rejects.toThrow();
    expect((await f.store.read(f.scope))?.revision).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM pms.pricing_v2_revisions WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(1);
  });
  it("denies foreign scopes and stale sources, and flags invalidated drafts", async () => {
    const f = await fixture(), draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) };
    expect(await f.store.saveDraft(f.scope, draft)).toBe(1);
    expect(await f.store.saveDraft(f.scope, draft)).toBe(1);
    expect(await f.store.read(f.scope)).toBeNull();
    await expect(f.store.read({ ...f.scope, organizationId: randomUUID() })).rejects.toMatchObject({ code: "denied" });
    await expect(f.store.save({ ...f.scope, propertyId: randomUUID() }, { ...f.command(), snapshot: { ...f.snapshot(1), rooms: [] } })).rejects.toMatchObject({ code: "denied" });
    const old = f.command(); f.changeSources();
    await expect(f.store.save(f.scope, old)).rejects.toMatchObject({ code: "stale" });
    expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ stale: true, revision: 1 });
  });
  it("replaces modes and explicitly clears optional schedules without changing historical prices", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command());
    const changed = f.snapshot(2), room = changed.rooms[0], offer = room.offers[0];
    const replacement = { ...changed, rooms: [{ ...room, offers: [{ ...offer, price: { kind: "independent", calendar: {
      base: { mode: "per_person", unitMinor: "6000" }, months: [{ month: 7, price: { mode: "per_person", unitMinor: "7000" } }], seasons: [], weekdays: [], dates: [] } } }] }] };
    await f.store.save(f.scope, { ...f.command(1), snapshot: replacement });
    const read = await f.store.read(f.scope);
    expect(read?.rooms[0].offers[0].price).toEqual(replacement.rooms[0].offers[0].price);
    expect((await pool.query("SELECT configuration FROM pms.pricing_v2_rooms WHERE property_id=$1 AND revision=1", [f.scope.propertyId])).rows[0].configuration).toEqual(f.snapshot(1).rooms[0]);
    await f.store.save(f.scope, { ...f.command(2), snapshot: f.snapshot(3) });
    expect((await f.store.read(f.scope))?.rooms[0].offers[0].meal).toEqual(offer.meal);
  });
  it("rejects cross-property room references without leaving a head or effects", async () => {
    const f = await fixture(), other = await fixture(), input = f.snapshot(1);
    await expect(f.store.save(f.scope, { ...f.command(), snapshot: { ...input,
      rooms: [{ ...input.rooms[0], roomTypeId: other.snapshot(1).rooms[0].roomTypeId }] } })).rejects.toThrow();
    expect(await f.store.read(f.scope)).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.domain_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(0);
  });
  it("requires conversion owner approval and atomically replaces currency and all room snapshots", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command());
    const eur = f.snapshot(2);
    const usd = { ...eur, currency: "USD", ownerReferences: { ...eur.ownerReferences, fx: "verified-fx-2" }, rooms: eur.rooms.map((r) => ({ ...r, currency: "USD",
      children: { ...r.children, bands: r.children.bands.map((b) => ({ ...b, nightlyMinor: "2200" })) },
      offers: r.offers.map((o) => ({ ...o, meal: { kind: "half_board", charge: { kind: "person", adultMinor: "1650", childBandAmountsMinor: ["550"] } },
        price: { kind: "independent", calendar: { base: { mode: "occupancy", amountsMinor: ["11000", "14300", "17050"] }, months: [], seasons: [], weekdays: [], dates: [] } } })) })) };
    const command = { ...f.command(1), snapshot: usd };
    await expect(f.store.save(f.scope, command)).rejects.toMatchObject({ code: "currency_conversion_required" });
    expect((await f.store.read(f.scope))?.currency).toBe("EUR");
    f.allowConversion(); await f.store.save(f.scope, command);
    expect(await f.store.read(f.scope)).toMatchObject({ currency: "USD", revision: 2, rooms: [{ currency: "USD" }] });
  });
});
