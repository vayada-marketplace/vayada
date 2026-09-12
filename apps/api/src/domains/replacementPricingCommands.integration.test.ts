import Fastify from "fastify";
import { registerReplacementPricingRoutes } from "../routes/replacementPricing.js";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createBookingPricingOfferTermsStore } from "./bookingPricingOfferTerms.js";
import { replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import { createReplacementPricingCommands } from "./replacementPricingCommands.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("trusted replacement pricing commands", () => {
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
    const proposed = { currency: "EUR",
      rooms: [roomTypeId, secondRoomId].map((id) => ({
        version: "pricing.v2", propertyId, roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: 2, adults: 2, children: 0 },
        children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
        offers: terms.filter((t) => t.roomTypeId === id).map((t) => ({ id: t.offerId, termsRevision: t.revision,
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: "10000" }, months: [], seasons: [], weekdays: [], dates: [] } },
          restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] },
        })),
      })) };
    const commands = createReplacementPricingCommands(pool, context);
    const prepared = await commands.prepare(propertyId, proposed), draftId = randomUUID();
    const draft = { draftId, expectedDraftRevision: 0, baseRevision: 0, ...prepared };
    return { commands, context, scope, proposed, prepared, draft, membershipId };
  }
  async function confirmed(f: Awaited<ReturnType<typeof fixture>>) {
    const propertyId = f.scope.propertyId;
    expect(await f.commands.saveDraft(propertyId, f.draft)).toBe(1);
    const charges = await f.commands.confirmCharges(propertyId, { draftId: f.draft.draftId, expectedDraftRevision: 1,
      claimedFingerprint: replacementChargeFingerprint(propertyId, f.prepared.snapshot, f.prepared.effectiveSources ?? f.prepared.sources)!,
      declaration: "all_mandatory_charges_included", requestId: randomUUID() });
    const snapshot = { ...f.prepared.snapshot, ownerReferences: { ...f.prepared.snapshot.ownerReferences, charges: charges.id } };
    expect(await f.commands.saveDraft(propertyId, { ...f.draft, expectedDraftRevision: 1, snapshot })).toBe(2);
    return { requestId: randomUUID(), expectedRevision: f.draft.baseRevision, sources: f.prepared.sources, ...(f.prepared.effectiveSources ? { effectiveSources: f.prepared.effectiveSources } : {}), snapshot, draft: { id: f.draft.draftId, revision: 2 } };
  }
  async function counts(propertyId: string) {
    return (await pool.query(`SELECT
      (SELECT count(*)::int FROM pms.pricing_v2_drafts WHERE property_id=$1) AS drafts,
      (SELECT count(*)::int FROM pms.pricing_v2_revisions WHERE property_id=$1) AS revisions,
      (SELECT count(*)::int FROM platform.domain_events WHERE property_id=$1 AND event_type='pricing.v2.revised') AS events`, [propertyId])).rows[0];
  }
  it("prepares without writes and runs the complete draft/confirmation/publication flow", async () => {
    const f = await fixture(), id = f.scope.propertyId;
    expect(await counts(id)).toEqual({ drafts: 0, revisions: 0, events: 0 });
    expect(f.prepared.snapshot.ownerReferences).toEqual({ finance: expect.stringMatching(/^finance\.pricing\.v2:/) });
    expect(await f.commands.prepare(id.toUpperCase(), f.proposed)).toEqual(f.prepared);
    const command = await confirmed(f);
    expect(await f.commands.publish(id, command)).toEqual({ revision: 1, replayed: false });
    expect(await f.commands.publish(id, command)).toEqual({ revision: 1, replayed: true });
    expect(await counts(id)).toEqual({ drafts: 1, revisions: 1, events: 1 });
    expect(await f.commands.read(id)).toMatchObject({ revision: 1, stale: false });
  });
  it("retains distinct calendar occupancy settings through trusted publication and readback", async () => {
    const f = await fixture(), id = f.scope.propertyId, room = f.proposed.rooms[0];
    const base = { mode: "included_guests", baseGuests: 2, baseMinor: "13000", adjustments: [{ kind: "fixed", deltaMinor: "-3025" }, { kind: "fixed", deltaMinor: "0" }] };
    const month = { mode: "included_guests", baseGuests: 1, baseMinor: "24025", adjustments: [{ kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 1575 }] };
    const season = { mode: "included_guests", baseGuests: 2, baseMinor: "26025", adjustments: [{ kind: "percentage", basisPoints: -1250 }, { kind: "fixed", deltaMinor: "0" }] };
    const date = { ...month, baseMinor: "30000", adjustments: [{ kind: "fixed", deltaMinor: "0" }, { kind: "fixed", deltaMinor: "1825" }] };
    const linkedDate = { ...month, baseMinor: "40000", adjustments: [{ kind: "fixed", deltaMinor: "0" }, { kind: "percentage", basisPoints: 2250 }] };
    const proposed = { ...f.proposed, rooms: [{ ...room, offers: [
      { ...room.offers[0], price: { kind: "independent", calendar: { base, months: [{ month: 9, price: month }],
        seasons: [{ name: "Spring", tier: "high", from: "03-01", through: "03-31", price: season }],
        weekdays: [{ day: 0, adjustment: { kind: "fixed", deltaMinor: "100" } }], dates: [{ date: "2027-03-01", price: date }] } } },
      { ...room.offers[1], price: { kind: "linked", parentId: room.offers[0].id, adjustment: { kind: "percentage", basisPoints: -1000 },
        dateOverrides: [{ date: "2027-03-01", price: linkedDate }] }, restrictions: { kind: "inherit" } },
    ] }, f.proposed.rooms[1]] };
    const prepared = await f.commands.prepare(id, proposed);
    expect(prepared.snapshot.rooms).toEqual(proposed.rooms);
    const draft = { ...f.draft, ...prepared }, command = await confirmed({ ...f, prepared, draft });
    expect((await f.commands.readDraft(id, draft.draftId))?.snapshot.rooms).toEqual(proposed.rooms);
    expect(await f.commands.publish(id, command)).toEqual({ revision: 1, replayed: false });
    expect(await f.commands.publish(id, command)).toEqual({ revision: 1, replayed: true });
    const published = await f.commands.read(id);
    expect(published).toMatchObject({ revision: 1, stale: false });
    expect(published?.rooms).toEqual([...proposed.rooms].sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId)));
    const stored = await pool.query("SELECT configuration FROM pms.pricing_v2_rooms WHERE property_id=$1 AND revision=1 ORDER BY room_type_id", [id]);
    expect(stored.rows.map((row) => row.configuration)).toEqual([...proposed.rooms].sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId)));
    expect(await counts(id)).toEqual({ drafts: 1, revisions: 1, events: 1 });
  });
  it("requires exact saved draft binding for every new publication", async () => {
    const f = await fixture(), id = f.scope.propertyId, command = await confirmed(f);
    for (const draft of [undefined, null])
      await expect(f.commands.publish(id, { ...command, draft } as unknown as typeof command)).rejects.toMatchObject({ code: "invalid" });
    for (const draft of [{ id: randomUUID(), revision: 2 }, { id: command.draft.id, revision: 1 }])
      await expect(f.commands.publish(id, { ...command, draft })).rejects.toMatchObject({ code: "stale" });
    await f.commands.saveDraft(id, { ...f.draft, expectedDraftRevision: 2 }); // Remove declaration; changes saved draft.
    await expect(f.commands.publish(id, command)).rejects.toMatchObject({ code: "stale" });
    expect(await counts(id)).toEqual({ drafts: 1, revisions: 0, events: 0 });
  });
  it("preserves accepted receipts after draft deletion/source changes but rechecks access", async () => {
    const f = await fixture(), id = f.scope.propertyId, command = await confirmed(f);
    await f.commands.publish(id, command);
    await pool.query("DELETE FROM pms.pricing_v2_drafts WHERE property_id=$1", [id]);
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [id]);
    expect(await f.commands.publish(id, command)).toEqual({ revision: 1, replayed: true });
    await expect(f.commands.publish(id, { ...command, draft: { ...command.draft, revision: 3 } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [f.membershipId]);
    await expect(f.commands.publish(id, command)).rejects.toMatchObject({ code: "denied" });
    expect(await counts(id)).toEqual({ drafts: 0, revisions: 1, events: 1 });
  });
  it("rejects stale prepared sources and unavailable current readiness", async () => {
    const f = await fixture(), id = f.scope.propertyId;
    await pool.query("UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1", [id]);
    await expect(f.commands.saveDraft(id, f.draft)).rejects.toMatchObject({ code: "stale" });
    const next = await f.commands.prepare(id, f.proposed);
    expect(next.sources.finance).not.toBe(f.prepared.sources.finance);
    expect(await f.commands.saveDraft(id, { ...f.draft, ...next })).toBe(1);
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [id]);
    await expect(f.commands.prepare(id, f.proposed)).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects malformed, foreign, inactive and stale-term proposals and untrusted identity", async () => {
    const f = await fixture(), other = await fixture(), id = f.scope.propertyId;
    for (const proposed of [null, { ...f.proposed, ownerReferences: { finance: "forged" } }, { ...f.proposed, rooms: [] },
      { ...f.proposed, rooms: [f.proposed.rooms[0], f.proposed.rooms[0]] }, other.proposed])
      await expect(f.commands.prepare(id, proposed)).rejects.toMatchObject({ code: "invalid" });
    const foreignRoom = { ...other.proposed.rooms[0], propertyId: id };
    await expect(f.commands.prepare(id, { ...f.proposed, rooms: [foreignRoom] })).rejects.toMatchObject({ code: "denied" });
    const stale = structuredClone(f.proposed); stale.rooms[0].offers[0].termsRevision = randomUUID();
    await expect(f.commands.prepare(id, stale)).rejects.toMatchObject({ code: "denied" });
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.proposed.rooms[0].roomTypeId]);
    await expect(f.commands.prepare(id, f.proposed)).rejects.toMatchObject({ code: "denied" });
    await expect(other.commands.prepare(id, f.proposed)).rejects.toMatchObject({ code: "denied" });
    await expect(createReplacementPricingCommands(pool, null).prepare(id, f.proposed)).rejects.toMatchObject({ code: "denied" });
  });
  it("executes the protected HTTP flow against real pricing owners and storage", async () => {
    const f = await fixture(), id = f.scope.propertyId, app = Fastify();
    app.decorateRequest("authContext", null); app.addHook("onRequest", async (request) => { request.authContext = f.context; });
    await app.register(registerReplacementPricingRoutes, { commands: (context) => createReplacementPricingCommands(pool, context) });
    const base = `/properties/${id}/pricing-v2`, draftPath = `${base}/drafts/${f.draft.draftId}`;
    try {
      const room = f.proposed.rooms[0], offer = room.offers[0], termsPath = `${base}/rooms/${room.roomTypeId}/offers/${offer.id}/terms`;
      const read = await app.inject({ url: termsPath }); expect(read.statusCode).toBe(200);
      const policy = { expectedRevision: read.json().revision, cancellation: { kind: "non_refundable" }, payment: { kind: "full" } };
      expect((await app.inject({ method: "PUT", url: termsPath, headers: { "idempotency-key": "retired" }, payload: policy })).statusCode).toBe(403);
      const candidatePath = `${draftPath}/rooms/${room.roomTypeId}/offers/${offer.id}/terms`;
      const stagedPolicy = { ...policy, baseRevision: 0 };
      const update = await app.inject({ method: "PUT", url: candidatePath, headers: { "idempotency-key": "http-terms" }, payload: stagedPolicy });
      expect(update.statusCode).toBe(200); expect(update.json().revision).not.toBe(policy.expectedRevision);
      expect((await app.inject({ method: "PUT", url: candidatePath, headers: { "idempotency-key": "http-terms" }, payload: stagedPolicy })).json()).toEqual(update.json());
      expect((await app.inject({ url: termsPath })).json()).toEqual(read.json());
      expect((await app.inject({ url: `${candidatePath}?revision=1` })).statusCode).toBe(404);
      offer.termsRevision = update.json().revision;
      const prep = await app.inject({ method: "POST", url: `${base}/prepare`, payload: { ...f.proposed, draft: { draftId: f.draft.draftId, baseRevision: 0 } } });
      expect(prep.statusCode).toBe(200); const prepared = prep.json();
      expect((await app.inject({ method: "PUT", url: draftPath, payload: { expectedDraftRevision: 0, baseRevision: 0, ...prepared } })).json()).toEqual({ revision: 1 });
      expect((await app.inject({ url: `${candidatePath}?revision=1` })).json()).toEqual(update.json());
      expect((await app.inject({ url: `${candidatePath}?revision=2` })).statusCode).toBe(409);
      expect((await app.inject({ url: termsPath })).json()).toEqual(read.json());
      const review = await app.inject({ url: `${draftPath}/charge-review` }); expect(review.statusCode).toBe(200);
      expect(review.json()).toMatchObject({ draftId: f.draft.draftId, revision: 1, snapshot: prepared.snapshot, declaration: "all_mandatory_charges_included" });
      expect((await pool.query("SELECT count(*)::int AS n FROM pms.pricing_v2_charge_declarations WHERE property_id=$1", [id])).rows[0].n).toBe(0);
      const confirmation = await app.inject({ method: "POST", url: `${base}/charges`, headers: { "idempotency-key": "http-confirm" },
        payload: { draftId: f.draft.draftId, expectedDraftRevision: 1, claimedFingerprint: review.json().fingerprint, declaration: review.json().declaration } });
      expect(confirmation.statusCode).toBe(200);
      const snapshot = { ...prepared.snapshot, ownerReferences: { ...prepared.snapshot.ownerReferences, charges: confirmation.json().id } };
      expect((await app.inject({ method: "PUT", url: draftPath, payload: { expectedDraftRevision: 1, baseRevision: 0, sources: prepared.sources, effectiveSources: prepared.effectiveSources, snapshot } })).json()).toEqual({ revision: 2 });
      const payload = { expectedRevision: 0, sources: prepared.sources, effectiveSources: prepared.effectiveSources, snapshot, draft: { id: f.draft.draftId, revision: 2 } };
      for (const replayed of [false, true]) expect((await app.inject({ method: "POST", url: `${base}/publish`, headers: { "idempotency-key": "http-publish" }, payload })).json()).toEqual({ revision: 1, replayed });
      expect((await app.inject({ url: termsPath })).json()).toEqual(update.json());
      await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [f.membershipId]);
      expect((await app.inject({ method: "POST", url: `${base}/publish`, headers: { "idempotency-key": "http-publish" }, payload })).statusCode).toBe(403);
      expect(await counts(id)).toEqual({ drafts: 1, revisions: 1, events: 1 });
    } finally { await app.close(); }
  });
  it("rejects old charge reviews after draft edits and stale-source reviews without writing confirmation", async () => {
    const f = await fixture(), id = f.scope.propertyId;
    expect(await f.commands.reviewCharges(id, randomUUID())).toBeNull();
    await f.commands.saveDraft(id, f.draft);
    const review = (await f.commands.reviewCharges(id, f.draft.draftId))!;
    expect(review.fingerprint).toBe(replacementChargeFingerprint(id, f.prepared.snapshot, f.prepared.sources));
    const edited = { ...f.prepared.snapshot, rooms: f.prepared.snapshot.rooms.map((room, index) => index ? room :
      { ...room, children: { ...room.children, bands: room.children.bands.map((band) => ({ ...band, nightlyMinor: "100" })) } }) };
    await f.commands.saveDraft(id, { ...f.draft, expectedDraftRevision: 1, snapshot: edited });
    const confirmation = { draftId: f.draft.draftId, expectedDraftRevision: 1, claimedFingerprint: review.fingerprint,
      declaration: review.declaration, requestId: randomUUID() };
    await expect(f.commands.confirmCharges(id, confirmation)).rejects.toMatchObject({ code: "stale" });
    await expect(f.commands.confirmCharges(id, { ...confirmation, expectedDraftRevision: 2 })).rejects.toMatchObject({ code: "stale" });
    const latestReview = (await f.commands.reviewCharges(id, f.draft.draftId))!;
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [id]);
    const app = Fastify(); app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => { request.authContext = f.context; });
    await app.register(registerReplacementPricingRoutes, { commands: (context) => createReplacementPricingCommands(pool, context) });
    try {
      const response = await app.inject({ method: "POST", url: `/properties/${id}/pricing-v2/charges`, headers: { "idempotency-key": "stale-review" },
        payload: { draftId: f.draft.draftId, expectedDraftRevision: latestReview.revision, claimedFingerprint: latestReview.fingerprint, declaration: latestReview.declaration } });
      expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ code: "stale" });
    } finally { await app.close(); }
    await expect(f.commands.reviewCharges(id, f.draft.draftId)).rejects.toMatchObject({ code: "stale" });
    expect((await pool.query("SELECT count(*)::int AS n FROM pms.pricing_v2_charge_declarations WHERE property_id=$1", [id])).rows[0].n).toBe(0);
  });
  async function candidateFixture() {
    const f = await fixture(), id = f.scope.propertyId;
    const initial = await confirmed(f); await f.commands.publish(id, initial);
    const baseline = (await f.commands.read(id))!, room = baseline.rooms[0]!, offer = room.offers[0]!;
    const context = { draftId: randomUUID(), baseRevision: baseline.revision };
    const policy = { roomTypeId: room.roomTypeId, offerId: offer.id, cancellation: { kind: "flexible", terms: {
      type: "free_until_days_before_arrival", freeCancellationDeadlineDays: 14, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount", text: "Fourteen days" } }, payment: { kind: "full" } };
    const changed = await f.commands.stageTerms(id, { requestId: randomUUID(), expectedRevision: offer.termsRevision, terms: policy }, context);
    const added = await f.commands.stageTerms(id, { requestId: randomUUID(), expectedRevision: null, terms: { ...policy, offerId: "é😀" } }, context);
    await f.commands.stageTerms(id, { requestId: randomUUID(), expectedRevision: null, terms: { ...policy, offerId: "unused" } }, context);
    const rooms = baseline.rooms.map((r) => ({ ...r, revision: baseline.revision + 1, offers: r.roomTypeId !== room.roomTypeId ? r.offers : [
      ...r.offers.map((o) => o.id === offer.id ? { ...o, termsRevision: changed.revision } : o), { ...offer, id: added.offerId, termsRevision: added.revision },
    ] }));
    const prepared = await f.commands.prepare(id, { currency: baseline.currency, rooms }, context);
    const draft = { ...context, expectedDraftRevision: 0, ...prepared };
    return { ...f, prepared, draft, baseline, changed, added, initial, policy };
  }
  it("keeps approved pricing current through review and atomically publishes complete candidate terms", async () => {
    const f = await candidateFixture(), id = f.scope.propertyId;
    expect(await f.commands.read(id)).toEqual(f.baseline);
    expect(f.prepared.sources).toEqual(f.baseline.sources);
    expect(f.prepared.effectiveSources?.terms).not.toBe(f.prepared.sources.terms);
    const command = await confirmed(f);
    const stored = (await f.commands.readDraft(id, f.draft.draftId))!;
    expect(stored.stale).toBe(false); expect(stored.effectiveSources).toEqual(f.prepared.effectiveSources);
    const review = (await f.commands.reviewCharges(id, f.draft.draftId))!;
    expect(review.fingerprint).toBe(replacementChargeFingerprint(id, command.snapshot, f.prepared.effectiveSources!));
    expect(review.fingerprint).not.toBe(replacementChargeFingerprint(id, command.snapshot, f.prepared.sources));
    expect(await f.commands.read(id)).toEqual(f.baseline);
    await expect(f.commands.publish(id, { ...command, effectiveSources: f.prepared.sources })).rejects.toMatchObject({ code: "stale" });
    expect(await f.commands.publish(id, command)).toEqual({ revision: 2, replayed: false });
    expect(await f.commands.read(id)).toMatchObject({ revision: 2, stale: false, sources: f.prepared.effectiveSources });
    expect(await f.commands.readTerms(id, f.changed.roomTypeId, f.changed.offerId)).toEqual(f.changed);
    expect(await f.commands.readTerms(id, f.added.roomTypeId, f.added.offerId)).toEqual(f.added);
    expect(await f.commands.readTerms(id, f.changed.roomTypeId, "unused")).toBeNull();
    expect((await pool.query("SELECT terms FROM booking.pricing_v2_offer_terms WHERE revision=$1", [f.baseline.rooms[0]!.offers[0]!.termsRevision])).rows[0].terms.payment).toEqual({ kind: "full" });
  });
  it("rolls both heads and activation effects back when publication fails after policy activation", async () => {
    const f = await candidateFixture(), id = f.scope.propertyId, command = await confirmed(f);
    const before = (await pool.query("SELECT count(*)::int AS n FROM platform.outbox_events WHERE property_id=$1", [id])).rows[0].n;
    await pool.query(`INSERT INTO platform.product_audit_events
      (audit_key,product,action,occurred_at,tenant_scope,property_id,target_resource_product,target_resource_type,target_resource_id)
      VALUES($1,'pms','fixture',now(),'property',$2::uuid,'pms','pricing_revision',$2::text)`, [`pricing.v2:${id}:pricing.v2.revised:${command.requestId}`, id]);
    await expect(f.commands.publish(id, command)).rejects.toThrow();
    expect(await f.commands.read(id)).toEqual(f.baseline);
    expect((await f.commands.readTerms(id, f.changed.roomTypeId, f.changed.offerId))?.revision).not.toBe(f.changed.revision);
    expect(await f.commands.readTerms(id, f.added.roomTypeId, f.added.offerId)).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM platform.outbox_events WHERE property_id=$1", [id])).rows[0].n).toBe(before);
    expect(await f.commands.publish(id, { ...command, requestId: randomUUID() })).toEqual({ revision: 2, replayed: false });
  });
  it("rejects competing drafts and returns historical receipts after a later publication without reactivating policies", async () => {
    const f = await candidateFixture(), id = f.scope.propertyId, command = await confirmed(f);
    const context = { draftId: randomUUID(), baseRevision: 1 };
    const prepared = await f.commands.prepare(id, { currency: f.baseline.currency, rooms: f.baseline.rooms.map((r) => ({ ...r, revision: 2 })) }, context);
    const competitor = await confirmed({ ...f, prepared, draft: { ...context, expectedDraftRevision: 0, ...prepared } });
    const outcomes = await Promise.allSettled([f.commands.publish(id, command), f.commands.publish(id, competitor)]);
    expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((v) => v.status === "rejected")).toMatchObject({ reason: { code: "stale" } });
    const winner = outcomes[0]!.status === "fulfilled" ? command : competitor;
    const active = (await f.commands.read(id))!;
    const next = await f.commands.prepare(id, { currency: active.currency, rooms: active.rooms.map((r) => ({ ...r, revision: 3 })) });
    const third = await confirmed({ ...f, prepared: next, draft: { draftId: randomUUID(), baseRevision: 2, expectedDraftRevision: 0, ...next } });
    await f.commands.publish(id, third);
    const before = await f.commands.read(id), effects = await counts(id);
    expect(await f.commands.publish(id, winner)).toEqual({ revision: 2, replayed: true });
    expect(await f.commands.read(id)).toEqual(before); expect(await counts(id)).toEqual(effects);
    await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [f.membershipId]);
    await expect(f.commands.publish(id, winner)).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects stale baselines, invalid candidate selection and unsupported deposit readiness", async () => {
    const f = await candidateFixture(), id = f.scope.propertyId, context = { draftId: f.draft.draftId, baseRevision: 1 };
    await expect(f.commands.prepare(id, { currency: "EUR", rooms: f.prepared.snapshot.rooms }, { ...context, draftId: randomUUID() })).rejects.toMatchObject({ code: "denied" });
    const deposit = await f.commands.stageTerms(id, { requestId: randomUUID(), expectedRevision: f.baseline.rooms[0]!.offers[0]!.termsRevision,
      terms: { ...f.policy, payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 } } }, context);
    const rooms = f.prepared.snapshot.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => r.roomTypeId === deposit.roomTypeId && o.id === deposit.offerId ? { ...o, termsRevision: deposit.revision } : o) }));
    await expect(f.commands.prepare(id, { currency: "EUR", rooms }, context)).rejects.toMatchObject({ code: "denied" });
    await f.commands.saveDraft(id, f.draft);
    const review = (await f.commands.reviewCharges(id, f.draft.draftId))!;
    await pool.query("UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1", [id]);
    await expect(f.commands.confirmCharges(id, { draftId: f.draft.draftId, expectedDraftRevision: 1, claimedFingerprint: review.fingerprint,
      declaration: review.declaration, requestId: randomUUID() })).rejects.toMatchObject({ code: "denied" });
    expect((await f.commands.readDraft(id, f.draft.draftId))?.stale).toBe(true);
    await expect(f.commands.reviewCharges(id, f.draft.draftId)).rejects.toMatchObject({ code: "stale" });
    await expect(f.commands.saveDraft(id, { ...f.draft, expectedDraftRevision: 1 })).rejects.toMatchObject({ code: "stale" });
  });

  it("requires new charge review after a candidate edit and rejects unauthorized draft operations", async () => {
    const f = await candidateFixture(), id = f.scope.propertyId, command = await confirmed(f);
    const context = { draftId: f.draft.draftId, baseRevision: 1 }, oldReview = (await f.commands.reviewCharges(id, context.draftId))!;
    const replacement = await f.commands.stageTerms(id, { requestId: randomUUID(), expectedRevision: f.baseline.rooms[0]!.offers[0]!.termsRevision,
      terms: { ...f.policy, cancellation: { kind: "non_refundable" } } }, context);
    const rooms = f.prepared.snapshot.rooms.map((r) => ({ ...r, offers: r.offers.map((o) => r.roomTypeId === replacement.roomTypeId && o.id === replacement.offerId ? { ...o, termsRevision: replacement.revision } : o) }));
    const prepared = await f.commands.prepare(id, { currency: "EUR", rooms }, context);
    await f.commands.saveDraft(id, { ...f.draft, ...prepared, expectedDraftRevision: 2 });
    await expect(f.commands.publish(id, command)).rejects.toMatchObject({ code: "stale" });
    await expect(f.commands.confirmCharges(id, { draftId: context.draftId, expectedDraftRevision: 3, claimedFingerprint: oldReview.fingerprint,
      declaration: oldReview.declaration, requestId: randomUUID() })).rejects.toMatchObject({ code: "stale" });
    const denied = createReplacementPricingCommands(pool, null), foreign = await fixture();
    for (const commands of [denied, foreign.commands]) {
      await expect(commands.prepare(id, { currency: "EUR", rooms }, context)).rejects.toMatchObject({ code: "denied" });
      await expect(commands.saveDraft(id, { ...f.draft, ...prepared, expectedDraftRevision: 3 })).rejects.toMatchObject({ code: "denied" });
      await expect(commands.publish(id, command)).rejects.toMatchObject({ code: "denied" });
    }
    expect(await f.commands.read(id)).toEqual(f.baseline);
  });

});
