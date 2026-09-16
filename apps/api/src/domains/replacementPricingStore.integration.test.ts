import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { convertPricingConfigurationCurrency, type PricingConversionRate } from "@vayada/domain-pms";
import { createReplacementPricingStore, type PricingStorageSnapshot } from "./replacementPricingStore.js";
import { createReplacementPricingFxStore } from "./replacementPricingFxStore.js";
import { readCurrentPricingSnapshot, PricingStorageError } from "./replacementPricingSnapshot.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
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
    let policy = "1", conversion = false, authorized = true, termsRevision = "1";
    const sources = () => ({ room: "1", guest: policy, currency: "1", terms: termsRevision, finance: "1" });
    const store = createReplacementPricingStore(pool, {
      async lock(_client, candidate) {
        if (!authorized || candidate.organizationId !== organizationId || candidate.actorUserId !== actorUserId || candidate.propertyId !== propertyId) return null;
        return sources();
      },
      async validate(client, _scope, proposed) {
        const owned = (await client.query("SELECT id FROM pms.room_types WHERE property_id=$1 FOR SHARE", [propertyId])).rows.map((r) => r.id);
        return proposed.ownerReferences.terms === `terms-${termsRevision}` &&
          proposed.rooms.every((r) => owned.includes(r.roomTypeId) && r.offers.every((o) => o.termsRevision === `terms-${termsRevision}`));
      },
      // Deliberately permissive owner fixture: this does not establish real owner approval.
      async allowCurrencyChange() { return conversion; },
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
    return { scope, store, snapshot, command, sources, changeSources: () => { policy = "2"; }, allowConversion: () => { conversion = true; },
      changeTerms: () => { termsRevision = "2"; }, revokeAccess: () => { authorized = false; } };
  }
  it("uses the caller transaction and never substitutes a foreign property publication", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command());
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await lockPmsInventoryMutationScope(client, f.scope.propertyId);
      expect(await readCurrentPricingSnapshot(client, randomUUID())).toBeNull();
      expect(await readCurrentPricingSnapshot(client, f.scope.propertyId)).toMatchObject({ revision: 1, rooms: f.snapshot(1).rooms });
      await client.query("UPDATE pms.pricing_v2_heads SET revision=0 WHERE property_id=$1", [f.scope.propertyId]);
      expect(await readCurrentPricingSnapshot(client, f.scope.propertyId)).toBeNull();
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await f.store.read(f.scope))?.revision).toBe(1);
  });
  it.each(["dangling_head", "room_count", "missing_room", "sources", "owners", "configuration"])(
    "rejects an uncommitted malformed publication: %s", async (fault) => {
    const f = await fixture(); await f.store.save(f.scope, f.command());
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await lockPmsInventoryMutationScope(client, f.scope.propertyId);
      // Published revisions are immutable. Stage malformed NEW rows under deferred
      // constraints, then always roll back; no schema guards are disabled.
      if (fault !== "dangling_head") {
        const next = f.snapshot(2), config = next.rooms[0];
        await client.query(`INSERT INTO pms.pricing_v2_revisions
          (property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count)
          VALUES($1,2,'EUR',$2,$3,$4,$5,$6,$7)`, [f.scope.propertyId,
          JSON.stringify(fault === "sources" ? {} : f.sources()), JSON.stringify(fault === "owners" ? {} : next.ownerReferences),
          randomUUID(), "a".repeat(64), f.scope.actorUserId, fault === "room_count" ? 2 : 1]);
        if (fault !== "missing_room") await client.query(`INSERT INTO pms.pricing_v2_rooms
          (property_id,revision,room_type_id,currency,configuration) VALUES($1,2,$2,'EUR',$3)`, [f.scope.propertyId, config.roomTypeId,
          JSON.stringify(fault === "configuration" ? { ...config, children: { adultFromAge: -1, bands: [] } } : config)]);
      }
      await client.query("UPDATE pms.pricing_v2_heads SET revision=2 WHERE property_id=$1", [f.scope.propertyId]);
      await expect(readCurrentPricingSnapshot(client, f.scope.propertyId)).rejects.toBeInstanceOf(PricingStorageError);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await f.store.read(f.scope))?.revision).toBe(1);
  });
  async function fx(expirySeconds = 3600, target = "USD") {
    const time = Math.floor((await pool.query("SELECT extract(epoch FROM clock_timestamp())::double precision AS time")).rows[0].time);
    const body = JSON.stringify({ result: "success", provider: "https://www.exchangerate-api.com", base_code: "EUR", time_eol_unix: 0,
      time_last_update_unix: time - 60, time_next_update_unix: time + expirySeconds, rates: { EUR: 1, USD: 1.1, JPY: 160 } });
    const rate = await createReplacementPricingFxStore(pool, { fetch: async () => new Response(body), now: () => time * 1000 }).observe("EUR", target);
    expect(rate).not.toBeNull(); return rate!;
  }
  function converted(before: PricingStorageSnapshot, rate: PricingConversionRate): PricingStorageSnapshot {
    return { currency: rate.to, ownerReferences: { ...before.ownerReferences, fx: rate.id },
      rooms: before.rooms.map((room) => convertPricingConfigurationCurrency(room, rate, Date.parse(rate.observedAt))!) };
  }
  it("round-trips complete independent tables and emits effects exactly once on replay", async () => {
    const f = await fixture(), command = f.command();
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: false });
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: true });
    expect(await f.store.read(f.scope)).toMatchObject({ ...command.snapshot, revision: 1, stale: false });
    for (const table of ["domain_events", "product_audit_events", "outbox_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(1);
    }
    await expect(f.store.save(f.scope, { ...command, snapshot: { ...command.snapshot, rooms: [] } })).rejects.toMatchObject({ code: "idempotency_conflict" });
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
  it("replays authorized historical publication after owner changes but validates every new write", async () => {
    const f = await fixture(), draftId = randomUUID();
    await f.store.saveDraft(f.scope, { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) });
    const command = { ...f.command(), draft: { id: draftId, revision: 1 } };
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: false });
    f.changeTerms();
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 1, replayed: true });
    await expect(f.store.save(f.scope, { ...command, sources: f.sources() })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(f.store.save(f.scope, f.command(1))).rejects.toMatchObject({ code: "denied" });
    await expect(f.store.saveDraft(f.scope, { draftId, expectedDraftRevision: 1, baseRevision: 1, sources: f.sources(), snapshot: f.snapshot(2) })).rejects.toMatchObject({ code: "denied" });
    expect(await f.store.read(f.scope)).toMatchObject({ revision: 1, stale: true });
    expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ revision: 1, baseRevision: 0 });
    for (const [table, count] of [["domain_events", 2], ["product_audit_events", 2], ["outbox_events", 1]])
      expect((await pool.query(`SELECT count(*)::int AS count FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(count);
    f.revokeAccess();
    await expect(f.store.save(f.scope, command)).rejects.toMatchObject({ code: "denied" });
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
  it("validates draft room and terms references before storing any data", async () => {
    const f = await fixture(), other = await fixture(), input = f.snapshot(1), room = input.rooms[0];
    const draft = { draftId: randomUUID(), expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: input };
    for (const invalid of [
      { ...input, ownerReferences: { terms: "foreign-terms" } },
      { ...input, rooms: [{ ...room, roomTypeId: other.snapshot(1).rooms[0].roomTypeId }] },
      { ...input, rooms: [{ ...room, offers: [{ ...room.offers[0], termsRevision: "foreign-terms" }] }] },
    ]) await expect(f.store.saveDraft(f.scope, { ...draft, snapshot: invalid })).rejects.toMatchObject({ code: "denied" });
    expect(await f.store.readDraft(f.scope, draft.draftId)).toBeNull();
  });
  it("serializes equivalent mixed-case UUIDs during competing initial draft writes", async () => {
    const f = await fixture();
    const draft = { draftId: randomUUID(), expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) };
    const results = await Promise.allSettled([
      f.store.saveDraft(f.scope, draft),
      f.store.saveDraft({ ...f.scope, propertyId: f.scope.propertyId.toUpperCase() }, { ...draft, snapshot: { ...draft.snapshot, rooms: [] } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
    expect(await f.store.readDraft(f.scope, draft.draftId)).toMatchObject({ revision: 1 });
  });
  it("requires conversion owner approval and atomically replaces currency and all room snapshots", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command());
    const eur = f.snapshot(2), rate = await fx();
    const usd = { ...eur, currency: "USD", ownerReferences: { ...eur.ownerReferences, fx: rate.id }, rooms: eur.rooms.map((r) => ({ ...r, currency: "USD",
      children: { ...r.children, bands: r.children.bands.map((b) => ({ ...b, nightlyMinor: "2200" })) },
      offers: r.offers.map((o) => ({ ...o, meal: { kind: "half_board", charge: { kind: "person", adultMinor: "1650", childBandAmountsMinor: ["550"] } },
        price: { kind: "independent", calendar: { base: { mode: "occupancy", amountsMinor: ["11000", "14300", "17050"] }, months: [], seasons: [], weekdays: [], dates: [] } } })) })) };
    const command = { ...f.command(1), snapshot: usd };
    await expect(f.store.save(f.scope, command)).rejects.toMatchObject({ code: "currency_conversion_required" });
    expect((await f.store.read(f.scope))?.currency).toBe("EUR");
    f.allowConversion(); await f.store.save(f.scope, command);
    expect(await f.store.read(f.scope)).toMatchObject({ currency: "USD", revision: 2, rooms: [{ currency: "USD" }] });
  });
  it("rejects missing/wrong FX and partial or edited multi-room conversion even with owner approval", async () => {
    const f = await fixture(), initial = f.command(), room = initial.snapshot.rooms[0], secondId = randomUUID();
    await pool.query("INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Second',100,'EUR')", [secondId, f.scope.propertyId]);
    const before = { ...initial.snapshot, rooms: [room, { ...room, roomTypeId: secondId }] };
    await f.store.save(f.scope, { ...initial, snapshot: before }); f.allowConversion();
    const rate = await fx(), usd = converted(before, rate), otherRate = await fx(3600, "JPY");
    const variants = [
      { ...usd, ownerReferences: { ...usd.ownerReferences, fx: "verified-fx-2" } },
      { ...usd, ownerReferences: { ...usd.ownerReferences, fx: `exchange-rate-api:${"a".repeat(64)}` } },
      { ...usd, ownerReferences: { ...usd.ownerReferences, fx: otherRate.id } },
      { ...usd, rooms: usd.rooms.slice(0, 1) },
      { ...usd, rooms: before.rooms.map((r) => ({ ...r, currency: "USD", revision: 2 })) },
      { ...usd, rooms: usd.rooms.map((r) => ({ ...r, children: room.children })) },
      { ...usd, rooms: usd.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => ({ ...o, meal: room.offers[0].meal })) })) },
      { ...usd, rooms: usd.rooms.map((r) => ({ ...r, capacity: { ...r.capacity, children: 2 } })) },
    ];
    for (const snapshot of variants)
      await expect(f.store.save(f.scope, { ...f.command(1), snapshot })).rejects.toMatchObject({ code: "currency_conversion_required" });
    expect((await f.store.read(f.scope))?.revision).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(1);
    await f.store.save(f.scope, { ...f.command(1), snapshot: { ...usd, rooms: [...usd.rooms].reverse() } });
    expect((await f.store.read(f.scope))?.rooms).toHaveLength(2);
  });
  it("replays the exact bound currency-change receipt after FX expiry but rejects new expired conversions", async () => {
    const f = await fixture(), unpublished = await fixture(), draftId = randomUUID();
    await f.store.save(f.scope, f.command()); await unpublished.store.save(unpublished.scope, unpublished.command());
    f.allowConversion(); unpublished.allowConversion();
    const rate = await fx(3), usd = converted(f.snapshot(1), rate);
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 1, sources: f.sources(), snapshot: usd };
    await f.store.saveDraft(f.scope, draft);
    const command = { ...f.command(1), snapshot: usd, draft: { id: draftId, revision: 1 } };
    await expect(f.store.save(f.scope, { ...command, snapshot: { ...usd, ownerReferences: { ...usd.ownerReferences, fx: "changed" } } })).rejects.toMatchObject({ code: "stale" });
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 2, replayed: false });
    await pool.query("SELECT pg_sleep(3.1)");
    expect(await f.store.save(f.scope, command)).toEqual({ revision: 2, replayed: true });
    await expect(f.store.save(f.scope, { ...command, snapshot: { ...usd, ownerReferences: { ...usd.ownerReferences, fx: "changed" } } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(unpublished.store.save(unpublished.scope, { ...unpublished.command(1), snapshot: converted(unpublished.snapshot(1), rate) })).rejects.toMatchObject({ code: "currency_conversion_required" });
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(2);
  }, 10_000);
  it("rolls back every publication write if FX expires during the final outbox effect", async () => {
    const f = await fixture(), draftId = randomUUID(); await f.store.save(f.scope, f.command()); f.allowConversion();
    // Property-scoped trigger delays the real final write, after initial FX and owner approval.
    const name = `pricing_fx_delay_${f.scope.propertyId.replaceAll("-", "")}`;
    await pool.query(`CREATE SEQUENCE platform.${name}`);
    await pool.query(`CREATE FUNCTION platform.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM nextval('platform.${name}'); PERFORM pg_sleep(3.1); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON platform.outbox_events
      FOR EACH ROW WHEN (NEW.property_id='${f.scope.propertyId}'::uuid) EXECUTE FUNCTION platform.${name}()`);
    try {
      const rate = await fx(3), usd = converted(f.snapshot(1), rate);
      await f.store.saveDraft(f.scope, { draftId, expectedDraftRevision: 0, baseRevision: 1, sources: f.sources(), snapshot: usd });
      await expect(f.store.save(f.scope, { ...f.command(1), snapshot: usd, draft: { id: draftId, revision: 1 } })).rejects.toMatchObject({ code: "currency_conversion_required" });
      // Sequence increments survive rollback: prove the delayed outbox write was actually reached.
      expect((await pool.query(`SELECT is_called FROM platform.${name}`)).rows[0].is_called).toBe(true);
      expect(await f.store.read(f.scope)).toMatchObject({ revision: 1, currency: "EUR" });
      expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ revision: 1, stale: false, snapshot: usd });
      for (const [schema, table, count] of [["pms", "pricing_v2_revisions", 1], ["pms", "pricing_v2_rooms", 1],
        ["platform", "domain_events", 2], ["platform", "product_audit_events", 2], ["platform", "outbox_events", 1]])
        expect((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(count);
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON platform.outbox_events`);
      await pool.query(`DROP FUNCTION platform.${name}()`);
      await pool.query(`DROP SEQUENCE platform.${name}`);
    }
  }, 10_000);
  it("binds publication to saved draft contents and replays its receipt after later edits", async () => {
    const f = await fixture(), draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) };
    await f.store.saveDraft(f.scope, draft);
    expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ sources: f.sources() });
    const publish = { ...f.command(), draft: { id: draftId, revision: 1 } };
    expect(await f.store.save(f.scope, publish)).toEqual({ revision: 1, replayed: false });
    await f.store.saveDraft(f.scope, { ...draft, expectedDraftRevision: 1, baseRevision: 1, snapshot: f.snapshot(2) });
    expect(await f.store.save(f.scope, { ...publish, draft: { ...publish.draft, id: draftId.toUpperCase() } })).toEqual({ revision: 1, replayed: true });
    await expect(f.store.save(f.scope, { ...publish, draft: { id: draftId, revision: 2 } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(1);
  });
  it("rejects missing, mismatched, edited and foreign drafts without publication effects", async () => {
    const f = await fixture(), other = await fixture(), draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) };
    await f.store.saveDraft(f.scope, draft);
    const publish = { ...f.command(), draft: { id: draftId, revision: 1 } };
    for (const input of [
      { ...publish, draft: { id: randomUUID(), revision: 1 } },
      { ...publish, draft: { id: draftId, revision: 2 } },
      { ...publish, snapshot: { ...publish.snapshot, rooms: [] } },
      { ...publish, sources: { ...publish.sources, guest: "wrong" } },
      { ...publish, expectedRevision: 1, snapshot: f.snapshot(2) },
    ]) await expect(f.store.save(f.scope, input)).rejects.toMatchObject({ code: "stale" });
    await expect(other.store.save(other.scope, { ...other.command(), draft: publish.draft })).rejects.toMatchObject({ code: "stale" });
    await f.store.saveDraft(f.scope, { ...draft, expectedDraftRevision: 1, snapshot: { ...draft.snapshot, rooms: [] } });
    await expect(f.store.save(f.scope, publish)).rejects.toMatchObject({ code: "stale" });
    expect(await f.store.read(f.scope)).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(0);
  });
  it("serializes draft edits and publication of the reviewed version", async () => {
    const f = await fixture(), draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) };
    await f.store.saveDraft(f.scope, draft);
    const results = await Promise.allSettled([
      f.store.save(f.scope, { ...f.command(), draft: { id: draftId, revision: 1 } }),
      f.store.saveDraft(f.scope, { ...draft, expectedDraftRevision: 1, snapshot: { ...draft.snapshot, rooms: [] } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
    const active = await f.store.read(f.scope);
    if (active) expect(active.rooms).toEqual(draft.snapshot.rooms);
    else expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ revision: 2, snapshot: { rooms: [] } });
  });
  it("rolls back bound publication effects and preserves the draft for another request", async () => {
    const f = await fixture(), draftId = randomUUID();
    await f.store.saveDraft(f.scope, { draftId, expectedDraftRevision: 0, baseRevision: 0, sources: f.sources(), snapshot: f.snapshot(1) });
    const publish = { ...f.command(), draft: { id: draftId, revision: 1 } };
    const key = `pricing.v2:${f.scope.propertyId}:pricing.v2.revised:${publish.requestId}`;
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'pms','fixture',now(),'property',$2::uuid,'pms','pricing_revision',$2::text)`, [key, f.scope.propertyId]);
    await expect(f.store.save(f.scope, publish)).rejects.toThrow();
    expect(await f.store.read(f.scope)).toBeNull();
    expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ revision: 1, stale: false });
    expect((await pool.query("SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(0);
    expect(await f.store.save(f.scope, { ...publish, requestId: randomUUID() })).toEqual({ revision: 1, replayed: false });
  });

});
