import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingPricingOfferTermsStore } from "./bookingPricingOfferTerms.js";
import { createReplacementChargeDeclarationStore, lockReplacementChargeDeclaration, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot } from "./replacementPricingStore.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Replacement mandatory-charge declarations PostgreSQL owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const store = createReplacementChargeDeclarationStore(pool);
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
    const saved = await createBookingPricingOfferTermsStore(pool).save(context, scope, { requestId: randomUUID(), expectedRevision: null, terms });
    const snapshot: PricingStorageSnapshot = { currency: "EUR", ownerReferences: { terms: saved.revision, finance: "finance-1" }, rooms: [{
      version: "pricing.v2", propertyId, roomTypeId, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
      children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
      offers: [{ id: "flex", termsRevision: saved.revision, meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
        restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] } }],
    }] };
    const sources = { room: "1", terms: saved.revision, finance: "1" }, draftId = randomUUID();
    // Seed the saved-draft boundary; the complete publication guard is a separate integration.
    await pool.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [propertyId]);
    await pool.query(`INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id)
      VALUES($1,$2,1,0,$3,$4,$5)`, [propertyId, draftId, sources, snapshot, actorUserId]);
    const command = () => ({ draftId, expectedDraftRevision: 1, claimedFingerprint: replacementChargeFingerprint(propertyId, snapshot, sources)!,
      declaration: "all_mandatory_charges_included" as const, requestId: randomUUID() });
    return { context, scope, terms, saved, snapshot, sources, draftId, command };

  }
  it("requires explicit confirmation, replays once, and binds commercial data without a circular self-reference", async () => {
    const f = await fixture(), command = f.command(), client = await pool.connect();
    try {
      expect(await lockReplacementChargeDeclaration(client, f.scope.propertyId, randomUUID(), f.snapshot, f.sources)).toBeNull();
      await expect(store.confirm(f.context, f.scope, { ...command, declaration: undefined! })).rejects.toMatchObject({ code: "invalid" });
      const [first, replay] = await Promise.all([store.confirm(f.context, f.scope, command), store.confirm(f.context, f.scope, command)]);
      expect(replay).toEqual(first);
      const attached = { ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: first.id } };
      expect(await lockReplacementChargeDeclaration(client, f.scope.propertyId, first.id, attached, { ...f.sources, charges: first.id })).toEqual(first);
      expect(await lockReplacementChargeDeclaration(client, randomUUID(), first.id, attached, f.sources)).toBeNull();
      expect(await lockReplacementChargeDeclaration(client, f.scope.propertyId, first.id, attached, { ...f.sources, finance: "2" })).toBeNull();
      for (const changed of [
        { ...attached, ownerReferences: { ...attached.ownerReferences, finance: "2" } },
        { ...attached, rooms: attached.rooms.map((r) => ({ ...r, revision: 2 })) },
        { ...attached, rooms: attached.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => ({ ...o, termsRevision: randomUUID() })) })) },
        { ...attached, rooms: attached.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => ({ ...o, price: { kind: "independent", calendar: {
          base: { mode: "flat", amountMinor: "11000" }, months: [], seasons: [], weekdays: [], dates: [] } } })) })) },
      ] satisfies PricingStorageSnapshot[]) expect(await lockReplacementChargeDeclaration(client, f.scope.propertyId, first.id, changed, f.sources)).toBeNull();
      for (const table of ["domain_events", "product_audit_events", "outbox_events"]) {
        expect((await pool.query(`SELECT count(*)::int AS n FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].n).toBe(2); // terms + declaration
      }
      await expect(store.confirm(f.context, f.scope, { ...command, claimedFingerprint: "f".repeat(64) })).rejects.toMatchObject({ code: "idempotency_conflict" });
      for (const sql of ["UPDATE pms.pricing_v2_charge_declarations SET declaration=declaration WHERE id=$1", "DELETE FROM pms.pricing_v2_charge_declarations WHERE id=$1"])
        await expect(pool.query(sql, [first.id])).rejects.toThrow();
      await expect(pool.query("TRUNCATE pms.pricing_v2_charge_declarations")).rejects.toThrow();
      await pool.query("UPDATE pms.pricing_v2_drafts SET draft_revision=2 WHERE property_id=$1", [f.scope.propertyId]);
      expect(await store.confirm(f.context, f.scope, command)).toEqual(first); // historical receipt, not a new confirmation
    } finally { client.release(); }
  });
  it("rejects stale draft versions, fingerprints, bases and Booking terms", async () => {
    const f = await fixture();
    for (const command of [ { ...f.command(), draftId: randomUUID() }, { ...f.command(), expectedDraftRevision: 2 },
      { ...f.command(), claimedFingerprint: "f".repeat(64) } ])
      await expect(store.confirm(f.context, f.scope, command)).rejects.toMatchObject({ code: "stale" });
    await pool.query("UPDATE pms.pricing_v2_drafts SET base_revision=1 WHERE property_id=$1", [f.scope.propertyId]);
    await expect(store.confirm(f.context, f.scope, f.command())).rejects.toMatchObject({ code: "stale" });
    await pool.query("UPDATE pms.pricing_v2_drafts SET base_revision=0 WHERE property_id=$1", [f.scope.propertyId]);
    await createBookingPricingOfferTermsStore(pool).save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: f.saved.revision, terms: { ...f.terms, payment: { kind: "full" } } });
    await expect(store.confirm(f.context, f.scope, f.command())).rejects.toMatchObject({ code: "stale" });
    expect((await pool.query("SELECT count(*)::int AS n FROM pms.pricing_v2_charge_declarations WHERE property_id=$1", [f.scope.propertyId])).rows[0].n).toBe(0);
  });
  it("denies unauthenticated, foreign-scope, inactive and foreign-room confirmations", async () => {
    const f = await fixture(), other = await fixture();
    await expect(store.confirm(null, f.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    await expect(store.confirm(f.context, other.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.terms.roomTypeId]);
    await expect(store.confirm(f.context, f.scope, f.command())).rejects.toMatchObject({ code: "denied" });
    const foreign = { ...f.snapshot, rooms: f.snapshot.rooms.map((r) => ({ ...r, roomTypeId: other.terms.roomTypeId })) };
    await pool.query("UPDATE pms.pricing_v2_drafts SET snapshot=$2 WHERE property_id=$1", [f.scope.propertyId, foreign]);
    await expect(store.confirm(f.context, f.scope, { ...f.command(), claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, foreign, f.sources)! })).rejects.toMatchObject({ code: "denied" });
  });
  it("rolls back the declaration and events if auditing fails", async () => {
    const f = await fixture(), command = f.command(), key = `pricing.v2.charges:${f.scope.propertyId}:${command.requestId}`;
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'pms','fixture',now(),'property',$2::uuid,'pms','mandatory_charge_confirmation',$2::text)`, [key, f.scope.propertyId]);
    await expect(store.confirm(f.context, f.scope, command)).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int AS n FROM pms.pricing_v2_charge_declarations WHERE property_id=$1", [f.scope.propertyId])).rows[0].n).toBe(0);
    for (const table of ["domain_events", "outbox_events"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM platform.${table} WHERE property_id=$1`, [f.scope.propertyId])).rows[0].n).toBe(1); // existing Booking terms only
    expect(await store.confirm(f.context, f.scope, f.command())).toMatchObject({ fingerprint: command.claimedFingerprint });
  });
});
