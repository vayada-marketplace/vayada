import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingPricingOfferTermsStore, lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { createReplacementChargeDeclarationStore, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import { createReplacementPricingStore, type PricingStorageSnapshot } from "./replacementPricingStore.js";
import { createReplacementPricingStorageGuard, lockReplacementPricingSources } from "./replacementPricingStorageGuard.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing storage guard", () => {
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
    let finance, roomSource, termsSource, financeSource;
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
      roomSource = await lockPmsReplacementPricingRoomSource(client, propertyId);
      termsSource = await lockBookingPricingTermsSource(client, propertyId);
      financeSource = await lockFinanceReplacementPricingSource(client, propertyId);
      finance = await lockFinanceReplacementPricingReadiness(client, { propertyId, currency: "EUR", pricingRevision: 1, terms });
    } finally { await client.query("ROLLBACK"); client.release(); }
    if (finance.kind !== "ready" || !roomSource || !termsSource || !financeSource) throw new Error("fixture requires owner evidence");
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
    // Source evidence is proposal-independent; ownerReferences.finance is separate readiness evidence.
    const sources = { room: roomSource, terms: termsSource, finance: financeSource }, draftId = randomUUID();
    const store = createReplacementPricingStore(pool, createReplacementPricingStorageGuard(context));
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, sources, snapshot };
    expect(await store.saveDraft(scope, draft)).toBe(1);
    const charges = await createReplacementChargeDeclarationStore(pool).confirm(context, scope, {
      draftId, expectedDraftRevision: 1, claimedFingerprint: replacementChargeFingerprint(propertyId, snapshot, sources)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    });
    const declared = { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, charges: charges.id } };
    expect(await store.saveDraft(scope, { ...draft, expectedDraftRevision: 1, snapshot: declared })).toBe(2);
    const command = { requestId: randomUUID(), expectedRevision: 0, sources, snapshot: declared, draft: { id: draftId, revision: 2 } };
    return { scope, context, membershipId, store, snapshot: declared, draft, command, sources, terms };
  }
  async function effects(propertyId: string) {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM pms.pricing_v2_revisions WHERE property_id=$1) AS revisions,
      (SELECT count(*)::int FROM platform.domain_events WHERE property_id=$1 AND event_type='pricing.v2.revised') AS events,
      (SELECT count(*)::int FROM platform.outbox_events WHERE property_id=$1 AND event_type='pricing.v2.revised') AS outbox`, [propertyId])).rows[0];
  }
  it("saves a pending draft, confirms charges, saves the declaration and publishes the exact draft once", async () => {
    const f = await fixture();
    const before = await f.store.readDraft(f.scope, f.draft.draftId);
    expect(before).toMatchObject({ revision: 2, stale: false, snapshot: f.snapshot });
    expect(await f.store.save(f.scope, f.command)).toEqual({ revision: 1, replayed: false });
    expect(await f.store.save(f.scope, f.command)).toEqual({ revision: 1, replayed: true });
    expect(await effects(f.scope.propertyId)).toEqual({ revisions: 1, events: 1, outbox: 1 });
    expect(await f.store.read(f.scope)).toMatchObject({ revision: 1, stale: false });
  });
  it("requires declarations for publication and validates supplied draft declarations", async () => {
    const f = await fixture();
    await expect(f.store.save(f.scope, { ...f.command, draft: undefined, snapshot: f.draft.snapshot })).rejects.toMatchObject({ code: "denied" });
    for (const ownerReferences of [{ ...f.snapshot.ownerReferences, charges: randomUUID() },
      { ...f.snapshot.ownerReferences, arbitrary: "unverified" }, { ...f.snapshot.ownerReferences, fx: randomUUID() }]) {
      await expect(f.store.saveDraft(f.scope, { ...f.draft, expectedDraftRevision: 2, snapshot: { ...f.snapshot, ownerReferences } })).rejects.toMatchObject({ code: "denied" });
    }
    await expect(f.store.save(f.scope, { ...f.command, sources: { ...f.sources, finance: "forged" } })).rejects.toMatchObject({ code: "stale" });
    expect(await effects(f.scope.propertyId)).toEqual({ revisions: 0, events: 0, outbox: 0 });
    expect(await f.store.readDraft(f.scope, f.draft.draftId)).toMatchObject({ revision: 2 });
  });
  it("replays accepted publications after source/readiness changes but denies revoked access", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command);
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.scope.propertyId]);
    expect(await f.store.save(f.scope, f.command)).toEqual({ revision: 1, replayed: true });
    expect(await f.store.read(f.scope)).toMatchObject({ revision: 1, stale: true });
    await expect(f.store.save(f.scope, { ...f.command, requestId: randomUUID(), draft: undefined })).rejects.toMatchObject({ code: "stale" });
    await expect(f.store.save(f.scope, { ...f.command, snapshot: { ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: randomUUID() } } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [f.membershipId]);
    await expect(f.store.save(f.scope, f.command)).rejects.toMatchObject({ code: "denied" });
    await expect(f.store.read(f.scope)).rejects.toMatchObject({ code: "denied" });
    expect(await effects(f.scope.propertyId)).toEqual({ revisions: 1, events: 1, outbox: 1 });
  });
  it("permits live read-only access but never writes or retries with it", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command);
    await pool.query("DELETE FROM identity.role_permission_grants WHERE role_key=$1 AND permission_key='pms.rooms_rates.manage'", [f.context.membership!.roleKey]);
    expect(await f.store.read(f.scope)).toMatchObject({ revision: 1 });
    expect(await f.store.readDraft(f.scope, f.draft.draftId)).toMatchObject({ revision: 2 });
    await expect(f.store.save(f.scope, f.command)).rejects.toMatchObject({ code: "denied" });
    await expect(f.store.saveDraft(f.scope, { ...f.draft, expectedDraftRevision: 2 })).rejects.toMatchObject({ code: "denied" });
    const denied = createReplacementPricingStore(pool, createReplacementPricingStorageGuard(null));
    await expect(denied.read(f.scope)).rejects.toMatchObject({ code: "denied" });
  });
  it("collects disabled Finance state without approving a new draft", async () => {
    const f = await fixture(), client = await pool.connect();
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.scope.propertyId]);
    let sources;
    try { await client.query("BEGIN"); sources = await lockReplacementPricingSources(client, f.context, f.scope, "manage"); }
    finally { await client.query("ROLLBACK"); client.release(); }
    expect(sources?.finance).not.toBe(f.sources.finance);
    await expect(f.store.saveDraft(f.scope, { ...f.draft, expectedDraftRevision: 2, sources: sources! })).rejects.toMatchObject({ code: "denied" });

  });
  it("rejects currency changes through real storage even after fresh owner confirmation", async () => {
    const f = await fixture(); await f.store.save(f.scope, f.command);
    await pool.query("UPDATE finance.payment_settings SET default_currency='USD' WHERE property_id=$1", [f.scope.propertyId]);
    const client = await pool.connect(); let sources, finance;
    try {
      await client.query("BEGIN"); sources = await lockReplacementPricingSources(client, f.context, f.scope, "manage");
      finance = await lockFinanceReplacementPricingReadiness(client, { propertyId: f.scope.propertyId, currency: "USD", pricingRevision: 2, terms: f.terms });
    } finally { await client.query("ROLLBACK"); client.release(); }
    if (!sources || finance.kind !== "ready") throw new Error("fresh owner evidence required");
    const snapshot = { ...f.snapshot, currency: "USD", ownerReferences: { finance: finance.evidenceId },
      rooms: f.snapshot.rooms.map((room) => ({ ...room, currency: "USD", revision: 2 })) };
    const draftId = randomUUID(), draft = { draftId, expectedDraftRevision: 0, baseRevision: 1, sources, snapshot };
    expect(await f.store.saveDraft(f.scope, draft)).toBe(1);
    const charges = await createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
      draftId, expectedDraftRevision: 1, claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, snapshot, sources)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    });
    const declared = { ...snapshot, ownerReferences: { ...snapshot.ownerReferences, charges: charges.id } };
    expect(await f.store.saveDraft(f.scope, { ...draft, expectedDraftRevision: 1, snapshot: declared })).toBe(2);
    await expect(f.store.save(f.scope, { requestId: randomUUID(), expectedRevision: 1, sources, snapshot: declared,
      draft: { id: draftId, revision: 2 } })).rejects.toMatchObject({ code: "currency_conversion_required" });
    expect(await effects(f.scope.propertyId)).toEqual({ revisions: 1, events: 1, outbox: 1 });
    expect(await f.store.readDraft(f.scope, draftId)).toMatchObject({ revision: 2 });
  });
});
