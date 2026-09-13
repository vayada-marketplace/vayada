import { lockPublicPricingComponents } from "./publicPricingComponents.js";
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
import { lockReplacementPricingOfferOwners as verify } from "./replacementPricingOfferOwners.js";
import { createReplacementChargeDeclarationStore, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";
import { createReplacementPricingStore } from "./replacementPricingStore.js";
import { createReplacementPricingStorageGuard } from "./replacementPricingStorageGuard.js";
import { createBookingPricingAuthorityStore } from "./bookingPricingAuthority.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingRoomStay, publicPricingOfferBindings } from "./publicPricingRoomStay.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing offer owners", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture(configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot) {
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
    let snapshot: PricingStorageSnapshot = { currency: "EUR", ownerReferences: { finance: finance.evidenceId },
      rooms: [roomTypeId, secondRoomId].map((id) => ({
        version: "pricing.v2", propertyId, roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
        children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
        offers: terms.filter((t) => t.roomTypeId === id).map((t) => ({ id: t.offerId, termsRevision: t.revision,
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
          restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] },
        })),
      })) };
    if (configure) snapshot = configure(snapshot);
    // Source evidence is proposal-independent; ownerReferences.finance is separate readiness evidence.
    const sources = { room: roomSource, terms: termsSource, finance: financeSource }, draftId = randomUUID();
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
    async function currentTermsSource() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
        const source = await lockBookingPricingTermsSource(client, propertyId);
        expect(await lockBookingPricingTermsSource(client, propertyId.toUpperCase())).toBe(source);
        return source!;
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    return { scope, context, membershipId, snapshot: declared, read, booking, terms, termsInput, finance, charges, sources, draftId, currentTermsSource };
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
    expect(await f.read({ ...f.snapshot, rooms }, f.context, { ...f.sources, terms: await f.currentTermsSource() })).toMatchObject({ financeReason: "deposit_execution_unavailable" });
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
    expect(await f.read(f.snapshot, f.context, { ...f.sources, finance: "changed" })).toMatchObject({ reason: "finance_source_stale" });
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
    await expect(createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
      draftId: f.draftId, expectedDraftRevision: 2, claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "stale" });
    // A matching declaration is still insufficient when its saved source was never authoritative.
    expect(await f.read({ ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id } }, f.context, forged)).toMatchObject({ reason: "room_source_stale" });
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
  it("binds the complete Booking terms set and rejects forged-source confirmation", async () => {
    const f = await fixture(), other = await fixture();
    expect(await f.currentTermsSource()).toBe(f.sources.terms);
    expect(await other.currentTermsSource()).not.toBe(f.sources.terms);
    for (const sources of [{ room: f.sources.room, finance: f.finance.evidenceId }, { ...f.sources, terms: other.sources.terms }])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({ reason: "terms_source_stale" });
    const forged = { ...f.sources, terms: "forged" };
    await pool.query("UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1", [f.scope.propertyId, forged]);
    await expect(createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
      draftId: f.draftId, expectedDraftRevision: 2, claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "stale" });
    expect(await f.read({ ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id } }, f.context, forged)).toMatchObject({ reason: "terms_source_stale" });
    await f.booking.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: null, terms: { ...f.termsInput, offerId: "unselected" } });
    expect(await f.read()).toMatchObject({ reason: "terms_source_stale" });
    const changed = await f.currentTermsSource(); expect(changed).not.toBe(f.sources.terms);
    expect(await f.read(f.snapshot, f.context, { ...f.sources, terms: changed })).toMatchObject({ reason: "charges_stale" });
    const updated = await f.booking.save(f.context, f.scope, { requestId: randomUUID(), expectedRevision: f.terms[0].revision, terms: f.termsInput });
    expect(updated.revision).not.toBe(f.terms[0].revision);
    expect(await f.currentTermsSource()).not.toBe(changed);
  });
  it("holds the complete terms source against new offers through the real Booking writer", async () => {
    const f = await fixture(), reader = await pool.connect(), writer = new pg.Pool({ connectionString: url, max: 1 });
    const command = { requestId: randomUUID(), expectedRevision: null, terms: { ...f.termsInput, offerId: "concurrent-new" } };
    try {
      await writer.query("SET lock_timeout='150ms'");
      await reader.query("BEGIN"); expect(await verify(reader, f.context, f.scope, f.snapshot, f.sources)).toMatchObject({ kind: "verified" });
      await expect(createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command)).rejects.toMatchObject({ code: "55P03" });
      await reader.query("COMMIT");
      await createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command);
      expect(await f.read()).toMatchObject({ reason: "terms_source_stale" });
    } finally { await reader.query("ROLLBACK"); reader.release(); await writer.end(); }
  });
  it("requires independent Finance sources even with matching declaration or readiness evidence", async () => {
    const f = await fixture();
    for (const sources of [{ room: f.sources.room, terms: f.sources.terms }, { ...f.sources, finance: f.finance.evidenceId }])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({ reason: "finance_source_stale" });
    const forged = { ...f.sources, finance: "forged" };
    await pool.query("UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1", [f.scope.propertyId, forged]);
    await expect(createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
      draftId: f.draftId, expectedDraftRevision: 2, claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID(),
    })).rejects.toMatchObject({ code: "stale" });
    expect(await f.read({ ...f.snapshot, ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id } }, f.context, forged)).toMatchObject({ reason: "finance_source_stale" });
    // Tax policy is source state but does not change method capability; readiness alone is insufficient.
    await pool.query("UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1", [f.scope.propertyId]);
    expect(await f.read()).toMatchObject({ reason: "finance_source_stale" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "manage")).toBe(true);
      await lockPmsReplacementPricingRoomSource(client, f.scope.propertyId); await lockBookingPricingTermsSource(client, f.scope.propertyId);
      const finance = await lockFinanceReplacementPricingSource(client, f.scope.propertyId);
      expect(await verify(client, f.context, f.scope, f.snapshot, { ...f.sources, finance: finance! })).toMatchObject({ reason: "charges_stale" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  async function publicFixture(publish = true, configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot) {
    const f = await fixture(configure),
      propertyId = f.scope.propertyId;
    await pool.query(
      "UPDATE hotel_catalog.properties SET profile_status='complete',lifecycle_status='active' WHERE id=$1",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose) VALUES($1::uuid,$1::text,'canonical')",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model
      (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
      VALUES($1::uuid,$1::text,'Published pricing test',$1::text,'en',ARRAY['en'],'complete')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles
      (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,default_currency,supported_currencies,
      profile_status,freshness_status,public_setup_completeness,capabilities)
      VALUES($1::uuid,$1::text,$1::text,'https://example.test','https://example.test','Etc/UTC','EUR',ARRAY['EUR'],
      'public','fresh','{"status":"ready"}','{"paymentMethods":["pay_at_property"]}')`,
      [propertyId],
    );
    const authority = createBookingPricingAuthorityStore(pool);
    const choice = await authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: null,
      authority: "vayada",
    });
    const publishPrices = () =>
      createReplacementPricingStore(pool, createReplacementPricingStorageGuard(f.context)).save(
        f.scope,
        {
          requestId: randomUUID(),
          expectedRevision: 0,
          sources: f.sources,
          snapshot: f.snapshot,
        },
      );
    if (publish) await publishPrices();
    const readPublic = async (slug: unknown = propertyId) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockPublicPricingPublication(client, slug);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, authority, choice, readPublic, publishPrices };
  }
  it("reads only the complete current publication with real owner evidence, never a draft", async () => {
    const f = await publicFixture(false);
    expect(await f.readPublic()).toBeNull();
    await f.publishPrices();
    const result = await f.readPublic();
    expect(result).toMatchObject({
      scope: { propertyId: f.scope.propertyId, authorityRevision: f.choice.revision },
      publication: { revision: 1, currency: "EUR", sources: f.sources },
      finance: f.finance,
      charges: f.charges,
    });
    expect(result?.publication.rooms).toHaveLength(2);
    expect(result?.terms).toHaveLength(3);
    expect(result?.pmsSourceRevision).toMatch(/^booking\.pms\.publication\.v2:[a-f0-9]{64}$/);
    await pool.query(
      "UPDATE pms.pricing_v2_drafts SET draft_revision=draft_revision+1 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect((await f.readPublic())?.pmsSourceRevision).toBe(result?.pmsSourceRevision);
    expect(await f.readPublic(randomUUID())).toBeNull();
  });
  it("changes the source identity after a new authority choice and refuses external or hidden properties", async () => {
    const f = await publicFixture(),
      initial = await f.readPublic();
    const same = await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: f.choice.revision,
      authority: "vayada",
    });
    expect((await f.readPublic())?.pmsSourceRevision).not.toBe(initial?.pmsSourceRevision);
    await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: same.revision,
      authority: "external",
    });
    expect(await f.readPublic()).toBeNull();
    const hidden = await publicFixture();
    await pool.query(
      "UPDATE distribution.public_hotel_bookability_profiles SET profile_status='unpublished' WHERE property_id=$1",
      [hidden.scope.propertyId],
    );
    expect(await hidden.readPublic()).toBeNull();
  });
  it("rejects complete publications after room or Finance source changes", async () => {
    const f = await publicFixture(),
      client = await pool.connect();
    try {
      for (const sql of [
        "UPDATE pms.room_types SET active=false WHERE property_id=$1",
        "UPDATE pms.room_types SET room_attributes='{\"changed\":true}' WHERE property_id=$1",
        "INSERT INTO pms.room_types(property_id,name) VALUES($1,'Added room')",
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        "UPDATE finance.payment_settings SET default_currency='USD' WHERE property_id=$1",
      ]) {
        await client.query("BEGIN");
        try {
          await client.query(sql, [f.scope.propertyId]);
          expect(await lockPublicPricingPublication(client, f.scope.propertyId)).toBeNull();
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
    expect(await f.readPublic()).not.toBeNull();
  });
  it("rejects a changed policy on any published offer", async () => {
    const f = await publicFixture();
    const last = f.terms[2];
    await f.booking.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: last.revision,
      terms: { ...f.termsInput, roomTypeId: last.roomTypeId, offerId: last.offerId },
    });
    expect(await f.readPublic()).toBeNull();
  });
  it("keeps publication and owner writes serialized through the consuming transaction", async () => {
    const f = await publicFixture(),
      client = await pool.connect();
    const writer = new pg.Pool({ connectionString: url, max: 1, options: "-c lock_timeout=100ms" });
    try {
      await client.query("BEGIN");
      expect(await lockPublicPricingPublication(client, f.scope.propertyId)).not.toBeNull();
      await expect(
        writer.query("UPDATE pms.room_types SET active=false WHERE property_id=$1", [
          f.scope.propertyId,
        ]),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
          [f.scope.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, {
          requestId: randomUUID(),
          expectedRevision: f.terms[0].revision,
          terms: f.termsInput,
        }),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        createBookingPricingAuthorityStore(writer).save(f.context, f.scope, {
          requestId: randomUUID(),
          expectedRevision: f.choice.revision,
          authority: "external",
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });

  it("rejects unknown, forged and mismatched saved owner evidence", async () => {
    const f = await publicFixture(false),
      client = await pool.connect();
    try {
      for (const change of [
        { sources: { ...f.sources, room: "forged" } },
        { sources: { ...f.sources, terms: "forged" } },
        { sources: { ...f.sources, finance: "forged" } },
        { sources: { ...f.sources, extra: "unverified" } },
        { owners: { ...f.snapshot.ownerReferences, finance: "foreign" } },
        { owners: { ...f.snapshot.ownerReferences, charges: randomUUID() } },
        { owners: { ...f.snapshot.ownerReferences, extra: "unverified" } },
      ]) {
        await client.query("BEGIN");
        try {
          // Construct a new uncommitted publication; never mutate sealed history or disable guards.
          await client.query(
            `INSERT INTO pms.pricing_v2_revisions
            (property_id,revision,room_count,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id)
            VALUES($1,1,2,'EUR',$2,$3,$4,$5,$6)`,
            [
              f.scope.propertyId,
              change.sources ?? f.sources,
              change.owners ?? f.snapshot.ownerReferences,
              randomUUID(),
              "a".repeat(64),
              f.scope.actorUserId,
            ],
          );
          for (const room of f.snapshot.rooms)
            await client.query(
              `INSERT INTO pms.pricing_v2_rooms
            (property_id,revision,room_type_id,currency,configuration) VALUES($1,1,$2,'EUR',$3)`,
              [f.scope.propertyId, room.roomTypeId, room],
            );
          await client.query("UPDATE pms.pricing_v2_heads SET revision=1 WHERE property_id=$1", [
            f.scope.propertyId,
          ]);
          expect(await lockPublicPricingPublication(client, f.scope.propertyId)).toBeNull();
        } finally {
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
    expect(await f.readPublic()).toBeNull();
  });
  async function stayFixture(
    configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot,
  ) {
    const f = await publicFixture(true, configure),
      owner = await f.readPublic();
    if (!owner) throw new Error("published owner required");
    const bindings = publicPricingOfferBindings(owner);
    const selection = {
      version: "public-pricing-selection.v1",
      checkIn: "2026-10-01",
      checkOut: "2026-10-02",
      currency: "EUR",
      rooms: [
        {
          selectionId: "one",
          publicOfferKey: bindings[0].publicOfferKey,
          guests: { adults: 1, childAgesAtCheckIn: [] as number[] },
        },
      ],
      addons: [],
      promoCode: null,
    };
    const price = async (input: unknown = selection) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockPublicPricingRoomStay(client, f.scope.propertyId, input);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, bindings, selection, price };
  }
  const familyPrices = (snapshot: PricingStorageSnapshot): PricingStorageSnapshot => ({
    ...snapshot,
    rooms: snapshot.rooms.map((room, index) => ({
      ...room,
      capacity: { total: 3, adults: 3, children: 2 },
      children: {
        adultFromAge: 12,
        bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "1500", countsTowardCapacity: true }],
      },
      offers: room.offers.map((offer) => ({
        ...offer,
        meal:
          index === 0 && offer.id === "flex"
            ? {
                kind: "breakfast",
                charge: { kind: "person", adultMinor: "1000", childBandAmountsMinor: ["500"] },
              }
            : offer.meal,
        price:
          offer.id === "other"
            ? {
                kind: "linked",
                parentId: "flex",
                adjustment: { kind: "percentage", basisPoints: -1000 },
                dateOverrides: [],
              }
            : {
                kind: "independent",
                calendar: {
                  base:
                    index === 0
                      ? { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] }
                      : { mode: "per_person", unitMinor: "6000" },
                  months: [],
                  seasons: [],
                  weekdays: [],
                  dates: [],
                },
              },
      })),
    })),
  });
  it("calculates mixed physical rooms with actual child ages and separate nightly meal evidence", async () => {
    const f = await stayFixture(familyPrices);
    const first = f.bindings.find(
      (b) => b.roomTypeId === f.snapshot.rooms[0].roomTypeId && b.offerId === "flex",
    )!;
    const second = f.bindings.find((b) => b.roomTypeId === f.snapshot.rooms[1].roomTypeId)!;
    const input = {
      ...f.selection,
      checkOut: "2026-10-03",
      rooms: [
        {
          selectionId: "family",
          publicOfferKey: first.publicOfferKey,
          guests: { adults: 1, childAgesAtCheckIn: [8] },
        },
        {
          selectionId: "couple",
          publicOfferKey: second.publicOfferKey,
          guests: { adults: 2, childAgesAtCheckIn: [] },
        },
      ],
    };
    const result = await f.price(input);
    expect(result).toMatchObject({
      kind: "room_components",
      roomMinor: "47000",
      mealMinor: "3000",
      roomAndMealMinor: "50000",
    });
    expect(
      result?.rooms.map((r) => [r.selectionId, r.roomMinor, r.mealMinor, r.nights.length]),
    ).toEqual([
      ["family", "23000", "3000", 2],
      ["couple", "24000", "0", 2],
    ]);
    expect(result?.stay.rooms[0].guests.childAgesAtCheckIn).toEqual([8]);
    expect(result?.rooms[0].nights[0]).toMatchObject({
      date: "2026-10-01",
      roomMinor: "11500",
      mealMinor: "1500",
      totalMinor: "13000",
    });
  });
  it("preserves linked ancestor policies and prices a child at the adult threshold", async () => {
    const f = await stayFixture(familyPrices),
      binding = f.bindings.find((b) => b.offerId === "other")!;
    const result = await f.price({
      ...f.selection,
      rooms: [
        {
          selectionId: "one",
          publicOfferKey: binding.publicOfferKey,
          guests: { adults: 1, childAgesAtCheckIn: [8] },
        },
      ],
    });
    expect(result?.roomAndMealMinor).toBe("10350");
    expect(Object.keys(result!.rooms[0].termsRevisions).sort()).toEqual(["flex", "other"]);
    expect(result?.rooms[0].nights[0].sources).toEqual([
      { offerId: "flex", kind: "base" },
      { offerId: "other", kind: "linked" },
    ]);
    const flex = f.bindings.find(
      (b) => b.roomTypeId === binding.roomTypeId && b.offerId === "flex",
    )!;
    expect(
      (
        await f.price({
          ...f.selection,
          rooms: [
            {
              selectionId: "one",
              publicOfferKey: flex.publicOfferKey,
              guests: { adults: 1, childAgesAtCheckIn: [12] },
            },
          ],
        })
      )?.roomAndMealMinor,
    ).toBe("15000");
  });
  it("prices repeated room types separately and retains unpriced extras and promo intent", async () => {
    const f = await stayFixture(familyPrices),
      flex = f.bindings.find(
        (b) => b.roomTypeId === f.snapshot.rooms[0].roomTypeId && b.offerId === "flex",
      )!;
    const input = {
      ...f.selection,
      rooms: [1, 2].map((adults) => ({
        selectionId: String(adults),
        publicOfferKey: flex.publicOfferKey,
        guests: { adults, childAgesAtCheckIn: [] },
      })),
      addons: [{ id: "transfer", quantity: 1, dates: null }],
      promoCode: "CODE",
    };
    const result = await f.price(input);
    expect(result?.roomAndMealMinor).toBe("26000");
    expect(result?.stay.addons).toEqual(input.addons);
    expect(result?.stay.promoCode).toBe("CODE");
    expect(result).not.toHaveProperty("dueNowMinor");
    expect(result).not.toHaveProperty("totalMinor");
  });
  it("rejects foreign and stale offer keys, unsupported currency and malformed allocations", async () => {
    const f = await stayFixture(),
      other = await stayFixture();
    for (const input of [
      { ...f.selection, currency: "USD" },
      {
        ...f.selection,
        rooms: [{ ...f.selection.rooms[0], publicOfferKey: other.bindings[0].publicOfferKey }],
      },
      { ...f.selection, rooms: [{ ...f.selection.rooms[0], guests: { adults: 1, children: 1 } }] },
      {
        ...f.selection,
        rooms: [{ ...f.selection.rooms[0], guests: { adults: 99, childAgesAtCheckIn: [] } }],
      },
      { ...f.selection, rooms: [f.selection.rooms[0], f.selection.rooms[0]] },
    ])
      expect(await f.price(input)).toBeNull();
    await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: f.choice.revision,
      authority: "vayada",
    });
    expect(await f.price()).toBeNull();
  });
  it("rejects nightly stop-sell and aggregate overflow across otherwise valid rooms", async () => {
    const closed = await stayFixture((s) => ({
      ...s,
      rooms: s.rooms.map((r) => ({
        ...r,
        offers: r.offers.map((o) => ({
          ...o,
          restrictions: {
            kind: "own",
            rules: {
              minArrivalNights: 1,
              maxStayNights: null,
              closedToArrival: false,
              closedToDeparture: false,
              stopSell: true,
            },
            seasons: [],
            dates: [],
          },
        })),
      })),
    }));
    expect(await closed.price()).toBeNull();
    const huge = await stayFixture((s) => ({
      ...s,
      rooms: s.rooms.map((r) => ({
        ...r,
        offers: r.offers.map((o) => ({
          ...o,
          price: {
            kind: "independent",
            calendar: {
              base: { mode: "flat", amountMinor: "999999999999999999" },
              months: [],
              seasons: [],
              weekdays: [],
              dates: [],
            },
          },
        })),
      })),
    }));
    expect(
      await huge.price({
        ...huge.selection,
        rooms: [1, 2].map((id) => ({ ...huge.selection.rooms[0], selectionId: String(id) })),
      }),
    ).toBeNull();
  });
  async function componentsFixture() {
    const f = await stayFixture(familyPrices),
      id = randomUUID();
    await pool.query(
      `INSERT INTO booking.booking_settings(property_id,default_currency,last_minute_discount)
          VALUES($1,'EUR','{"enabled":true,"stackWithPromo":true,"tiers":[{"daysBeforeMin":0,"daysBeforeMax":null,"discountPercent":20}]}')`,
      [f.scope.propertyId],
    );
    await pool.query(
      `INSERT INTO booking.addon_definitions(id,property_id,name,pricing_model,price_amount,currency,metadata)
          VALUES($1,$2,'Transfer','per_stay',20,'EUR','{"maxQuantity":2}')`,
      [id, f.scope.propertyId],
    );
    await pool.query(
      `INSERT INTO booking.promo_definitions(property_id,code,discount_type,discount_value,max_uses,min_booking_value)
          VALUES($1,'SAVE','percentage',10,100,200)`,
      [f.scope.propertyId],
    );
    const dates = (
      await pool.query(
        "SELECT (current_date+10)::text AS arrival,(current_date+11)::text AS departure",
      )
    ).rows[0];
    const selectedRoom = {
      ...f.selection.rooms[0],
      publicOfferKey: f.bindings.find(
        (b) => b.roomTypeId === f.snapshot.rooms[0].roomTypeId && b.offerId === "flex",
      )!.publicOfferKey,
    };
    const selection = {
      ...f.selection,
      version: "public-pricing-selection.v2",
      checkIn: dates.arrival,
      checkOut: dates.departure,
      rooms: [selectedRoom, { ...selectedRoom, selectionId: "two" }],
      addons: [{ version: "addon-selection.v2", id, quantity: 2, dates: null, people: null }],
      promoCode: "SAVE",
    };
    const components = async (input: unknown = selection) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockPublicPricingComponents(client, f.scope.propertyId, input);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { ...f, id, selection, components };
  }
  it("composes repeated physical rooms, meals, saved extras and current stacked discounts", async () => {
    const f = await componentsFixture(),
      result = await f.components();
    expect(result).toMatchObject({
      kind: "pricing_components",
      subtotalMinor: "20000",
      room: { roomMinor: "20000", mealMinor: "2000" },
      addons: { totalMinor: "4000" },
      discounts: {
        totalDiscountMinor: "6000",
        codeMinor: "2000",
        lastMinuteLines: [
          { selectionId: "one", amountMinor: "2000" },
          { selectionId: "two", amountMinor: "2000" },
        ],
      },
    });
    expect(result?.requestKey).toBe(result?.addons.requestKey);
    expect(result?.componentSources.promotions).toMatch(/^booking.promotions.v2:/);
    expect(result?.room.rooms).toHaveLength(2);
    expect(result?.lastMinute.rooms).toHaveLength(1);
    await pool.query(
      "UPDATE booking.booking_settings SET last_minute_discount=jsonb_set(last_minute_discount,'{stackWithPromo}','false') WHERE property_id=$1",
      [f.scope.propertyId],
    );
    const nonstack = await f.components();
    expect(nonstack?.subtotalMinor).toBe("22000");
    expect(nonstack?.discounts.codeMinor).toBe("0");
    expect(nonstack?.componentSources.promotions).not.toBe(result?.componentSources.promotions);
  });
  it("preserves the Python minimum basis and excludes meals from discount and minimum amounts", async () => {
    const f = await componentsFixture();
    await pool.query(
      "UPDATE booking.promo_definitions SET min_booking_value=200.01 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await f.components()).toBeNull();
    await pool.query(
      "UPDATE booking.promo_definitions SET min_booking_value=200,discount_type='fixed',discount_value=50 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    const result = await f.components();
    expect(result?.subtotalMinor).toBe("17000"); // 200 rooms +20 meals +40 extras -40 LM -50 one code
    expect(result?.discounts.codeMinor).toBe("5000");
    expect((await f.components({ ...f.selection, promoCode: null, addons: [] }))?.subtotalMinor).toBe(
      "18000",
    );
    expect(await f.components({ ...f.selection, promoCode: "MISSING" })).toBeNull();
  });
  it("rejects unavailable current owners and preserves old component snapshots after owner changes", async () => {
    const f = await componentsFixture(),
      before = await f.components();
    await pool.query("UPDATE booking.addon_definitions SET price_amount=30 WHERE id=$1", [f.id]);
    const changed = await f.components();
    expect(changed?.subtotalMinor).toBe("21800");
    expect(changed?.componentSources.addons).not.toBe(before?.componentSources.addons);
    expect(before?.subtotalMinor).toBe("20000");
    await pool.query("UPDATE booking.addon_definitions SET public_visible=false WHERE id=$1", [f.id]);
    expect(await f.components()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET public_visible=true WHERE id=$1", [f.id]);
    await pool.query("DELETE FROM booking.booking_settings WHERE property_id=$1", [
      f.scope.propertyId,
    ]);
    expect(await f.components()).toBeNull();
  });
});
