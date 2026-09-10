import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingPricingOfferTermsStore } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockReplacementPricingOfferOwners as verify } from "./replacementPricingOfferOwners.js";
import { createReplacementChargeDeclarationStore, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing offer owners", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
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
    const booking = createBookingPricingOfferTermsStore(pool), secondRoomId = randomUUID();
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Second room')", [secondRoomId, propertyId]);
    const termsInput = { roomTypeId, offerId: "flex", cancellation: { kind: "non_refundable" }, payment: { kind: "full" } };
    const terms: ReplacementOfferTerms[] = [];
    for (const [room, offerId] of [[roomTypeId, "flex"], [roomTypeId, "other"], [secondRoomId, "flex"]])
      terms.push(await booking.save(context, scope, { requestId: randomUUID(), expectedRevision: null, terms: { ...termsInput, roomTypeId: room, offerId } }));
    await pool.query(`INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
      VALUES($1,true,ARRAY['pay_at_property'],'EUR')`, [propertyId]);
    const client = await pool.connect();
    let finance, roomSource;
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
      roomSource = await lockPmsReplacementPricingRoomSource(client, propertyId);
      finance = await lockFinanceReplacementPricingReadiness(client, { propertyId, currency: "EUR", pricingRevision: 1, terms });
    } finally { await client.query("ROLLBACK"); client.release(); }
    if (finance.kind !== "ready" || !roomSource) throw new Error("fixture requires owner evidence");
    const snapshot: PricingStorageSnapshot = { currency: "EUR", ownerReferences: { finance: finance.evidenceId },
      rooms: [roomTypeId, secondRoomId].map((id) => ({
        version: "pricing.v2", propertyId, roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
        children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
        offers: terms.filter((t) => t.roomTypeId === id).map((t) => ({ id: t.offerId, termsRevision: t.revision,
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
          restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] },
        })),
      })) };
    // PMS room evidence is owner-read; the aggregate terms source remains a fixture input.
    const sources = { room: roomSource, terms: "fixture-terms-source", finance: finance.evidenceId }, draftId = randomUUID();
    // Seed the draft boundary, then create evidence through the real authorized declaration writer.
    await pool.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [propertyId]);
    await pool.query(`INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id)
      VALUES($1,$2,1,0,$3,$4,$5)`, [propertyId, draftId, sources, snapshot, actorUserId]);
    const charges = await createReplacementChargeDeclarationStore(pool).confirm(context, scope, {
      draftId, expectedDraftRevision: 1, claimedFingerprint: replacementChargeFingerprint(propertyId, snapshot, sources)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    });
    const declared = { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, charges: charges.id } };
    async function read(proposed: unknown = declared, auth: RequestContext | null = context, currentSources: PricingStorageSources = sources) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); return await verify(client, auth, scope, proposed, currentSources); }
      finally { await client.query("ROLLBACK"); client.release(); }
    }
    return { scope, context, membershipId, snapshot: declared, read, booking, terms, termsInput, finance, charges, sources, draftId };
  }
  it("verifies every offer across rooms with exact current Finance evidence", async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({ kind: "verified", terms: f.terms, finance: f.finance, charges: f.charges });
    expect(await f.read({ ...f.snapshot, rooms: [...f.snapshot.rooms].reverse() })).toMatchObject({ kind: "verified" });
    expect(await f.read({ ...f.snapshot, rooms: [f.snapshot.rooms[0]] })).toMatchObject({ reason: "finance_unavailable", financeReason: "stale" });
    expect((await pool.query("SELECT count(*)::int AS n FROM platform.domain_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].n).toBe(4); // terms + declaration writers only
  });
  it("denies missing or revoked authorization and foreign or inactive room scope", async () => {
    const f = await fixture(), other = await fixture();
    expect(await f.read(f.snapshot, null)).toMatchObject({ reason: "denied" });
    expect(await f.read(f.snapshot, other.context)).toMatchObject({ reason: "denied" });
    const foreignRoom = { ...f.snapshot.rooms[1], roomTypeId: other.snapshot.rooms[0].roomTypeId };
    expect(await f.read({ ...f.snapshot, rooms: [f.snapshot.rooms[0], foreignRoom] })).toMatchObject({ reason: "room_unavailable" });
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.snapshot.rooms[1].roomTypeId]);
    expect(await f.read()).toMatchObject({ reason: "room_unavailable" });
    await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [f.membershipId]);
    expect(await f.read()).toMatchObject({ reason: "denied" });
  });
  it("rejects malformed, duplicate, mixed-revision and cross-property configurations", async () => {
    const f = await fixture(), first = f.snapshot.rooms[0];
    for (const input of [null, { ...f.snapshot, rooms: [] }, { ...f.snapshot, ownerReferences: {} },
      { ...f.snapshot, rooms: [first, first] }, { ...f.snapshot, rooms: [first, { ...f.snapshot.rooms[1], revision: 2 }] },
      { ...f.snapshot, rooms: [{ ...first, roomTypeId: "not-a-uuid" }] },
      { ...f.snapshot, rooms: [{ ...first, propertyId: randomUUID() }] },
      { ...f.snapshot, currency: "USD" },
    ]) expect(await f.read(input)).toMatchObject({ reason: "invalid" });
  });
  it("rejects stale and foreign terms on any selected offer", async () => {
    const f = await fixture(), other = await fixture();
    for (const index of [0, 1]) {
      const rooms = [...f.snapshot.rooms];
      rooms[0] = { ...rooms[0], offers: rooms[0].offers.map((o, i) => i === index ? { ...o, termsRevision: other.terms[0].revision } : o) };
      expect(await f.read({ ...f.snapshot, rooms })).toMatchObject({ reason: "terms_stale" });
    }
    const last = f.terms[2];
    await f.booking.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: last.revision,
      terms: { ...f.termsInput, roomTypeId: last.roomTypeId, offerId: last.offerId } });
    expect(await f.read()).toMatchObject({ reason: "terms_stale" });
  });
  it("rejects foreign/stale Finance evidence, disabled payments and requested deposits", async () => {
    const f = await fixture(), other = await fixture();
    expect(await f.read({ ...f.snapshot, ownerReferences: { finance: other.finance.evidenceId } })).toMatchObject({ financeReason: "stale" });
    expect(await f.read({ ...f.snapshot, rooms: f.snapshot.rooms.map((r) => ({ ...r, revision: 2 })) })).toMatchObject({ financeReason: "stale" });
    expect(await f.read({ ...f.snapshot, currency: "USD", rooms: f.snapshot.rooms.map((r) => ({ ...r, currency: "USD" })) })).toMatchObject({ financeReason: "currency_mismatch" });
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.scope.propertyId]);
    expect(await f.read()).toMatchObject({ financeReason: "payments_disabled" });
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=true WHERE property_id=$1", [f.scope.propertyId]);
    const saved = await f.booking.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: f.terms[0].revision,
      terms: { ...f.termsInput, payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 } } });
    const rooms = [...f.snapshot.rooms];
    rooms[0] = { ...rooms[0], offers: rooms[0].offers.map((o, i) => i === 0 ? { ...o, termsRevision: saved.revision } : o) };
    expect(await f.read({ ...f.snapshot, rooms })).toMatchObject({ financeReason: "deposit_execution_unavailable" });
  });
  it("holds live owner locks until transaction end, then rejects the replaced terms", async () => {
    const f = await fixture(), client = await pool.connect(), writer = new pg.Pool({ connectionString: url, max: 1 });
    const command = { requestId: randomUUID(), expectedRevision: f.terms[0].revision, terms: f.termsInput };
    try {
      await writer.query("SET lock_timeout='150ms'");
      await client.query("BEGIN"); expect(await verify(client, f.context, f.scope, f.snapshot, f.sources)).toMatchObject({ kind: "verified" });
      await expect(createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command)).rejects.toMatchObject({ code: "55P03" });
      await expect(writer.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.scope.propertyId])).rejects.toMatchObject({ code: "55P03" });
      await client.query("COMMIT");
      await createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command);
      expect(await f.read()).toMatchObject({ reason: "terms_stale" });
    } finally { await client.query("ROLLBACK"); client.release(); await writer.end(); }
  });
  it("requires the exact property declaration and rejects changed pricing or source evidence", async () => {
    const f = await fixture(), other = await fixture();
    for (const id of [undefined, "unconfirmed", randomUUID(), other.charges.id]) {
      const ownerReferences: Record<string, string> = { finance: f.finance.evidenceId };
      if (id !== undefined) ownerReferences.charges = id;
      expect(await f.read({ ...f.snapshot, ownerReferences })).toMatchObject({ reason: "charges_stale" });
    }
    const first = f.snapshot.rooms[0], offer = first.offers[0];
    const changes = [
      { ...first, children: { ...first.children, bands: first.children.bands.map((b) => ({ ...b, nightlyMinor: "500" })) } },
      { ...first, offers: [{ ...offer, meal: { kind: "breakfast", charge: { kind: "room", amountMinor: "1500" } } }, first.offers[1]] },
      { ...first, offers: [{ ...offer, price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "11000" }, months: [], seasons: [], weekdays: [], dates: [] } } }, first.offers[1]] },
    ];
    for (const changed of changes)
      expect(await f.read({ ...f.snapshot, rooms: [changed, f.snapshot.rooms[1]] })).toMatchObject({ reason: "charges_stale" });
    expect(await f.read(f.snapshot, f.context, { ...f.sources, terms: "changed" })).toMatchObject({ reason: "charges_stale" });
    // Only the declaration's own reference is excluded from the fingerprint.
    expect(await f.read(f.snapshot, f.context, { ...f.sources, charges: f.charges.id })).toMatchObject({ kind: "verified", charges: f.charges });
    expect((await pool.query("SELECT count(*)::int AS n FROM platform.outbox_events WHERE property_id=$1", [f.scope.propertyId])).rows[0].n).toBe(4);
  });
  it("rejects missing, forged and stale complete-room sources before charge approval", async () => {
    const f = await fixture();
    for (const sources of [{ finance: f.finance.evidenceId }, { ...f.sources, room: "forged" }])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({ reason: "room_source_stale" });
    const forged = { ...f.sources, room: "forged" };
    await pool.query("UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1", [f.scope.propertyId, forged]);
    const declaration = await createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
      draftId: f.draftId, expectedDraftRevision: 2, claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    });
    // A matching declaration is still insufficient when its saved source was never authoritative.
    expect(await f.read({ ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: declaration.id } }, f.context, forged)).toMatchObject({ reason: "room_source_stale" });
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'New room')", [randomUUID(), f.scope.propertyId]);
    expect(await f.read()).toMatchObject({ reason: "room_source_stale" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "manage")).toBe(true);
      const room = await lockPmsReplacementPricingRoomSource(client, f.scope.propertyId);
      expect(await verify(client, f.context, f.scope, f.snapshot, { ...f.sources, room: room! })).toMatchObject({ reason: "charges_stale" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
