import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingPricingOfferTermsStore, lockBookingPricingOfferTerms, lockBookingPricingTermsSource, lockBookingPricingDraftTerms, parseBookingPricingOfferTerms } from "./bookingPricingOfferTerms.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Booking replacement offer terms PostgreSQL owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const store = createBookingPricingOfferTermsStore(pool);
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const actorUserId = randomUUID(), organizationId = randomUUID(), propertyId = randomUUID(), roomTypeId = randomUUID(), membershipId = randomUUID();
    const roleKey = `terms_test_${randomUUID()}`, scope = { actorUserId, organizationId, propertyId };
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Terms test')", [actorUserId, `${actorUserId}@example.test`]);
    await pool.query("INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Terms test',$2)", [organizationId, organizationId]);
    await pool.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Terms test')", [propertyId]);
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Terms room')", [roomTypeId, propertyId]);
    await pool.query(`INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
      VALUES($1,$2,$3,$4,'all','agency')`, [membershipId, organizationId, actorUserId, roleKey]);
    for (const permission of ["pms.rooms_rates.read", "pms.rooms_rates.manage"]) await pool.query(`INSERT INTO identity.role_permission_grants
      (organization_kind,role_key,permission_key) VALUES('hotel_group',$1,$2)`, [roleKey, permission]);
    for (const [product, type] of [["pms", "pms_property"], ["hotel_catalog", "property"]]) await pool.query(`INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship) VALUES($1,$2,$3,$4,'owner')`, [organizationId, product, type, propertyId]);
    await pool.query("INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')", [organizationId]);
    const context: RequestContext = {
      actor: { internalUserId: actorUserId, email: "terms@example.test", status: "active", providerIdentity: { provider: "workos", providerUserId: "test-user" } },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: { membershipId, roleKey, status: "active", permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"], workosRoleSlugs: [] },
      linkedResources: [{ product: "pms", resourceType: "pms_property", resourceId: propertyId, relationship: "owner", status: "active" }],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      locale: "en", currency: "EUR", audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
    };
    const terms = { roomTypeId, offerId: "flex", cancellation: { kind: "flexible", terms: {
      type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 7, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount",
      flexibleCancellationType: "partial_refund", text: "Full policy text", partialRefundTiers: [{ minDaysBeforeCheckIn: 30, refundPercent: 75 }, { minDaysBeforeCheckIn: 14, refundPercent: 50 }],
    } }, payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 } };
    return { context, scope, terms, command: () => ({ requestId: randomUUID(), expectedRevision: null, terms }) };
  }
  it("round-trips full policy tiers and requested deposits with exactly-once effects", async () => {
    const f = await fixture(), command = f.command();
    const saved = await store.save(f.context, f.scope, command);
    expect(saved).toMatchObject(f.terms);
    expect(await store.read(f.context, f.scope, f.terms.roomTypeId, "flex")).toEqual(saved);
    expect(await store.save(f.context, { ...f.scope, propertyId: f.scope.propertyId.toUpperCase() }, command)).toEqual(saved);
    for (const table of ["domain_events", "product_audit_events", "outbox_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(1);
    }
    await expect(store.save(f.context, f.scope, { ...command, terms: { ...f.terms, payment: { kind: "full" } } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("advances current terms while preserving immutable history and rejects stale references", async () => {
    const f = await fixture(), command = f.command(), first = await store.save(f.context, f.scope, command);
    const changed = { ...f.terms, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } };
    const second = await store.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: first.revision, terms: changed });
    await expect(store.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: first.revision, terms: changed })).rejects.toMatchObject({ code: "stale" });
    expect(await store.save(f.context, f.scope, command)).toEqual(first);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "read")).toBe(true);
      expect(await lockBookingPricingOfferTerms(client, f.scope.propertyId, [first])).toBeNull();
      expect(await lockBookingPricingOfferTerms(client, f.scope.propertyId, [second])).toEqual([second]);
      expect(await lockBookingPricingOfferTerms(client, randomUUID(), [second])).toBeNull();
      expect(await lockBookingPricingOfferTerms(client, f.scope.propertyId, [{ ...second, offerId: "other" }])).toBeNull();
      expect(await lockBookingPricingOfferTerms(client, f.scope.propertyId, [{ ...second, roomTypeId: randomUUID() }])).toBeNull();
      expect(await lockBookingPricingOfferTerms(client, f.scope.propertyId, [second, second])).toBeNull();
      await client.query("ROLLBACK");
      await expect(client.query("UPDATE booking.pricing_v2_offer_terms SET terms='{}' WHERE revision=$1", [first.revision])).rejects.toThrow();
      await expect(client.query("DELETE FROM booking.pricing_v2_offer_terms WHERE revision=$1", [first.revision])).rejects.toThrow();
      await expect(client.query("UPDATE booking.pricing_v2_offer_term_heads SET revision=$1 WHERE property_id=$2", [randomUUID(), f.scope.propertyId])).rejects.toThrow();
      await expect(client.query("TRUNCATE booking.pricing_v2_offer_terms CASCADE")).rejects.toThrow();
      expect((await client.query("SELECT terms FROM booking.pricing_v2_offer_terms WHERE revision=$1", [first.revision])).rows[0].terms).toEqual(first);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("denies unauthenticated, foreign and inactive rooms without owner writes", async () => {
    const f = await fixture(), other = await fixture();
    await expect(store.save(null, f.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    await expect(store.save(other.context, f.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    await expect(store.save(f.context, f.scope, { ...f.command(), terms: { ...f.terms, roomTypeId: other.terms.roomTypeId } })).rejects.toMatchObject({ code: "denied" });
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.terms.roomTypeId]);
    await expect(store.save(f.context, f.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    expect((await pool.query("SELECT count(*)::int AS count FROM booking.pricing_v2_offer_terms WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(0);
  });
  it("rejects invalid term shapes and serializes competing initial saves", async () => {
    const f = await fixture();
    for (const payment of [{ kind: "deposit", basisPoints: 0, balanceDaysBeforeArrival: 7 }, { kind: "full", basisPoints: 3000 },
      { kind: "deposit", basisPoints: 10001, balanceDaysBeforeArrival: 7 }]) {
      expect(parseBookingPricingOfferTerms({ ...f.terms, revision: randomUUID(), payment })).toBeNull();
      await expect(store.save(f.context, f.scope, { ...f.command(), terms: { ...f.terms, payment } })).rejects.toMatchObject({ code: "invalid" });
    }
    const results = await Promise.allSettled([store.save(f.context, f.scope, f.command()), store.save(f.context, f.scope, f.command())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
  });
  it("rolls back the pointer and every new effect if the audit write fails", async () => {
    const f = await fixture(), command = f.command(), key = `booking.pricing_terms:${f.scope.propertyId}:${command.requestId}`;
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'booking','fixture',now(),'property',$2::uuid,'booking','offer_terms',$2::text)`, [key, f.scope.propertyId]);
    await expect(store.save(f.context, f.scope, command)).rejects.toThrow();
    expect(await store.read(f.context, f.scope, f.terms.roomTypeId, "flex")).toBeNull();
    for (const table of ["domain_events", "outbox_events"]) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].count).toBe(0);
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM booking.pricing_v2_offer_terms WHERE property_id=$1", [f.scope.propertyId])).rows[0].count).toBe(0);
  });
  async function locked<T>(f: Awaited<ReturnType<typeof fixture>>, work: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "manage")).toBe(true);
      return await work(client);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  it("stages full policies and new offers without changing active sources or distributing them", async () => {
    const f = await fixture(), active = await store.save(f.context, f.scope, f.command());
    const draft = { draftId: randomUUID(), baseRevision: 0 };
    const before = await locked(f, (c) => lockBookingPricingTermsSource(c, f.scope.propertyId));
    const command = { ...f.command(), expectedRevision: active.revision };
    const [candidate, replay] = await Promise.all([store.stage(f.context, f.scope, command, draft), store.stage(f.context, f.scope, command, draft)]);
    expect(candidate).toEqual(replay); expect(candidate).toMatchObject(f.terms);
    const added = await store.stage(f.context, f.scope, { ...f.command(), terms: { ...f.terms, offerId: "new" } }, draft);
    expect(await store.read(f.context, f.scope, f.terms.roomTypeId, "flex")).toEqual(active);
    expect(await store.read(f.context, f.scope, f.terms.roomTypeId, "new")).toBeNull();
    await locked(f, async (c) => {
      expect(await lockBookingPricingTermsSource(c, f.scope.propertyId)).toBe(before);
      expect(await lockBookingPricingOfferTerms(c, f.scope.propertyId, [candidate])).toBeNull();
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [candidate, added])).toEqual([candidate, added]);
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [active, added])).toEqual([active, added]);
    });
    expect((await pool.query("SELECT event_type FROM platform.domain_events WHERE property_id=$1 ORDER BY event_type", [f.scope.propertyId])).rows.map((r) => r.event_type))
      .toEqual(["booking.pricing_terms.revised", "booking.pricing_terms.staged", "booking.pricing_terms.staged"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].n).toBe(1);
    await expect(store.save(f.context, f.scope, command)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.stage(f.context, f.scope, command, { ...draft, draftId: randomUUID() })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.stage(f.context, f.scope, { ...command, terms: { ...f.terms, payment: { kind: "full" } } }, draft)).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("isolates candidate draft, base, room, property and expected active head", async () => {
    const f = await fixture(), other = await fixture(), active = await store.save(f.context, f.scope, f.command());
    const draft = { draftId: randomUUID(), baseRevision: 0 }, command = { ...f.command(), expectedRevision: active.revision };
    const candidate = await store.stage(f.context, f.scope, command, draft);
    await locked(f, async (c) => {
      for (const selected of [[candidate, candidate], [{ ...candidate, revision: randomUUID() }], [{ ...candidate, roomTypeId: other.terms.roomTypeId }], [{ ...candidate, offerId: "other" }]])
        expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, selected)).toBeNull();
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, { ...draft, draftId: randomUUID() }, [candidate])).toBeNull();
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, { ...draft, baseRevision: 1 }, [candidate])).toBeNull();
      expect(await lockBookingPricingDraftTerms(c, null, f.scope, draft, [candidate])).toBeNull();
    });
    await locked(other, async (c) => expect(await lockBookingPricingDraftTerms(c, other.context, other.scope, draft, [candidate])).toBeNull());
    await store.save(f.context, f.scope, { ...f.command(), expectedRevision: active.revision });
    await locked(f, async (c) => {
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [candidate])).toBeNull();
      expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [active])).toBeNull();
    });
    expect(await store.stage(f.context, f.scope, command, draft)).toEqual(candidate);
    await expect(store.stage(f.context, f.scope, { ...command, requestId: randomUUID() }, draft)).rejects.toMatchObject({ code: "stale" });
  });
  it("rejects invalid/stale/unauthorized staging and protects immutable candidate metadata", async () => {
    const f = await fixture(), other = await fixture(), draft = { draftId: randomUUID(), baseRevision: 0 };
    await expect(store.stage(f.context, f.scope, f.command(), { ...draft, baseRevision: 1 })).rejects.toMatchObject({ code: "stale" });
    for (const invalid of [undefined, null, { ...draft, baseRevision: -1 }, { ...draft, extra: true }])
      await expect(store.stage(f.context, f.scope, f.command(), invalid as typeof draft)).rejects.toMatchObject({ code: "invalid" });
    await expect(store.stage(null, f.scope, f.command(), draft)).rejects.toMatchObject({ code: "denied" });
    await expect(store.stage(other.context, f.scope, f.command(), draft)).rejects.toMatchObject({ code: "denied" });
    await expect(store.stage(f.context, f.scope, { ...f.command(), terms: { ...f.terms, roomTypeId: other.terms.roomTypeId } }, draft)).rejects.toMatchObject({ code: "denied" });
    const candidate = await store.stage(f.context, f.scope, f.command(), draft);
    await expect(pool.query("UPDATE booking.pricing_v2_offer_term_candidates SET draft_id=$1 WHERE revision=$2", [randomUUID(), candidate.revision])).rejects.toThrow();
    await expect(pool.query("DELETE FROM booking.pricing_v2_offer_term_candidates WHERE revision=$1", [candidate.revision])).rejects.toThrow();
    await expect(pool.query("TRUNCATE booking.pricing_v2_offer_term_candidates")).rejects.toThrow();
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.terms.roomTypeId]);
    await expect(store.stage(f.context, f.scope, f.command(), draft)).rejects.toMatchObject({ code: "denied" });
  });
  it("rolls back staged rows and events when their audit fails", async () => {
    const f = await fixture(), command = f.command(), draft = { draftId: randomUUID(), baseRevision: 0 };
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'booking','fixture',now(),'property',$2::uuid,'booking','offer_terms',$2::text)`,
    [`booking.pricing_terms:${f.scope.propertyId}:${command.requestId}`, f.scope.propertyId]);
    await expect(store.stage(f.context, f.scope, command, draft)).rejects.toThrow();
    for (const table of ["booking.pricing_v2_offer_terms", "booking.pricing_v2_offer_term_candidates", "booking.pricing_v2_offer_term_heads", "platform.domain_events", "platform.outbox_events"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].n).toBe(0);
  });

  it("binds candidates to an existing pricing revision and rejects them after pricing advances", async () => {
    const f = await fixture(), draft = { draftId: randomUUID(), baseRevision: 1 };
    async function advance(revision: number) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1) ON CONFLICT DO NOTHING", [f.scope.propertyId]);
        await c.query(`INSERT INTO pms.pricing_v2_revisions(property_id,revision,room_count,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id)
          VALUES($1,$2,0,'EUR','{}','{}',$3,$4,$5)`, [f.scope.propertyId, revision, randomUUID(), "a".repeat(64), f.scope.actorUserId]);
        await c.query("UPDATE pms.pricing_v2_heads SET revision=$2 WHERE property_id=$1", [f.scope.propertyId, revision]);
        await c.query("COMMIT");
      } finally { await c.query("ROLLBACK"); c.release(); }
    }
    await advance(1);
    const command = f.command(), candidate = await store.stage(f.context, f.scope, command, draft);
    await locked(f, async (c) => expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [candidate])).toEqual([candidate]));
    await advance(2);
    await locked(f, async (c) => expect(await lockBookingPricingDraftTerms(c, f.context, f.scope, draft, [candidate])).toBeNull());
    await expect(store.stage(f.context, f.scope, f.command(), draft)).rejects.toMatchObject({ code: "stale" });
    expect(await store.stage(f.context, f.scope, command, draft)).toEqual(candidate);
  });

});
