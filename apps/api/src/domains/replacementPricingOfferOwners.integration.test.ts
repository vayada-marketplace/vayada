import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { createBookingGuestChoiceStore } from "./bookingGuestChoiceStore.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { bookingQuoteAcceptanceRequirements, parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";
import { redeemCurrentQuotePromo } from "./currentQuotePromoRedemption.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { createCurrentPricingQuoteStore } from "./currentPricingQuoteStore.js";
import { lockCurrentPricingQuote } from "./currentPricingQuote.js";
import { parseStoredPricingQuote, storedPricingQuoteStatus } from "@vayada/domain-booking";
import { lockPublicPricingPaymentAmounts } from "./publicPricingPaymentAmounts.js";
import { createFixedChargePolicyStore } from "./fixedChargePolicyStore.js";
import type { FixedChargePolicy } from "./replacementFixedCharges.js";
import { lockPublicPricingChargeTotals } from "./publicPricingChargeTotals.js";
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
type TermsSetup = (terms: Omit<ReplacementOfferTerms, "revision">) => Omit<ReplacementOfferTerms, "revision">;
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing offer owners", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture(configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot, configureTerms?: TermsSetup, enableCard = false) {
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
    const termsInput: Omit<ReplacementOfferTerms, "revision"> = { roomTypeId, offerId: "flex", cancellation: { kind: "non_refundable" }, payment: { kind: "full" } };
    const terms: ReplacementOfferTerms[] = [];
    for (const [room, offerId] of [[roomTypeId, "flex"], [roomTypeId, "other"], [secondRoomId, "flex"]])
      terms.push(await booking.save(context, scope, { requestId: randomUUID(), expectedRevision: null, terms: configureTerms ? configureTerms({ ...termsInput, roomTypeId: room!, offerId: offerId! }) : { ...termsInput, roomTypeId: room, offerId } }));
    await pool.query(`INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
      VALUES($1,true,ARRAY['pay_at_property'],'EUR')`, [propertyId]);
    if (enableCard) {
      const accountId = randomUUID(), evidenceId = randomUUID();
      await pool.query(`INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,onboarding_status,
        charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
        VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,'{"detailsSubmitted":true,"cardPaymentsStatus":"active"}')`,
        [accountId, propertyId, `acct_synthetic_${accountId}`]);
      await pool.query("UPDATE finance.payment_settings SET provider_account_id=$2,accepted_methods=ARRAY['card','pay_at_property'] WHERE property_id=$1", [propertyId, accountId]);
      await pool.query(`INSERT INTO finance.online_card_execution_evidence
        (id,property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,property_readiness_revision,
         evidence_fingerprint_hash,executed_at,accepted_at,accepted_by_organization_id,accepted_by_user_id)
        SELECT $1,s.property_id,s.provider_account_id,'finance-online-card-execution-evidence.v1','onb-25a',a.card_capability_revision,
          s.online_card_readiness_revision,$2,now(),now(),$3,$4 FROM finance.payment_settings s
        JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id WHERE s.property_id=$5`,
        [evidenceId, evidenceId.replaceAll("-", "").repeat(2), organizationId, actorUserId, propertyId]);
    }
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
  async function publicFixture(publish = true, configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot, policy?: FixedChargePolicy, configureTerms?: TermsSetup, enableCard = false) {
    const f = await fixture(configure, configureTerms, enableCard),
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
    if (policy) {
      const saved = await createFixedChargePolicyStore(pool).save(f.context, f.scope, {
        requestId: randomUUID(), expectedRevision: null, policy,
      });
      f.snapshot.ownerReferences.charges = "booking.fixed-charge-policy.v1:" + saved.revision;
    }
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
  it("reads owner evidence before public projection, without granting public access", async () => {
    const f = await publicFixture(false);
    const readOwner = async (scope: { propertyId: string; organizationId: string } = f.scope) => {
      const client = await pool.connect();
      try { await client.query("BEGIN"); return await lockCurrentPricingPublication(client, scope); }
      finally { await client.query("ROLLBACK"); client.release(); }
    };
    expect(await readOwner()).toBeNull(); // A draft cannot satisfy publication.
    await f.publishPrices();
    const before = await f.readPublic();
    expect((await readOwner())?.pmsSourceRevision).toBe(before?.pmsSourceRevision);
    await pool.query("DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id=$1", [f.scope.propertyId]);
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='incomplete' WHERE id=$1", [f.scope.propertyId]);
    expect(await f.readPublic()).toBeNull();
    expect(await readOwner()).toMatchObject({ publication: { revision: 1, currency: "EUR" }, terms: before!.terms, charges: before!.charges });
    expect(await readOwner({ ...f.scope, organizationId: randomUUID() })).toBeNull();
    expect(await readOwner({ ...f.scope, propertyId: "malformed" })).toBeNull();
    for (const sql of [
      "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
      "DELETE FROM identity.organization_resource_links WHERE organization_id=$1 AND product='pms'",
      "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 second' WHERE organization_id=$1",
    ]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN"); await client.query(sql, [f.scope.organizationId]);
        expect(await lockCurrentPricingPublication(client, f.scope)).toBeNull();
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    const external = await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(), expectedRevision: f.choice.revision, authority: "external",
    });
    expect(await readOwner()).toBeNull();
    await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(), expectedRevision: external.revision, authority: "vayada",
    });
    expect(await readOwner()).not.toBeNull();
    await pool.query("UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1", [f.scope.organizationId]);
    expect(await readOwner()).toBeNull();
    await pool.query("UPDATE identity.product_entitlements SET status='active' WHERE organization_id=$1", [f.scope.organizationId]);
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [f.scope.propertyId]);
    expect(await readOwner()).toBeNull();
  });

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
    policy?: FixedChargePolicy,
    configureTerms?: TermsSetup,
    enableCard = false,
  ) {
    const f = await publicFixture(true, configure, policy, configureTerms, enableCard),
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
  async function componentsFixture(policy?: FixedChargePolicy, configureTerms?: TermsSetup, enableCard = false) {
    const f = await stayFixture(familyPrices, policy, configureTerms, enableCard),
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
  const fixedPolicy = (included = false): FixedChargePolicy => ({
    version: "booking.fixed-charges.v1",
    currency: "EUR",
    charges: [
      {
        id: "city",
        name: "Configured city fee",
        unit: "person_night",
        amountMinor: "300",
        minimumAge: 18,
        included,
        collect: "property",
      },
    ],
  });
  async function chargeTotals(
    f: Awaited<ReturnType<typeof componentsFixture>>,
    input: unknown = f.selection,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockPublicPricingChargeTotals(client, f.scope.propertyId, input);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  it("publishes an explicitly adopted fee policy and adds current fees after discounts", async () => {
    const f = await componentsFixture(fixedPolicy()),
      result = await chargeTotals(f);
    expect(result).toMatchObject({
      kind: "pricing_charge_totals",
      subtotalMinor: "20000",
      totalMinor: "20600",
      additionalChargeMinor: "600",
      includedChargeMinor: "0",
      propertyCollectedMinor: "600",
      onlineCollectibleMinor: "20000",
    });
    expect(result?.charges.charges[0]).toMatchObject({ quantity: 2, amountMinor: "600" });
    expect(result?.charges.requestKey).toBe(result?.requestKey);
    expect(result?.componentSources.charges).toBe(result?.charges.sourceRevision);
    expect(result).not.toHaveProperty("dueNowMinor");
    const dates = (
      await pool.query(
        "SELECT (current_date+10)::text AS arrival,(current_date+13)::text AS departure",
      )
    ).rows[0];
    const longer = await chargeTotals(f, {
      ...f.selection,
      checkIn: dates.arrival,
      checkOut: dates.departure,
    });
    expect(longer?.additionalChargeMinor).toBe("1800");
    expect(longer?.charges.basisEvidenceId).not.toBe(result?.charges.basisEvidenceId);
  });
  it("does not add included amounts twice and distinguishes explicit none from legacy confirmation", async () => {
    const included = await componentsFixture(fixedPolicy(true));
    expect(await chargeTotals(included)).toMatchObject({
      subtotalMinor: "20000",
      totalMinor: "20000",
      includedChargeMinor: "600",
      additionalChargeMinor: "0",
      onlineCollectibleMinor: "19400",
    });
    const empty = await componentsFixture({ ...fixedPolicy(), charges: [] });
    expect(await chargeTotals(empty)).toMatchObject({
      totalMinor: "20000",
      additionalChargeMinor: "0",
    });
    const legacy = await componentsFixture();
    expect(await legacy.components()).not.toBeNull();
    expect(await chargeTotals(legacy)).toBeNull();
    // Saving a policy does not silently replace a legacy publication's confirmation.
    await createFixedChargePolicyStore(pool).save(legacy.context, legacy.scope, {
      requestId: randomUUID(),
      expectedRevision: null,
      policy: fixedPolicy(),
    });
    expect(await chargeTotals(legacy)).toBeNull();
  });
  it("invalidates publications after fee edits and rejects stale, foreign and wrong-currency adoption", async () => {
    const f = await componentsFixture(fixedPolicy()),
      before = await chargeTotals(f);
    await createFixedChargePolicyStore(pool).save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: before!.charges.policyRevision,
      policy: { ...fixedPolicy(), charges: [] },
    });
    expect(await f.readPublic()).toBeNull();
    expect(await chargeTotals(f)).toBeNull();
    expect(before?.totalMinor).toBe("20600");
    const other = await publicFixture(false);
    other.snapshot.ownerReferences.charges = f.snapshot.ownerReferences.charges!;
    await expect(other.publishPrices()).rejects.toMatchObject({ code: "denied" });
    other.snapshot.ownerReferences.charges = "booking.fixed-charge-policy.v1:" + randomUUID();
    await expect(other.publishPrices()).rejects.toMatchObject({ code: "denied" });
    const saved = await createFixedChargePolicyStore(pool).save(other.context, other.scope, {
      requestId: randomUUID(),
      expectedRevision: null,
      policy: { ...fixedPolicy(), currency: "USD" },
    });
    other.snapshot.ownerReferences.charges = "booking.fixed-charge-policy.v1:" + saved.revision;
    await expect(other.publishPrices()).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects overallocated included charges and retains current fee locks through consumption", async () => {
    const policy = fixedPolicy(true);
    policy.charges[0]!.amountMinor = "999999";
    const excessive = await componentsFixture(policy);
    expect(await chargeTotals(excessive)).toBeNull();
    const f = await componentsFixture(fixedPolicy()),
      client = await pool.connect();
    const writer = new pg.Pool({ connectionString: url, options: "-c lock_timeout=100", max: 1 });
    try {
      await client.query("BEGIN");
      const read = await lockPublicPricingChargeTotals(client, f.scope.propertyId, f.selection);
      expect(read).not.toBeNull();
      await expect(
        createFixedChargePolicyStore(writer).save(f.context, f.scope, {
          requestId: randomUUID(),
          expectedRevision: read!.charges.policyRevision,
          policy: { ...fixedPolicy(), charges: [] },
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });
  const propertyTerms: TermsSetup = (t) => ({
    ...t,
    payment: { ...t.payment, acceptedMethods: ["pay_at_property"] },
  });
  async function paymentAmounts(
    f: Awaited<ReturnType<typeof componentsFixture>>,
    method: unknown = "pay_at_property",
    input: unknown = f.selection,
  ) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockPublicPricingPaymentAmounts(client, f.scope.propertyId, input, method);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  it("binds an explicit selected-rate method to current Finance and exact deferred amounts", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms);
    const result = await paymentAmounts(f);
    expect(result).toMatchObject({
      kind: "pricing_payment_amounts",
      method: "pay_at_property",
      totalMinor: "20600",
      dueNowMinor: "0",
      dueLaterMinor: "20600",
    });
    expect(result?.selectedTerms).toHaveLength(2);
    expect(result?.financeEvidenceId).toBe((await f.readPublic())?.finance.evidenceId);
    expect(result?.paymentEvidenceId).toMatch(/^booking.payment-amounts.v1:/);
    expect((await paymentAmounts(f))?.paymentEvidenceId).toBe(result?.paymentEvidenceId);
    expect(await paymentAmounts(f, "card")).toBeNull();
    for (const method of [null, {}, "cash", "", ["pay_at_property"]])
      expect(await paymentAmounts(f, method)).toBeNull();
    await pool.query(
      "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await paymentAmounts(f)).toBeNull();
  });
  it("requires selected offer permission without inferring it from Finance or another offer", async () => {
    const legacy = await componentsFixture(fixedPolicy());
    expect(await paymentAmounts(legacy)).toBeNull();
    const f = await componentsFixture(fixedPolicy(), (t) => ({
      ...t,
      payment: {
        kind: "full",
        acceptedMethods: t.offerId === "other" ? ["card"] : ["pay_at_property"],
      },
    }));
    expect(await paymentAmounts(f)).not.toBeNull(); // Unselected 'other' does not veto flex.
    const otherKey = f.bindings.find(
      (b) => b.roomTypeId === f.snapshot.rooms[0].roomTypeId && b.offerId === "other",
    )!.publicOfferKey;
    const mixed = {
      ...f.selection,
      rooms: [f.selection.rooms[0], { ...f.selection.rooms[1], publicOfferKey: otherKey }],
    };
    expect(await paymentAmounts(f, "pay_at_property", mixed)).toBeNull();
    const cardOnly = await componentsFixture(fixedPolicy(), (t) => ({
      ...t,
      payment: { kind: "full", acceptedMethods: ["card"] },
    }));
    expect(await paymentAmounts(cardOnly, "card")).toBeNull(); // Finance does not execute card here.
  });
  it("invalidates payment amounts when allowed methods change in the terms owner", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      before = await paymentAmounts(f);
    const term = before!.selectedTerms[0]!;
    await createBookingPricingOfferTermsStore(pool).save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: term.revision,
      terms: {
        roomTypeId: term.roomTypeId,
        offerId: term.offerId,
        cancellation: term.cancellation,
        payment: { kind: "full", acceptedMethods: ["card"] },
      },
    });
    expect(await paymentAmounts(f)).toBeNull();
    expect(before?.dueLaterMinor).toBe("20600");
  });

  it("collects only online-eligible amounts for card and binds the chosen method", async () => {
    const f = await componentsFixture(
      fixedPolicy(),
      (t) => ({ ...t, payment: { kind: "full", acceptedMethods: ["card", "pay_at_property"] } }),
      true,
    );
    const card = await paymentAmounts(f, "card"),
      property = await paymentAmounts(f);
    expect(card).toMatchObject({ totalMinor: "20600", dueNowMinor: "20000", dueLaterMinor: "600" });
    expect(property).toMatchObject({ totalMinor: "20600", dueNowMinor: "0", dueLaterMinor: "20600" });
    expect(card?.paymentEvidenceId).not.toBe(property?.paymentEvidenceId);
    await pool.query(
      "UPDATE finance.payment_provider_accounts SET charges_enabled=false WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await paymentAmounts(f, "card")).toBeNull();
  });
  it("rejects selected rates with incompatible cancellation terms", async () => {
    const f = await componentsFixture(fixedPolicy(), (t) => ({
      ...propertyTerms(t),
      cancellation:
        t.offerId === "other"
          ? {
              kind: "flexible",
              terms: {
                type: "free_until_days_before_arrival",
                freeCancellationDeadlineDays: 7,
                afterDeadlinePenalty: "full_booking_amount",
                noShowPenalty: "full_booking_amount",
              },
            }
          : t.cancellation,
    }));
    const otherKey = f.bindings.find(
      (b) => b.roomTypeId === f.snapshot.rooms[0].roomTypeId && b.offerId === "other",
    )!.publicOfferKey;
    expect(
      await paymentAmounts(f, "pay_at_property", {
        ...f.selection,
        rooms: [f.selection.rooms[0], { ...f.selection.rooms[1], publicOfferKey: otherKey }],
      }),
    ).toBeNull();
  });

  async function assembledQuote(f: Awaited<ReturnType<typeof componentsFixture>>, lifetime = 300) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockCurrentPricingQuote(
        client,
        f.scope.propertyId,
        f.selection,
        "pay_at_property",
        lifetime,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  it("assembles a validated historical quote with exact lines, nightly records and seven sources", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      record = await assembledQuote(f);
    expect(record).not.toBeNull();
    const quote = record!.quote;
    expect(parseStoredPricingQuote(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
    expect(quote.evidence).toMatchObject({
      totalMinor: "20600",
      dueNowMinor: "0",
      dueLaterMinor: "20600",
      fx: [],
    });
    expect(quote.rooms).toHaveLength(2);
    expect(quote.evidence.terms).toHaveLength(1);
    expect(Object.keys(quote.evidence.revisions).sort()).toEqual([
      "addons",
      "charges",
      "finance",
      "fx",
      "pms",
      "promotions",
      "terms",
    ]);
    expect(quote.evidence.revisions.fx).toMatch(/^booking.no-conversion.v1:/);
    expect(record?.calculation.charges.charges[0]).toMatchObject({ amountMinor: "600", quantity: 2 });
    expect(record?.calculation.addons.lines[0].definition).toHaveProperty("id", f.id);
    expect(
      storedPricingQuoteStatus(
        quote,
        quote.stay,
        quote.evidence.revisions,
        { evaluatorVersion: quote.evaluatorVersion, paymentMethod: quote.paymentMethod },
        new Date(quote.evidence.expiresAt),
      ),
    ).toBe("stale");
    const duration = Date.parse(quote.evidence.expiresAt) - Date.parse(quote.evidence.issuedAt);
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(300000);
    await pool.query("UPDATE booking.addon_definitions SET price_amount=30 WHERE id=$1", [f.id]);
    const changed = await assembledQuote(f);
    expect(changed?.quote.evidence.totalMinor).toBe("22400");
    expect(quote.evidence.totalMinor).toBe("20600");
    expect(
      storedPricingQuoteStatus(
        quote,
        quote.stay,
        changed!.quote.evidence.revisions,
        { evaluatorVersion: quote.evaluatorVersion, paymentMethod: quote.paymentMethod },
        new Date(quote.evidence.issuedAt),
      ),
    ).toBe("stale");
  });
  it("preserves included fee detail without an additive line and rejects invalid lifetimes", async () => {
    const f = await componentsFixture(fixedPolicy(true), propertyTerms),
      record = await assembledQuote(f);
    expect(record?.quote.evidence.totalMinor).toBe("20000");
    expect(record?.quote.evidence.lines.filter((line) => line.kind === "charge")).toEqual([]);
    expect(record?.calculation.charges.charges[0]).toMatchObject({
      included: true,
      amountMinor: "600",
    });
    for (const lifetime of [0, -1, 901, 1.5, NaN])
      expect(await assembledQuote(f, lifetime)).toBeNull();
  });

  it("persists exact quote history and replays the original request after repricing", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
    const first = await store.issue(f.scope.propertyId, command);
    expect(first.replayed).toBe(false);
    expect((await store.read(f.scope.propertyId, first.quote.quoteId))?.quote).toEqual(first.quote);
    await pool.query("UPDATE booking.addon_definitions SET price_amount=30 WHERE id=$1", [f.id]);
    expect(await store.issue(f.scope.propertyId, command)).toEqual({ ...first, replayed: true });
    const next = await store.issue(f.scope.propertyId, { ...command, requestId: randomUUID() });
    expect(next.quote.evidence.totalMinor).toBe("22400");
    expect(first.quote.evidence.totalMinor).toBe("20600");
    expect(next.quote.quoteId).not.toBe(first.quote.quoteId);
    await expect(
      store.issue(f.scope.propertyId, { ...command, selection: { ...f.selection, promoCode: null } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      store.issue(f.scope.propertyId, { ...command, paymentMethod: "card" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    // Returned objects cannot mutate persisted history.
    (
      first as unknown as { quote: { evidence: { lines: { amountMinor: string }[] } } }
    ).quote.evidence.lines[0]!.amountMinor = "1";
    expect(
      (await store.read(f.scope.propertyId, first.quote.quoteId))?.quote.evidence.lines[0]!
        .amountMinor,
    ).not.toBe("1");
  });
  it("serializes concurrent quote issuance and enforces append-only storage", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
    const issued = await Promise.all([
      store.issue(f.scope.propertyId, command),
      store.issue(f.scope.propertyId, command),
    ]);
    expect(new Set(issued.map((r) => r.quote.quoteId)).size).toBe(1);
    expect(issued.map((r) => r.replayed).sort()).toEqual([false, true]);
    for (const sql of [
      "UPDATE booking.pricing_quotes SET request_id='changed' WHERE id=$1",
      "DELETE FROM booking.pricing_quotes WHERE id=$1",
    ])
      await expect(pool.query(sql, [issued[0]!.quote.quoteId])).rejects.toMatchObject({
        code: "55000",
      });
    await expect(pool.query("TRUNCATE booking.pricing_quotes CASCADE")).rejects.toMatchObject({
      code: "55000",
    });
  });
  it("reauthorizes replay/readback and isolates records by property", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      other = await componentsFixture(fixedPolicy(), propertyTerms);
    const store = createCurrentPricingQuoteStore(pool, 300),
      command = { requestId: randomUUID(), selection: f.selection, paymentMethod: "pay_at_property" };
    const first = await store.issue(f.scope.propertyId, command);
    expect(await store.read(other.scope.propertyId, first.quote.quoteId)).toBeNull();
    expect(await store.read(f.scope.propertyId, randomUUID())).toBeNull();
    expect(await store.read(f.scope.propertyId, "bad-id")).toBeNull();
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='private' WHERE id=$1", [
      f.scope.propertyId,
    ]);
    expect(await store.read(f.scope.propertyId, first.quote.quoteId)).toBeNull();
    await expect(store.issue(f.scope.propertyId, command)).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects unavailable or malformed issuance without leaving a stored quote", async () => {
    const f = await componentsFixture(fixedPolicy()),
      store = createCurrentPricingQuoteStore(pool, 300);
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
    await expect(store.issue(f.scope.propertyId, command)).rejects.toMatchObject({ code: "denied" });
    for (const input of [
      { ...command, requestId: " " },
      { ...command, extra: true },
      { ...command, selection: {} },
      { ...command, paymentMethod: "cash" },
    ])
      await expect(store.issue(f.scope.propertyId, input)).rejects.toMatchObject({ code: "invalid" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM booking.pricing_quotes WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("returns expired historical quotes on retry without extending their lifetime", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms);
    const store = createCurrentPricingQuoteStore(pool, 1);
    const command = { requestId: randomUUID(), selection: f.selection, paymentMethod: "pay_at_property" };
    const first = await store.issue(f.scope.propertyId, command);
    await pool.query("SELECT pg_sleep(1.1)");
    const replay = await store.issue(f.scope.propertyId, command);
    expect(replay.replayed).toBe(true);
    expect(replay.quote).toEqual(first.quote);
    expect(Date.parse(replay.quote.evidence.expiresAt)).toBeLessThan(Date.now());
    expect((await store.read(f.scope.propertyId, first.quote.quoteId))?.quote).toEqual(first.quote);
  });

  async function revalidate(f: Awaited<ReturnType<typeof componentsFixture>>, quoteId: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockCurrentQuoteRevalidation(client, f.scope.propertyId, quoteId);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  it("revalidates exact stored prices without issuing a new quote or extending expiry", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const original = await store.issue(f.scope.propertyId, {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    });
    const verified = await revalidate(f, original.quote.quoteId);
    expect(verified).toMatchObject({
      kind: "current_quote_price",
      quote: original.quote,
      sameDay: { eligible: true, reason: "not_same_day" },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM booking.pricing_quotes WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
    const other = await componentsFixture(fixedPolicy(), propertyTerms);
    expect(await revalidate(other, original.quote.quoteId)).toBeNull();
    expect(await revalidate(f, randomUUID())).toBeNull();
    expect(await revalidate(f, "invalid")).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET name='Changed description' WHERE id=$1", [
      f.id,
    ]);
    expect(await revalidate(f, original.quote.quoteId)).toBeNull(); // Source changes count even at the same total.
    expect((await store.read(f.scope.propertyId, original.quote.quoteId))?.quote).toEqual(
      original.quote,
    );
  });
  it("rejects changed charge policies, revoked public access and expired quotes", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 1);
    const original = await store.issue(f.scope.propertyId, {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    });
    await pool.query("SELECT pg_sleep(1.1)");
    expect(await revalidate(f, original.quote.quoteId)).toBeNull();
    const liveStore = createCurrentPricingQuoteStore(pool, 300);
    const live = await liveStore.issue(f.scope.propertyId, {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    });
    const policy = (
      await pool.query("SELECT revision FROM booking.fixed_charge_heads WHERE property_id=$1", [
        f.scope.propertyId,
      ])
    ).rows[0];
    await createFixedChargePolicyStore(pool).save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: policy.revision,
      policy: { ...fixedPolicy(), charges: [] },
    });
    expect(await revalidate(f, live.quote.quoteId)).toBeNull();
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='private' WHERE id=$1", [
      f.scope.propertyId,
    ]);
    expect(await revalidate(f, live.quote.quoteId)).toBeNull();
  });
  it("checks current same-day policy and rejects a passed cutoff", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const dates = (
      await pool.query(
        "SELECT today::text AS arrival,(today+1)::text AS departure FROM (SELECT (clock_timestamp() AT TIME ZONE 'Etc/UTC')::date AS today) dates",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO booking.same_day_booking_policies(property_id,enabled,cutoff_local_time) VALUES($1,true,NULL)",
      [f.scope.propertyId],
    );
    const original = await store.issue(f.scope.propertyId, {
      requestId: randomUUID(),
      selection: { ...f.selection, checkIn: dates.arrival, checkOut: dates.departure },
      paymentMethod: "pay_at_property",
    });
    expect(await revalidate(f, original.quote.quoteId)).toMatchObject({
      sameDay: { eligible: true, reason: "before_cutoff" },
    });
    await pool.query(
      "UPDATE booking.same_day_booking_policies SET enabled=false,revision=revision+1 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await revalidate(f, original.quote.quoteId)).toBeNull();
    await pool.query(
      "UPDATE booking.same_day_booking_policies SET enabled=true,cutoff_local_time='00:00',revision=revision+1 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await revalidate(f, original.quote.quoteId)).toBeNull();
  });
  it("retains current owner locks for the caller's subsequent acceptance work", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const original = await store.issue(f.scope.propertyId, {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    });
    const client = await pool.connect(),
      writer = new pg.Pool({ connectionString: url, options: "-c lock_timeout=100", max: 1 });
    try {
      await client.query("BEGIN");
      expect(
        await lockCurrentQuoteRevalidation(client, f.scope.propertyId, original.quote.quoteId),
      ).not.toBeNull();
      await expect(
        writer.query("UPDATE booking.addon_definitions SET price_amount=99 WHERE id=$1", [f.id]),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
          [f.scope.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });

  async function redemptionFixture(nonstack = false, maximum = 100) {
    const f = await componentsFixture(fixedPolicy(), propertyTerms);
    if (nonstack)
      await pool.query(
        "UPDATE booking.booking_settings SET last_minute_discount=jsonb_set(last_minute_discount,'{stackWithPromo}','false') WHERE property_id=$1",
        [f.scope.propertyId],
      );
    await pool.query("UPDATE booking.promo_definitions SET max_uses=$2 WHERE property_id=$1", [
      f.scope.propertyId,
      maximum,
    ]);
    const store = createCurrentPricingQuoteStore(pool, 300);
    const quote = (
      await store.issue(f.scope.propertyId, {
        requestId: randomUUID(),
        selection: f.selection,
        paymentMethod: "pay_at_property",
      })
    ).quote;
    const booking = async (q = quote) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,room_count,currency,total_amount,booking_metadata)
        VALUES($1::uuid,$2,($1::uuid)::text,'draft',$3,$4,$5,$6,$7::numeric/100,$8)`,
        [
          id,
          f.scope.propertyId,
          q.stay.checkIn,
          q.stay.checkOut,
          q.stay.rooms.length,
          q.stay.currency,
          q.evidence.totalMinor,
          { pricingQuoteId: q.quoteId },
        ],
      );
      return id;
    };
    const id = await booking();
    const apply = async (bookingId = id, quoteId = quote.quoteId, commit = true) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await redeemCurrentQuotePromo(
          client,
          f.scope.propertyId,
          quoteId,
          bookingId,
        );
        await client.query(commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    };
    const uses = async () =>
      (
        await pool.query(
          "SELECT current_uses FROM booking.promo_definitions WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].current_uses;
    return { f, quote, id, booking, apply, uses, store };
  }
  it("redeems the exact applied code amount once and rolls redemption back with the caller", async () => {
    const r = await redemptionFixture();
    expect(await r.apply(r.id, r.quote.quoteId, false)).toMatchObject({
      kind: "applied",
      discountMinor: "2000",
      replayed: false,
    });
    expect(await r.uses()).toBe(0);
    const first = await r.apply();
    expect(first).toMatchObject({ kind: "applied", discountMinor: "2000", replayed: false });
    expect(await r.apply()).toEqual({ ...first, replayed: true });
    expect(await r.uses()).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT discount_amount::text AS amount FROM booking.promo_applications WHERE guest_booking_id=$1",
          [r.id],
        )
      ).rows,
    ).toEqual([{ amount: "20.00" }]);
  });
  it("rejects another booking using a redeemed quote and rejects mismatched booking evidence", async () => {
    const r = await redemptionFixture();
    await r.apply();
    await expect(r.apply(await r.booking())).rejects.toThrow("Quote promotion is unavailable");
    await pool.query("UPDATE booking.guest_bookings SET total_amount=1 WHERE id=$1", [r.id]);
    await expect(r.apply()).rejects.toThrow("Quote promotion is unavailable");
    expect(await r.uses()).toBe(1);
  });
  it("does not consume a code when the nonstacking last-minute discount wins", async () => {
    const r = await redemptionFixture(true);
    expect(await r.apply()).toEqual({ kind: "not_applied" });
    expect(await r.uses()).toBe(0);
  });
  it("rejects changed promotion evidence before consumption", async () => {
    const r = await redemptionFixture();
    await pool.query(
      "UPDATE booking.promo_definitions SET discount_value=11 WHERE property_id=$1",
      [r.f.scope.propertyId],
    );
    await expect(r.apply()).rejects.toThrow("Quote promotion is unavailable");
    expect(await r.uses()).toBe(0);
  });
  it("lets only one concurrent quote consume the final promotion use", async () => {
    const r = await redemptionFixture(false, 1);
    const other = (
      await r.store.issue(r.f.scope.propertyId, {
        requestId: randomUUID(),
        selection: r.f.selection,
        paymentMethod: "pay_at_property",
      })
    ).quote;
    const otherBooking = await r.booking(other);
    const results = await Promise.allSettled([r.apply(), r.apply(otherBooking, other.quoteId)]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((v) => v.status === "rejected")).toHaveLength(1);
    expect(await r.uses()).toBe(1);
  });

  async function acceptanceFixture(child = false) {
    const f = await componentsFixture(fixedPolicy(), propertyTerms);
    const selection = child
      ? {
          ...f.selection,
          rooms: f.selection.rooms.map((r, i) =>
            i === 0 ? { ...r, guests: { adults: 1, childAgesAtCheckIn: [8] } } : r,
          ),
        }
      : f.selection;
    const quote = (
      await createCurrentPricingQuoteStore(pool, 300).issue(f.scope.propertyId, {
        requestId: randomUUID(),
        selection,
        paymentMethod: "pay_at_property",
      })
    ).quote;
    // Synthetic policy-owner evidence: this helper does not claim owner freshness.
    const policy = {
      propertyId: f.scope.propertyId,
      sourceRevision: "guest-policy:1",
      disclosureHash: "sha256:" + "a".repeat(64),
      choices: {
        defaultGuestLanguage: "en",
        childrenEnabled: true,
        adultAgeThreshold: 18,
        phoneRequired: true,
        arrivalTimeEnabled: false,
        specialRequestsEnabled: true,
        checkInTime: "15:00",
        checkOutTime: "11:00",
      },
    };
    const ack = (p = policy) => {
      const r = bookingQuoteAcceptanceRequirements(quote, p)!;
      expect(r).not.toBeNull();
      return {
        accepted: true,
        quoteEvidenceId: r.quoteEvidenceId,
        guestPolicyEvidenceId: r.guestPolicyEvidenceId,
      };
    };
    const input = {
      version: "booking-quote-acceptance.v1",
      requestId: "accept-one",
      quoteId: quote.quoteId,
      acceptance: ack(),
      guest: {
        firstName: " Ada ",
        lastName: "Lovelace",
        email: " ADA@example.test ",
        phone: "+44 12345678",
        countryCode: "GB",
        arrivalTime: null,
        specialRequests: " Quiet room please. ",
      },
    };
    return { quote, policy, input, ack, scope: f.scope };
  }
  it("binds guest acknowledgment to the exact quote and policy, with deterministic normalized identity", async () => {
    const f = await acceptanceFixture();
    const parsed = parseBookingQuoteAcceptanceInput(f.input, f.quote, f.policy)!;
    expect(parsed).toMatchObject({
      guest: { firstName: "Ada", email: "ada@example.test", specialRequests: "Quiet room please." },
    });
    expect(parsed.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      parseBookingQuoteAcceptanceInput(
        { ...f.input, requestId: "another", guest: parsed.guest },
        f.quote,
        f.policy,
      )?.fingerprint,
    ).toBe(parsed.fingerprint);
    expect(
      parseBookingQuoteAcceptanceInput(
        { ...f.input, guest: { ...f.input.guest, firstName: "Grace" } },
        f.quote,
        f.policy,
      )?.fingerprint,
    ).not.toBe(parsed.fingerprint);
    expect(
      parseBookingQuoteAcceptanceInput(f.input, f.quote, {
        ...f.policy,
        sourceRevision: "guest-policy:2",
      }),
    ).toBeNull();
    expect(
      parseBookingQuoteAcceptanceInput(
        { ...f.input, acceptance: { ...f.input.acceptance, quoteEvidenceId: "old" } },
        f.quote,
        f.policy,
      ),
    ).toBeNull();
  });
  it("rejects missing acknowledgment, malformed guest data and posted authority or amounts", async () => {
    const f = await acceptanceFixture();
    for (const input of [
      { ...f.input, totalMinor: "1" },
      { ...f.input, propertyId: f.policy.propertyId },
      { ...f.input, acceptance: { ...f.input.acceptance, accepted: false } },
      ...[
        { firstName: " " },
        { email: "bad-address" },
        { phone: null },
        { phone: "\u0000" },
        { arrivalTime: "24:00" },
        { countryCode: "UKK" },
        { specialRequests: "x".repeat(2001) },
        { firstName: "Ada\nOther" },
      ].map((guest) => ({ ...f.input, guest: { ...f.input.guest, ...guest } })),
    ])
      expect(parseBookingQuoteAcceptanceInput(input, f.quote, f.policy)).toBeNull();
  });
  it("honors current phone, arrival and special-request controls without silent fallback", async () => {
    const f = await acceptanceFixture();
    const policy = {
      ...f.policy,
      choices: {
        ...f.policy.choices,
        phoneRequired: false,
        arrivalTimeEnabled: true,
        specialRequestsEnabled: false,
      },
    };
    const input = {
      ...f.input,
      acceptance: f.ack(policy),
      guest: { ...f.input.guest, phone: null, arrivalTime: "18:30", specialRequests: null },
    };
    expect(parseBookingQuoteAcceptanceInput(input, f.quote, policy)).not.toBeNull();
    expect(
      parseBookingQuoteAcceptanceInput(
        { ...input, guest: { ...input.guest, specialRequests: "Please" } },
        f.quote,
        policy,
      ),
    ).toBeNull();
  });
  it("rejects child allocations outside the acknowledged guest policy", async () => {
    const f = await acceptanceFixture(true);
    expect(parseBookingQuoteAcceptanceInput(f.input, f.quote, f.policy)).not.toBeNull();
    for (const choices of [
      { ...f.policy.choices, childrenEnabled: false },
      { ...f.policy.choices, adultAgeThreshold: 8 },
    ]) {
      const policy = { ...f.policy, choices };
      expect(
        parseBookingQuoteAcceptanceInput(
          { ...f.input, acceptance: f.ack(policy) },
          f.quote,
          policy,
        ),
      ).toBeNull();
    }
  });

  it("reads saved replacement guest rules into a real current quote disclosure without legacy fallback", async () => {
    const f = await acceptanceFixture();
    const read = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockCurrentQuoteGuestDisclosure(client, f.scope.propertyId, f.quote.quoteId);
      } finally { await client.query("ROLLBACK"); client.release(); }
    };
    expect(await read()).toBeNull();
    const store = createBookingGuestChoiceStore(pool, () => ({ async authorizeGuestPolicyScope(scope) {
      expect(scope).toMatchObject(f.scope); return true;
    } }));
    const saved = await store.save(f.scope, { requestId: randomUUID(), expectedRevision: null, confirmed: true, choices: f.policy.choices });
    const disclosure = await read();
    expect(disclosure!.policy.sourceRevision).toBe(`guest-choices:${saved.revision}`);
    expect(disclosure!.disclosure.choices).toEqual(f.policy.choices);
    expect(disclosure!.quote).toEqual(f.quote);
    expect(parseBookingQuoteAcceptanceInput({ ...f.input, acceptance: { accepted: true, quoteEvidenceId: disclosure!.quoteEvidenceId, guestPolicyEvidenceId: disclosure!.guestPolicyEvidenceId } }, disclosure!.quote, disclosure!.policy)).not.toBeNull();
  });

});
