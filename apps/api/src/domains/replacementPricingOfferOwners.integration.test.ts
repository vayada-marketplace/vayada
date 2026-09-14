import { readCurrentChannexStagedPrices } from "./replacementPricingOfferOwners.js";
import { readCurrentChannexAriTaskFinishes } from "./replacementPricingOfferOwners.js";
import { prepareChannexAriReceiptPersistence, prepareChannexAriTransportFailurePersistence } from "./channexAriReceiptStore.js";
import { prepareChannexInitialAriDispatch, claimPublishedChannexInitialAri } from "./replacementPricingOfferOwners.js";
import { readCurrentChannexStagedRestrictions, readCurrentChannexNightRestrictions } from "./replacementPricingOfferOwners.js";
import { retainChannexOfferConfiguration, prepareChannexOfferDispatch, recordRetainedChannexOfferCreate as recordRetained } from "./replacementPricingOfferOwners.js";
import { prepareChannexReceiptPersistence, prepareChannexTransportFailurePersistence } from "./channexCreationReceiptStore.js";
import { verifyChannexOfferRoom, verifyChannexOfferConfiguration } from "../integrations/channexOfferConfiguration.js";
import { preparePublishedChannexNightPrices } from "./channexPublishedNightPrices.js";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createBookingPricingOfferTermsStore, lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { lockReplacementPricingOfferOwners as verify, readPublishedPricingForChannexJob, reservePublishedChannexOfferTarget, claimPublishedChannexOfferCreate, recordPublishedChannexOfferCreate as recordCreation } from "./replacementPricingOfferOwners.js";
import { createReplacementChargeDeclarationStore, replacementChargeFingerprint } from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing offer owners", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture(total = 2, publishedAdults = 2, baseMinor = "10000") {
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
    await pool.query("UPDATE pms.room_types SET occupancy_limits=jsonb_build_object('total',$2::int,'adults',$2::int,'children',0) WHERE property_id=$1", [propertyId,total]);
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
        version: "pricing.v2", propertyId, roomTypeId: id, revision: 1, currency: "EUR", capacity: { total: publishedAdults, adults: publishedAdults, children: 0 },
        children: { adultFromAge: 12, bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }] },
        offers: terms.filter((t) => t.roomTypeId === id).map((t) => ({ id: t.offerId, termsRevision: t.revision,
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: { kind: "independent", calendar: { base: { mode: "flat", amountMinor: baseMinor }, months: [], seasons: [], weekdays: [], dates: [] } },
          restrictions: { kind: "own", rules: { minArrivalNights: 1, maxStayNights: null, closedToArrival: false, closedToDeparture: false, stopSell: false }, seasons: [], dates: [] },
        })),
      })) };
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
  async function serviceFixture(total = 2, publishedAdults = 2, baseMinor = "10000") {
    const f = await fixture(total, publishedAdults, baseMinor),
      propertyId = f.scope.propertyId,
      jobId = randomUUID();
    await pool.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1::uuid,'channex',$1::text,'active','enable')",
      [propertyId],
    );
    await pool.query(
      "INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_status) VALUES($1::uuid,'channex',$1::text,'connected')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,attempts_count,locked_by,locked_at,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
        VALUES($1::uuid,$1::text,'pms.channex.management','channex.sync_ari','running',1,'reader-test',clock_timestamp(),'property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"sync_ari"}')`,
      [jobId, propertyId],
    );
    await pool.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'reader-test')",
      [jobId],
    );
    const input = { jobId, workerId: "reader-test", attemptNumber: 1 };
    async function publish(snapshot = f.snapshot, sources = f.sources) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          `INSERT INTO pms.pricing_v2_revisions(property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count)
            VALUES($1,1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            propertyId,
            snapshot.currency,
            sources,
            snapshot.ownerReferences,
            randomUUID(),
            "a".repeat(64),
            f.scope.actorUserId,
            snapshot.rooms.length,
          ],
        );
        for (const room of snapshot.rooms)
          await c.query(
            "INSERT INTO pms.pricing_v2_rooms(property_id,revision,room_type_id,currency,configuration) VALUES($1,1,$2,$3,$4)",
            [propertyId, room.roomTypeId, room.currency, room],
          );
        await c.query("UPDATE pms.pricing_v2_heads SET revision=1 WHERE property_id=$1", [
          propertyId,
        ]);
        await c.query("COMMIT");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
    return {
      ...f,
      input,
      publish,
      serviceRead: () => readPublishedPricingForChannexJob(pool, input),
    };
  }
  async function creationFixture(baseMinor = "10000") {
    const f = await serviceFixture(2, 2, baseMinor);
    await f.publish();
    const roomTypeId = f.snapshot.rooms[0].roomTypeId,
      externalRoomTypeId = randomUUID();
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings
      (property_id,connection_id,room_type_id,external_room_type_id)
      SELECT property_id,id,$2,$3 FROM pms.channel_connections WHERE property_id=$1`,
      [f.scope.propertyId, roomTypeId, externalRoomTypeId],
    );
    return {
      ...f,
      externalRoomTypeId,
      selection: { roomTypeId, offerId: "flex", operationKey: "create", primaryOccupancy: 1 },
    };
  }
  function createdResponse(body: unknown) {
    const plan = (body as { rate_plan: Record<string, unknown> }).rate_plan;
    const id = randomUUID();
    const attributes: Record<string, unknown> = {
      ...plan,
      id,
      options: (plan.options as { occupancy: number; is_primary: boolean }[]).map((option) => ({
        ...option,
        derived_option: null,
      })),
    };
    return { data: { type: "rate_plan", id, attributes } };
  }
  async function recordingFixture(baseMinor = "10000") {
    const f = await creationFixture(baseMinor);
    const claim = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    if (claim.kind !== "claimed") throw new Error("claim required");
    return { ...f, claim, response: createdResponse(claim.request.body) };
  }
  async function receiptFixture(baseMinor = "10000") {
    const f = await recordingFixture(baseMinor);
    const connectionId = (
      await pool.query("SELECT connection_id FROM pms.channex_offer_targets WHERE id=$1", [
        f.claim.targetId,
      ])
    ).rows[0].connection_id as string;
    const correlation = {
      receiptId: randomUUID(),
      attemptId: f.claim.attemptId,
      jobAttemptId: f.claim.jobAttemptId,
      workerId: f.claim.workerId,
      propertyId: f.scope.propertyId,
      connectionId,
    };
    const response = () =>
      new Response(JSON.stringify(f.response), {
        status: 201,
        headers: { "x-request-id": "receipt-test" },
      });
    return { ...f, correlation, response };
  }
  async function transportReceipts(propertyId: string) {
    return (
      await pool.query(
        `SELECT r.outcome,r.http_status,r.provider_request_id,r.identity_evidence,r.has_warnings,a.state
       FROM pms.channex_offer_create_receipts r JOIN pms.channex_offer_create_attempts a ON a.id=r.attempt_id
       JOIN pms.channex_offer_targets t ON t.id=a.target_id WHERE t.property_id=$1`,
        [propertyId],
      )
    ).rows;
  }
  const transportEnvelope = {
    outcome: "transport_error",
    http_status: null,
    provider_request_id: null,
    identity_evidence: {},
    has_warnings: true,
    state: "unresolved",
  };
  it("persists a fixed transport failure idempotently without gaining identity", async () => {
    const f = await receiptFixture();
    const save = await prepareChannexTransportFailurePersistence(pool, f.correlation);
    const result = await save();
    expect(await save()).toEqual(result);
    expect(await transportReceipts(f.scope.propertyId)).toEqual([transportEnvelope]);
    expect(await recordRetained(pool, f.input, f.selection, f.claim.attemptId)).toMatchObject({
      kind: "unavailable",
    });
  });
  it("does not retain a creation transport receipt for a failed room preflight", async () => {
    const f = await creationFixture();
    const prepared = await prepareChannexOfferDispatch(pool, f.input, f.selection);
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    const create = vi.fn(async () => new Response("{}"));
    expect(
      await prepared.dispatch({
        getRoom: async () => {
          throw new Error("private GET error");
        },
        create,
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(create).not.toHaveBeenCalled();
    expect(await transportReceipts(f.scope.propertyId)).toEqual([]);
  });
  it("retains transport failure when creation exceeds its deadline", async () => {
    const f = await creationFixture();
    const prepared = await prepareChannexOfferDispatch(pool, f.input, f.selection);
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    let signal: AbortSignal | undefined;
    const create = vi.fn(async (_payload: unknown, current: AbortSignal): Promise<Response> => {
      signal = current;
      return new Promise(() => {});
    });
    const ports = { getRoom: async () => providerRoom(f), create };
    expect(await prepared.dispatch(ports)).toMatchObject({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    expect(signal?.aborted).toBe(true);
    expect(await transportReceipts(f.scope.propertyId)).toEqual([transportEnvelope]);
    expect(await prepared.dispatch(ports)).toMatchObject({ reason: "dispatch_already_used" });
    expect(create).toHaveBeenCalledOnce();
  }, 30000);
  async function configurationFixture(baseMinor = "10000") {
    const f = await receiptFixture(baseMinor);
    await (
      await prepareChannexReceiptPersistence(pool, f.correlation, f.response())
    )();
    expect((await recordRetained(pool, f.input, f.selection, f.claim.attemptId)).kind).toBe(
      "identified",
    );
    return f;
  }
  const initialAriDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const nextAriDate = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  async function initialAriFixture(baseMinor = "10000") {
    const f = await configurationFixture(baseMinor);
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [f.scope.propertyId],
    );
    expect(
      await retainChannexOfferConfiguration(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        async () => f.response().json(),
      ),
    ).toMatchObject({ kind: "configuration_retained" });
    const claim = (date = initialAriDate) =>
      claimPublishedChannexInitialAri(pool, f.input, f.selection, f.claim.attemptId, date);
    return { ...f, claimAri: claim };
  }
  it("claims all occupancy totals and explicit restrictions for the current identified rate", async () => {
    const f = await initialAriFixture(),
      result = await f.claimAri();
    expect(result).toMatchObject({
      kind: "ari_claimed",
      targetId: f.claim.targetId,
      intentId: f.claim.intentId,
      version: f.claim.version,
    });
    if (result.kind !== "ari_claimed") throw new Error("claim required");
    const row = (
      await pool.query("SELECT * FROM pms.channex_offer_ari_attempts WHERE id=$1", [
        result.attemptId,
      ])
    ).rows[0];
    const rate = ((await f.response().json()) as { data: { id: string } }).data.id;
    // A currently sellable offer still stages a closed provider rate.
    expect(f.snapshot.rooms[0].offers[0].restrictions).toMatchObject({
      kind: "own",
      rules: { stopSell: false },
    });
    expect(row).toMatchObject({
      creation_attempt_id: f.claim.attemptId,
      job_attempt_id: result.jobAttemptId,
      worker_id: f.input.workerId,
      state: "unresolved",
      request_body: {
        values: [
          {
            property_id: f.scope.propertyId,
            rate_plan_id: rate,
            date: initialAriDate,
            rates: [
              { occupancy: 1, rate: "100.00" },
              { occupancy: 2, rate: "100.00" },
            ],
            min_stay_arrival: 1,
            min_stay_through: 1,
            max_stay: 0,
            closed_to_arrival: false,
            closed_to_departure: false,
            stop_sell: true,
          },
        ],
      },
    });
    for (const date of [initialAriDate, nextAriDate])
      expect(await f.claimAri(date)).toMatchObject({
        kind: "unavailable",
        reason: "ari_reconciliation_required",
      });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE target_id=$1",
          [f.claim.targetId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          f.claim.targetId,
        ])
      ).rows[0].active_version,
    ).toBeNull();
  });
  it.each([
    "configuration",
    "tampered_configuration",
    "receipt",
    "lease",
    "binding",
    "terms",
    "date",
  ])(
    "rejects initial ARI claim with unavailable %s without persisting an attempt",
    async (variant) => {
      const f = await initialAriFixture();
      if (variant === "configuration")
        await pool.query(
          "UPDATE pms.channex_offer_target_intents SET result_evidence='{}' WHERE id=$1",
          [f.claim.intentId],
        );
      if (variant === "tampered_configuration")
        await pool.query(
          "UPDATE pms.channex_offer_target_intents SET result_evidence=jsonb_set(result_evidence,'{configuration,attemptId}',to_jsonb($2::text)) WHERE id=$1",
          [f.claim.intentId, randomUUID()],
        );
      if (variant === "receipt")
        await (
          await prepareChannexReceiptPersistence(
            pool,
            { ...f.correlation, receiptId: randomUUID() },
            new Response("{}", { status: 500 }),
          )
        )();
      if (variant === "lease")
        await pool.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
      if (variant === "binding")
        await pool.query(
          "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
          [f.scope.propertyId],
        );
      if (variant === "terms")
        await f.booking.save(f.context, f.scope, {
          requestId: randomUUID(),
          expectedRevision: f.terms[0].revision,
          terms: f.termsInput,
        });
      expect(await f.claimAri(variant === "date" ? "2030-02-30" : initialAriDate)).toMatchObject({
        kind: "unavailable",
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE target_id=$1",
            [f.claim.targetId],
          )
        ).rows[0].count,
      ).toBe(0);
    },
  );
  it("does not claim initial ARI from unidentified creation or a foreign attempt", async () => {
    const f = await receiptFixture(),
      other = await initialAriFixture();
    expect(
      await claimPublishedChannexInitialAri(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        initialAriDate,
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(
      await claimPublishedChannexInitialAri(
        pool,
        other.input,
        other.selection,
        f.claim.attemptId,
        initialAriDate,
      ),
    ).toMatchObject({ kind: "unavailable" });
  });
  it("rolls back an initial ARI claim when authority is lost before commit", async () => {
    const f = await initialAriFixture();
    let reached = false;
    const intercepted = interceptRead(async (c, sql) => {
      if (!reached && sql.includes("INSERT INTO pms.channex_offer_ari_attempts")) {
        reached = true;
        await c.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
      }
    });
    expect(
      await claimPublishedChannexInitialAri(
        intercepted,
        f.input,
        f.selection,
        f.claim.attemptId,
        initialAriDate,
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(reached).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE target_id=$1",
          [f.claim.targetId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("retains exact decimal room totals without multiplying by occupancy", async () => {
    const f = await initialAriFixture("13950"),
      result = await f.claimAri();
    if (result.kind !== "ari_claimed") throw new Error("claim required");
    const row = (
      await pool.query("SELECT request_body FROM pms.channex_offer_ari_attempts WHERE id=$1", [
        result.attemptId,
      ])
    ).rows[0];
    expect(row.request_body.values[0].rates).toEqual([
      { occupancy: 1, rate: "139.50" },
      { occupancy: 2, rate: "139.50" },
    ]);
  });
  async function initialDispatchFixture() {
    const f = await initialAriFixture();
    const prepared = await prepareChannexInitialAriDispatch(
      pool,
      f.input,
      f.selection,
      f.claim.attemptId,
      initialAriDate,
    );
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    const get = vi.fn(async (path: string) =>
      path.includes("properties/")
        ? {
            data: {
              type: "property",
              id: f.scope.propertyId,
              attributes: { settings: { min_stay_type: "both" } },
            },
          }
        : path.includes("room_types")
          ? providerRoom(f)
          : f.response().json(),
    );
    const taskId = randomUUID();
    const post = vi.fn(
      async (_payload: { body: unknown }) =>
        new Response(
          JSON.stringify({ data: [{ type: "task", id: taskId }], meta: { warnings: [] } }),
        ),
    );
    return { ...f, prepared, get, post, taskId };
  }
  it("dispatches closed initial ARI once and retains an acknowledgement without releasing ownership", async () => {
    const f = await initialDispatchFixture();
    const first = f.prepared.dispatch(f);
    expect(await f.prepared.dispatch(f)).toEqual({
      kind: "unavailable",
      reason: "dispatch_already_used",
    });
    const result = await first;
    expect(result.kind).toBe("retained");
    expect(f.get).toHaveBeenCalledTimes(3);
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post.mock.calls[0]![0]).toMatchObject({
      method: "POST",
      path: "/api/v1/restrictions",
      body: { values: [{ date: initialAriDate, stop_sell: true }] },
    });
    const rows = await pool.query(
      `SELECT a.state,a.request_body,r.task_ids,r.http_status FROM pms.channex_offer_ari_attempts a JOIN pms.channex_offer_ari_receipts r ON r.attempt_id=a.id WHERE a.creation_attempt_id=$1`,
      [f.claim.attemptId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      state: "unresolved",
      task_ids: [f.taskId],
      http_status: 200,
      request_body: f.post.mock.calls[0]![0].body,
    });
    expect(
      (
        await prepareChannexInitialAriDispatch(
          pool,
          f.input,
          f.selection,
          f.claim.attemptId,
          initialAriDate,
        )
      ).kind,
    ).toBe("unavailable");
  });
  it.each(["before", "during"])(
    "blocks initial ARI when the lease expires %s preflight",
    async (when) => {
      const f = await initialDispatchFixture();
      const expire = () =>
        pool.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
      if (when === "before") await expire();
      const get = vi.fn(async (path: string) => {
        await expire();
        return f.get(path);
      });
      expect(await f.prepared.dispatch({ get, post: f.post })).toMatchObject({
        kind: "unavailable",
        reason: "lease_unavailable",
      });
      expect(f.post).not.toHaveBeenCalled();
      if (when === "before") expect(get).not.toHaveBeenCalled();
    },
  );
  it.each(["arrival", "through", "unknown", undefined])(
    "does not POST or retain a provider receipt for unsupported minimum-stay mode %s",
    async (mode) => {
      const f = await initialDispatchFixture();
      const get = vi.fn(async (path: string) => {
        if (path.includes("properties/"))
          return {
            data: {
              type: "property",
              id: f.scope.propertyId,
              attributes: { settings: { min_stay_type: mode } },
            },
          };
        return f.get(path);
      });
      expect(await f.prepared.dispatch({ get, post: f.post })).toEqual({
        kind: "unavailable",
        reason: "ari_restriction_capability_unavailable",
      });
      expect(get).toHaveBeenCalledOnce();
      expect(f.post).not.toHaveBeenCalled();
      expect(
        (
          await pool.query(
            `SELECT r.id FROM pms.channex_offer_ari_receipts r JOIN pms.channex_offer_ari_attempts a ON a.id=r.attempt_id WHERE a.creation_attempt_id=$1`,
            [f.claim.attemptId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(await f.prepared.dispatch(f)).toMatchObject({ reason: "dispatch_already_used" });
    },
  );
  it.each(["room_types", "rate_plans"])(
    "blocks initial ARI with incompatible live %s metadata",
    async (endpoint) => {
      const f = await initialDispatchFixture();
      const ports = {
        get: async (path: string) => (path.includes(endpoint) ? {} : f.get(path)),
        post: f.post,
      };
      expect(await f.prepared.dispatch(ports)).toEqual({
        kind: "unavailable",
        reason: "ari_preflight_unavailable",
      });
      expect(f.post).not.toHaveBeenCalled();
      expect(await f.prepared.dispatch(f)).toMatchObject({ reason: "dispatch_already_used" });
    },
  );
  it.each(["throw", "timeout"])(
    "retains an ambiguous initial ARI %s without resending",
    async (mode) => {
      const f = await initialDispatchFixture();
      const post = vi.fn(async () => {
        if (mode === "timeout") return new Promise<Response>(() => {});
        throw new Error("private transport error");
      });
      expect((await f.prepared.dispatch({ get: f.get, post })).kind).toBe("retained");
      expect(await f.prepared.dispatch(f)).toMatchObject({ reason: "dispatch_already_used" });
      expect(post).toHaveBeenCalledOnce();
      const rows = await pool.query(
        `SELECT a.state,r.http_status,r.task_ids,r.has_warnings,r.outcome FROM pms.channex_offer_ari_attempts a JOIN pms.channex_offer_ari_receipts r ON r.attempt_id=a.id WHERE a.creation_attempt_id=$1`,
        [f.claim.attemptId],
      );
      expect(rows.rows).toEqual([
        {
          state: "unresolved",
          http_status: null,
          task_ids: [],
          has_warnings: true,
          outcome: "transport_error",
        },
      ]);
    },
  );
  it("retains a late initial ARI response after lease loss", async () => {
    const f = await initialDispatchFixture();
    expect(
      (
        await f.prepared.dispatch({
          get: f.get,
          post: async (payload) => {
            await pool.query(
              "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
              [f.input.jobId],
            );
            return f.post(payload);
          },
        })
      ).kind,
    ).toBe("retained");
    expect(f.post).toHaveBeenCalledOnce();
  });
  it("retries only receipt persistence after a storage lock", async () => {
    const f = await initialDispatchFixture();
    const blocker = await pool.connect();
    try {
      const result = await f.prepared.dispatch({
        get: f.get,
        post: async (payload) => {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1 FOR UPDATE", [
            f.claim.targetId,
          ]);
          return f.post(payload);
        },
      });
      expect(result.kind).toBe("receipt_pending");
      await blocker.query("ROLLBACK");
      if (result.kind !== "receipt_pending") throw new Error("persist retry required");
      await result.persist();
      await result.persist();
      expect(await f.prepared.dispatch(f)).toMatchObject({ reason: "dispatch_already_used" });
      expect(f.post).toHaveBeenCalledOnce();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
  it("rechecks the property timezone after initial ARI preflight", async () => {
    const f = await initialDispatchFixture();
    const result = await f.prepared.dispatch({
      get: async (path) => {
        await pool.query(
          "UPDATE hotel_catalog.property_locations SET timezone='Invalid/Zone' WHERE property_id=$1",
          [f.scope.propertyId],
        );
        return f.get(path);
      },
      post: f.post,
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "ari_date_unavailable" });
    expect(f.post).not.toHaveBeenCalled();
  });
  it("blocks initial ARI when a receipt arrives during preflight", async () => {
    const f = await initialDispatchFixture();
    const attempt = (
      await pool.query(
        "SELECT id,job_attempt_id,worker_id FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1",
        [f.claim.attemptId],
      )
    ).rows[0];
    const result = await f.prepared.dispatch({
      get: async (path) => {
        await (
          await prepareChannexAriTransportFailurePersistence(pool, {
            ...f.correlation,
            receiptId: randomUUID(),
            attemptId: attempt.id,
            jobAttemptId: attempt.job_attempt_id,
            workerId: attempt.worker_id,
          })
        )();
        return f.get(path);
      },
      post: f.post,
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "ari_dispatch_unavailable" });
    expect(f.post).not.toHaveBeenCalled();
  });
  async function ariReceiptFixture() {
    const f = await initialAriFixture(),
      claimed = await f.claimAri();
    if (claimed.kind !== "ari_claimed") throw new Error("claim required");
    const correlation = {
      ...f.correlation,
      receiptId: randomUUID(),
      attemptId: claimed.attemptId,
      jobAttemptId: claimed.jobAttemptId,
      workerId: claimed.workerId,
    };
    const taskId = randomUUID();
    const response = () =>
      new Response(
        JSON.stringify({
          data: [{ type: "task", id: taskId }],
          meta: { warnings: [] },
          secret: "not retained",
        }),
        { headers: { "x-request-id": "r".repeat(512) } },
      );
    return { ...f, ariCorrelation: correlation, taskId, ariResponse: response };
  }
  async function stagedPriceFixture() {
    const f = await ariReceiptFixture();
    const stored = (
      await pool.query("SELECT request_body FROM pms.channex_offer_ari_attempts WHERE id=$1", [
        f.ariCorrelation.attemptId,
      ])
    ).rows[0].request_body.values[0];
    const metadata = (await f.response().json()) as {
      data: { attributes: { options: { id: string; is_primary: boolean; occupancy: number }[] } };
    };
    const options = metadata.data.attributes.options;
    options.forEach((o: { id: string; is_primary: boolean }) => {
      o.id = o.is_primary ? stored.rate_plan_id : randomUUID();
    });
    const get = vi.fn(async (path: string) => {
      if (path.includes("/rate_plans/")) return structuredClone(metadata);
      const id = new URL(path, "https://staging.channex.io").searchParams.get(
        "filter[rate_plan_id]",
      );
      const option = options.find((o: { id: string }) => o.id === id);
      if (!option) throw new Error("Unexpected option ID");
      const amount = stored.rates.find(
        (r: { occupancy: number }) => r.occupancy === option.occupancy,
      ).rate;
      return { data: { [id!]: { [stored.date]: { rate: amount, stop_sell: true } } } };
    });
    const read = (port: (path: string, signal: AbortSignal) => Promise<unknown> = get) =>
      readCurrentChannexStagedPrices(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        f.ariCorrelation.attemptId,
        port,
      );
    return { ...f, get, read, stored, metadata };
  }
  it("reads all staged guest totals under immutable ownership without releasing the attempt", async () => {
    const f = await stagedPriceFixture();
    const result = await f.read();
    expect(result).toMatchObject({
      kind: "staged_prices_observed",
      ariAttemptId: f.ariCorrelation.attemptId,
      observation: {
        prices: [
          { occupancy: 1, rate: "100.00" },
          { occupancy: 2, rate: "100.00" },
        ],
      },
    });
    expect(f.get).toHaveBeenCalledTimes(4);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_ari_attempts WHERE id=$1", [
          f.ariCorrelation.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it.each(["before", "during"])("rejects authority loss %s guest price reads", async (when) => {
    const f = await stagedPriceFixture();
    const expire = () =>
      pool.query(
        "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
        [f.input.jobId],
      );
    if (when === "before") await expire();
    const result = await f.read(async (path) => {
      await expire();
      return f.get(path);
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "lease_unavailable" });
    if (when === "before") expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects receipt history changes during guest price reads", async () => {
    const f = await stagedPriceFixture();
    let added = false;
    const result = await f.read(async (path) => {
      if (!added) {
        added = true;
        await (
          await prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, f.ariResponse())
        )();
      }
      return f.get(path);
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "staged_price_observation_stale" });
  });
  it("requires retained configuration before guest price GETs", async () => {
    const f = await stagedPriceFixture();
    await pool.query(
      "UPDATE pms.channex_offer_target_intents SET result_evidence=result_evidence-'configuration' WHERE id=$1",
      [f.claim.intentId],
    );
    expect(await f.read()).toMatchObject({
      kind: "unavailable",
      reason: "configuration_evidence_unavailable",
    });
    expect(f.get).not.toHaveBeenCalled();
  });
  it("bounds the whole guest price read and stops further GETs after timeout", async () => {
    const f = await stagedPriceFixture();
    const get = vi.fn(async () => new Promise<unknown>(() => {}));
    await expect(f.read(get)).rejects.toThrow();
    expect(get).toHaveBeenCalledOnce();
  });
  async function stagedReadFixture() {
    const f = await ariReceiptFixture();
    const stored = (
      await pool.query("SELECT request_body FROM pms.channex_offer_ari_attempts WHERE id=$1", [
        f.ariCorrelation.attemptId,
      ])
    ).rows[0].request_body.values[0];
    const { property_id, rate_plan_id, date, rates: _rates, ...restrictions } = stored;
    const response = { data: { [rate_plan_id]: { [date]: restrictions } } };
    const get = vi.fn(async () => response);
    const read = (port: (path: string, signal: AbortSignal) => Promise<unknown> = get) =>
      readCurrentChannexStagedRestrictions(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        f.ariCorrelation.attemptId,
        port,
      );
    return { ...f, get, read, response, stored };
  }
  it("reads the immutable closed upload and keeps ambiguous ownership unresolved", async () => {
    const f = await stagedReadFixture();
    await (
      await prepareChannexAriTransportFailurePersistence(pool, f.ariCorrelation)
    )();
    const result = await f.read();
    expect(result).toMatchObject({
      kind: "staged_restrictions_observed",
      creationAttemptId: f.claim.attemptId,
      ariAttemptId: f.ariCorrelation.attemptId,
      observation: { date: initialAriDate, restrictions: { stop_sell: true } },
    });
    expect(f.get).toHaveBeenCalledOnce();
    const row = (
      await pool.query("SELECT state FROM pms.channex_offer_ari_attempts WHERE id=$1", [
        f.ariCorrelation.attemptId,
      ])
    ).rows[0];
    expect(row.state).toBe("unresolved");
  });
  it.each(["property_id", "rate_plan_id", "date"])(
    "rejects stored request %s outside its immutable identity",
    async (field) => {
      const template = await stagedReadFixture(),
        f = await initialAriFixture();
      const body = {
        values: [
          {
            ...template.stored,
            property_id: f.scope.propertyId,
            rate_plan_id: ((await f.response().json()) as { data: { id: string } }).data.id,
            [field]: field === "date" ? nextAriDate : randomUUID(),
          },
        ],
      };
      const row = (
        await pool.query(
          `INSERT INTO pms.channex_offer_ari_attempts(creation_attempt_id,job_attempt_id,worker_id,service_date,request_body)
         VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
          [
            f.claim.attemptId,
            f.claim.jobAttemptId,
            f.claim.workerId,
            initialAriDate,
            JSON.stringify(body),
          ],
        )
      ).rows[0];
      const get = vi.fn();
      expect(
        await readCurrentChannexStagedRestrictions(
          pool,
          f.input,
          f.selection,
          f.claim.attemptId,
          row.id,
          get,
        ),
      ).toMatchObject({ kind: "unavailable", reason: "ari_attempt_unavailable" });
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("rejects an upload from a different creation before GET", async () => {
    const f = await stagedReadFixture(),
      other = await ariReceiptFixture();
    expect(
      await readCurrentChannexStagedRestrictions(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        other.ariCorrelation.attemptId,
        f.get,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "ari_attempt_unavailable" });
    expect(f.get).not.toHaveBeenCalled();
  });
  it.each(["before", "during"])("rejects authority loss %s staged restriction GET", async (when) => {
    const f = await stagedReadFixture();
    const expire = () =>
      pool.query(
        "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
        [f.input.jobId],
      );
    if (when === "before") await expire();
    const result = await f.read(async () => {
      await expire();
      return f.get();
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "lease_unavailable" });
    if (when === "before") expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects a receipt arriving during staged restriction GET", async () => {
    const f = await stagedReadFixture();
    const result = await f.read(async () => {
      await (
        await prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, f.ariResponse())
      )();
      return f.get();
    });
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "staged_restriction_observation_stale",
    });
  });
  it("rejects changed room mapping during staged restriction GET", async () => {
    const f = await stagedReadFixture();
    const result = await f.read(async () => {
      await pool.query(
        "UPDATE pms.channel_room_type_mappings SET external_room_type_id=$2 WHERE property_id=$1",
        [f.scope.propertyId, randomUUID()],
      );
      return f.get();
    });
    expect(result.kind).toBe("unavailable");
  });
  it("requires retained configuration before staged restriction GET", async () => {
    const f = await stagedReadFixture();
    await pool.query(
      "UPDATE pms.channex_offer_target_intents SET result_evidence=result_evidence-'configuration' WHERE id=$1",
      [f.claim.intentId],
    );
    expect(await f.read()).toMatchObject({
      kind: "unavailable",
      reason: "configuration_evidence_unavailable",
    });
    expect(f.get).not.toHaveBeenCalled();
  });
  it("does not accept desired open restrictions as staged closed evidence", async () => {
    const f = await stagedReadFixture();
    f.response.data[f.stored.rate_plan_id][f.stored.date].stop_sell = false;
    await expect(f.read()).rejects.toThrow("restriction_readback_mismatch");
  });
  it("rejects a reconciled upload before GET", async () => {
    const f = await stagedReadFixture();
    await pool.query(
      "UPDATE pms.channex_offer_ari_attempts SET state='reconciled',reconciliation_evidence='{\"test\":true}'::jsonb WHERE id=$1",
      [f.ariCorrelation.attemptId],
    );
    expect(await f.read()).toMatchObject({ kind: "unavailable", reason: "ari_attempt_unavailable" });
    expect(f.get).not.toHaveBeenCalled();
  });
  async function taskReadFixture() {
    const f = await stagedReadFixture();
    const read = (get: (path: string, signal: AbortSignal) => Promise<unknown>) =>
      readCurrentChannexAriTaskFinishes(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        f.ariCorrelation.attemptId,
        get,
      );
    const task = (id = f.taskId) => ({
      data: {
        type: "task",
        id,
        attributes: {
          id,
          task: "Property.UpdateRestrictions",
          payload: { values: [f.stored] },
          success: true,
          errors: [],
          received_at: "2026-09-14T00:00:00.000001",
          executed_at: "2026-09-14T00:00:00.000002",
          finished_at: "2026-09-14T00:00:00.000003",
        },
      },
    });
    const retain = (response = f.ariResponse()) =>
      prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, response).then((save) => save());
    return { ...f, readTasks: read, task, retain };
  }
  it("reads only original receipt tasks and leaves ARI ownership unresolved", async () => {
    const f = await taskReadFixture();
    await f.retain();
    const get = vi.fn(async () => f.task());
    expect(await f.readTasks(get)).toMatchObject({
      kind: "ari_tasks_observed",
      ariAttemptId: f.ariCorrelation.attemptId,
      observations: [{ taskId: f.taskId }],
    });
    expect(get.mock.calls[0]).toMatchObject([`/api/v1/tasks/${f.taskId}`, expect.any(AbortSignal)]);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_ari_attempts WHERE id=$1", [
          f.ariCorrelation.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it.each(["missing", "transport", "warnings", "http", "multiple"])(
    "holds %s original task receipts before IO",
    async (mode) => {
      const f = await taskReadFixture();
      if (mode === "transport")
        await (
          await prepareChannexAriTransportFailurePersistence(pool, f.ariCorrelation)
        )();
      if (mode === "warnings")
        await f.retain(
          new Response(
            JSON.stringify({
              data: [{ type: "task", id: f.taskId }],
              meta: { warnings: ["partial"] },
            }),
          ),
        );
      if (mode === "http")
        await f.retain(
          new Response(
            JSON.stringify({ data: [{ type: "task", id: f.taskId }], meta: { warnings: [] } }),
            { status: 500 },
          ),
        );
      if (mode === "multiple") {
        await f.retain();
        await (
          await prepareChannexAriReceiptPersistence(
            pool,
            { ...f.ariCorrelation, receiptId: randomUUID() },
            f.ariResponse(),
          )
        )();
      }
      const get = vi.fn();
      expect(await f.readTasks(get)).toMatchObject({
        kind: "unavailable",
        reason: "ari_receipt_history_unavailable",
      });
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("does not return partial task finishes when a later task fails", async () => {
    const f = await taskReadFixture(),
      other = randomUUID();
    await f.retain(
      new Response(
        JSON.stringify({
          data: [f.taskId, other].map((id) => ({ type: "task", id })),
          meta: { warnings: [] },
        }),
      ),
    );
    const get = vi.fn(async (path: string) => (path.endsWith(f.taskId) ? f.task() : {}));
    await expect(f.readTasks(get)).rejects.toThrow("ari_task_observation_unavailable");
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("rejects lease loss during original task GET", async () => {
    const f = await taskReadFixture();
    await f.retain();
    expect(
      await f.readTasks(async () => {
        await pool.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
        return f.task();
      }),
    ).toMatchObject({ kind: "unavailable", reason: "lease_unavailable" });
  });
  it("rejects a new receipt during original task GET", async () => {
    const f = await taskReadFixture();
    await f.retain();
    expect(
      await f.readTasks(async () => {
        await (
          await prepareChannexAriTransportFailurePersistence(pool, {
            ...f.ariCorrelation,
            receiptId: randomUUID(),
          })
        )();
        return f.task();
      }),
    ).toMatchObject({ kind: "unavailable", reason: "ari_receipt_history_unavailable" });
  });
  it("bounds all original task reads and does not start later GETs after timeout", async () => {
    const f = await taskReadFixture(),
      other = randomUUID();
    await f.retain(
      new Response(
        JSON.stringify({
          data: [f.taskId, other].map((id) => ({ type: "task", id })),
          meta: { warnings: [] },
        }),
      ),
    );
    const get = vi.fn(async () => new Promise<unknown>(() => {}));
    await expect(f.readTasks(get)).rejects.toThrow();
    expect(get).toHaveBeenCalledOnce();
  });
  it("retains late ARI receipts idempotently without releasing ownership", async () => {
    const f = await ariReceiptFixture(),
      response = f.ariResponse();
    const scope = { ...f.ariCorrelation };
    const persist = await prepareChannexAriReceiptPersistence(pool, scope, response);
    scope.attemptId = randomUUID();
    expect(response.bodyUsed).toBe(true);
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
      [f.input.jobId],
    );
    await persist();
    await persist();
    const rows = (
      await pool.query(
        "SELECT outcome,http_status,task_ids,has_warnings FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1",
        [f.ariCorrelation.attemptId],
      )
    ).rows;
    expect(rows).toEqual([
      { outcome: "complete_json", http_status: 200, task_ids: [f.taskId], has_warnings: false },
    ]);
    expect(
      (
        await pool.query(
          "SELECT state,reconciliation_evidence FROM pms.channex_offer_ari_attempts WHERE id=$1",
          [f.ariCorrelation.attemptId],
        )
      ).rows,
    ).toEqual([{ state: "unresolved", reconciliation_evidence: {} }]);
    await expect(
      (
        await prepareChannexAriReceiptPersistence(
          pool,
          f.ariCorrelation,
          new Response("{}", { status: 500 }),
        )
      )(),
    ).rejects.toThrow("conflict");
    for (const sql of [
      "DELETE FROM pms.channex_offer_ari_receipts WHERE id=$1",
      "UPDATE pms.channex_offer_ari_receipts SET has_warnings=true WHERE id=$1",
    ])
      await expect(pool.query(sql, [f.ariCorrelation.receiptId])).rejects.toMatchObject({
        code: "23514",
      });
  });
  it("records fixed ARI transport ambiguity and warning observations without exception text", async () => {
    const f = await ariReceiptFixture();
    await (
      await prepareChannexAriTransportFailurePersistence(pool, f.ariCorrelation)
    )();
    await (
      await prepareChannexAriReceiptPersistence(
        pool,
        { ...f.ariCorrelation, receiptId: randomUUID() },
        new Response(
          JSON.stringify({
            data: [{ type: "task", id: f.taskId }],
            meta: { warnings: ["secret error"] },
          }),
        ),
      )
    )();
    const rows = (
      await pool.query(
        "SELECT outcome,http_status,provider_request_id,task_ids,has_warnings FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1 ORDER BY captured_at",
        [f.ariCorrelation.attemptId],
      )
    ).rows;
    expect(rows).toEqual([
      {
        outcome: "transport_error",
        http_status: null,
        provider_request_id: null,
        task_ids: [],
        has_warnings: true,
      },
      {
        outcome: "complete_json",
        http_status: 200,
        provider_request_id: null,
        task_ids: [f.taskId],
        has_warnings: true,
      },
    ]);
  });
  it("rejects foreign ARI receipt correlation", async () => {
    const f = await ariReceiptFixture();
    for (const field of ["propertyId", "connectionId", "attemptId", "jobAttemptId", "workerId"])
      await expect(
        (
          await prepareChannexAriReceiptPersistence(
            pool,
            { ...f.ariCorrelation, [field]: randomUUID() },
            f.ariResponse(),
          )
        )(),
      ).rejects.toThrow("correlation unavailable");
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1", [
          f.ariCorrelation.attemptId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("retries only ARI persistence after target contention and fences older snapshots", async () => {
    const f = await ariReceiptFixture(),
      persist = await prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, f.ariResponse());
    const blocker = await pool.connect(),
      stale = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1 FOR UPDATE", [
        f.claim.targetId,
      ]);
      await expect(persist()).rejects.toMatchObject({ code: "55P03" });
      await blocker.query("ROLLBACK");
      await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await stale.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1", [f.claim.targetId]);
      await persist();
      await expect(
        stale.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1 FOR UPDATE", [
          f.claim.targetId,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await blocker.query("ROLLBACK");
      await stale.query("ROLLBACK");
      blocker.release();
      stale.release();
    }
  });
  it.each(["missing", "invalid", "past", "beyond"])(
    "rejects initial ARI %s date admission before storing ownership",
    async (variant) => {
      const f = await initialAriFixture();
      if (variant === "missing")
        await pool.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
          f.scope.propertyId,
        ]);
      if (variant === "invalid")
        await pool.query(
          "UPDATE hotel_catalog.property_locations SET timezone='invalid/zone' WHERE property_id=$1",
          [f.scope.propertyId],
        );
      const date =
        variant === "past" ? "2000-01-01" : variant === "beyond" ? "9999-01-01" : initialAriDate;
      expect(await f.claimAri(date)).toEqual({
        kind: "unavailable",
        reason: "ari_date_unavailable",
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE target_id=$1",
            [f.claim.targetId],
          )
        ).rows[0].count,
      ).toBe(0);
    },
  );
  async function restrictionFixture() {
    const f = await configurationFixture();
    const rateId = ((await f.response().json()) as { data: { id: string } }).data.id;
    const date = "2030-06-14";
    const restrictions = {
      min_stay_arrival: 1,
      min_stay_through: 1,
      max_stay: 0,
      closed_to_arrival: false,
      closed_to_departure: false,
      stop_sell: false,
    };
    const response = { data: { [rateId]: { [date]: restrictions } } };
    return { ...f, rateId, date, restrictions, restrictionResponse: response };
  }
  it("observes restrictions for the identified pending target without granting activation", async () => {
    const f = await restrictionFixture();
    const selected = { ...f.selection },
      lease = { ...f.input };
    const get = vi.fn(async (path: string, signal: AbortSignal) => {
      const query = new URL(path, "https://example.test").searchParams;
      expect(query.get("filter[property_id]")).toBe(f.scope.propertyId);
      expect(query.get("filter[date]")).toBe(f.date);
      expect(signal.aborted).toBe(false);
      selected.roomTypeId = randomUUID();
      lease.jobId = randomUUID();
      return f.restrictionResponse;
    });
    expect(
      await readCurrentChannexNightRestrictions(
        pool,
        lease,
        selected,
        f.claim.attemptId,
        f.date,
        get,
      ),
    ).toEqual({
      kind: "restrictions_observed",
      attemptId: f.claim.attemptId,
      targetId: f.claim.targetId,
      intentId: f.claim.intentId,
      version: f.claim.version,
      observation: {
        kind: "observed",
        externalPropertyId: f.scope.propertyId,
        externalRatePlanId: f.rateId,
        propertyId: f.scope.propertyId,
        roomTypeId: f.selection.roomTypeId,
        offerId: "flex",
        publicationRevision: 1,
        restrictionOfferId: "flex",
        date: f.date,
        restrictions: f.restrictions,
      },
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          `SELECT t.active_version,i.status,i.result_evidence FROM pms.channex_offer_targets t
       JOIN pms.channex_offer_target_intents i ON i.target_id=t.id WHERE i.id=$1`,
          [f.claim.intentId],
        )
      ).rows,
    ).toEqual([{ active_version: null, status: "pending", result_evidence: {} }]);
  });
  it.each(["lease", "receipt", "binding", "mapping", "intent", "terms", "publication"])(
    "rejects restriction observations when %s changes during GET",
    async (variant) => {
      const f = await restrictionFixture();
      const result = await readCurrentChannexNightRestrictions(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        f.date,
        async () => {
          if (variant === "lease")
            await pool.query(
              "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
              [f.input.jobId],
            );
          if (variant === "receipt")
            await (
              await prepareChannexReceiptPersistence(
                pool,
                { ...f.correlation, receiptId: randomUUID() },
                new Response("{}", { status: 500 }),
              )
            )();
          if (variant === "binding")
            await pool.query(
              "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
              [f.scope.propertyId],
            );
          if (variant === "mapping")
            await pool.query(
              "UPDATE pms.channel_room_type_mappings SET external_room_type_id=$2 WHERE property_id=$1",
              [f.scope.propertyId, randomUUID()],
            );
          if (variant === "intent")
            await pool.query(
              "UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1",
              [f.claim.intentId],
            );
          if (variant === "terms")
            await f.booking.save(f.context, f.scope, {
              requestId: randomUUID(),
              expectedRevision: f.terms[0].revision,
              terms: f.termsInput,
            });
          if (variant === "publication")
            await pool.query("UPDATE pms.pricing_v2_heads SET revision=0 WHERE property_id=$1", [
              f.scope.propertyId,
            ]);
          return f.restrictionResponse;
        },
      );
      expect(result).toMatchObject({ kind: "unavailable" });
    },
  );
  it("denies unresolved or invalid restriction selections before provider IO", async () => {
    const f = await receiptFixture();
    const get = vi.fn();
    expect(
      await readCurrentChannexNightRestrictions(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        "2030-06-14",
        get,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "creation_reconciliation_required" });
    expect(
      await readCurrentChannexNightRestrictions(
        pool,
        f.input,
        f.selection,
        "invalid",
        "2030-06-14",
        get,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "invalid_creation_attempt" });
    const ready = await restrictionFixture();
    await expect(
      readCurrentChannexNightRestrictions(
        pool,
        ready.input,
        ready.selection,
        ready.claim.attemptId,
        "2030-02-30",
        get,
      ),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it("propagates failed or mismatched restriction readback without retaining evidence", async () => {
    const f = await restrictionFixture();
    for (const get of [
      async () => {
        throw new Error("transport failed");
      },
      async () => ({}),
    ]) {
      await expect(
        readCurrentChannexNightRestrictions(
          pool,
          f.input,
          f.selection,
          f.claim.attemptId,
          f.date,
          get,
        ),
      ).rejects.toThrow();
    }
    expect(
      (
        await pool.query(
          "SELECT result_evidence FROM pms.channex_offer_target_intents WHERE id=$1",
          [f.claim.intentId],
        )
      ).rows[0].result_evidence,
    ).toEqual({});
  });

  it("retains verified configuration idempotently while leaving the target pending", async () => {
    const f = await configurationFixture();
    await pool.query("UPDATE pms.channex_offer_target_intents SET result_evidence=$2 WHERE id=$1", [
      f.claim.intentId,
      { other: "preserved" },
    ]);
    const get = async () => f.response().json();
    const result = await retainChannexOfferConfiguration(
      pool,
      f.input,
      f.selection,
      f.claim.attemptId,
      get,
    );
    expect(result).toEqual({ kind: "configuration_retained", attemptId: f.claim.attemptId });
    expect(
      await retainChannexOfferConfiguration(pool, f.input, f.selection, f.claim.attemptId, get),
    ).toEqual(result);
    const row = (
      await pool.query(
        "SELECT status,result_evidence FROM pms.channex_offer_target_intents WHERE id=$1",
        [f.claim.intentId],
      )
    ).rows[0];
    expect(row.status).toBe("pending");
    expect(row.result_evidence).toMatchObject({
      other: "preserved",
      configuration: { schemaVersion: 1, attemptId: f.claim.attemptId, intentId: f.claim.intentId },
    });
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          f.claim.targetId,
        ])
      ).rows[0].active_version,
    ).toBeNull();
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_target_versions WHERE target_id=$1", [
          f.claim.targetId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it.each(["lease", "receipt", "mismatch"])(
    "does not retain configuration after %s changes during GET",
    async (variant) => {
      const f = await configurationFixture();
      const read = retainChannexOfferConfiguration(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        async () => {
          if (variant === "lease")
            await pool.query(
              "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
              [f.input.jobId],
            );
          if (variant === "receipt")
            await (
              await prepareChannexReceiptPersistence(
                pool,
                { ...f.correlation, receiptId: randomUUID() },
                new Response("{}", { status: 500 }),
              )
            )();
          if (variant === "mismatch") return {};
          return f.response().json();
        },
      );
      if (variant === "mismatch") await expect(read).rejects.toThrow();
      else expect(await read).toMatchObject({ kind: "unavailable" });
      expect(
        (
          await pool.query(
            "SELECT result_evidence FROM pms.channex_offer_target_intents WHERE id=$1",
            [f.claim.intentId],
          )
        ).rows[0].result_evidence,
      ).toEqual({});
    },
  );
  it("rejects unresolved attempts before GET and preserves conflicting saved evidence", async () => {
    const unresolved = await receiptFixture();
    const get = vi.fn(async () => unresolved.response().json());
    expect(
      await retainChannexOfferConfiguration(
        pool,
        unresolved.input,
        unresolved.selection,
        unresolved.claim.attemptId,
        get,
      ),
    ).toMatchObject({ kind: "unavailable" });
    expect(get).not.toHaveBeenCalled();
    const f = await configurationFixture();
    await pool.query("UPDATE pms.channex_offer_target_intents SET result_evidence=$2 WHERE id=$1", [
      f.claim.intentId,
      { configuration: { schemaVersion: 99 } },
    ]);
    expect(
      await retainChannexOfferConfiguration(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        async () => f.response().json(),
      ),
    ).toMatchObject({ kind: "unavailable", reason: "configuration_evidence_conflict" });
    expect(
      (
        await pool.query(
          "SELECT result_evidence FROM pms.channex_offer_target_intents WHERE id=$1",
          [f.claim.intentId],
        )
      ).rows[0].result_evidence,
    ).toEqual({ configuration: { schemaVersion: 99 } });
  });
  it("identifies from retained evidence and retries the same identity without changing receipts", async () => {
    const f = await receiptFixture();
    await (
      await prepareChannexReceiptPersistence(pool, f.correlation, f.response())
    )();
    const result = await recordRetained(pool, f.input, f.selection, f.claim.attemptId);
    expect(result).toMatchObject({ kind: "identified", attemptId: f.claim.attemptId });
    expect(await recordRetained(pool, f.input, f.selection, f.claim.attemptId)).toEqual(result);
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.claim.attemptId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it.each(["missing", "warning", "scope", "conflict", "malformed"])(
    "holds %s retained creation evidence",
    async (variant) => {
      const f = await receiptFixture();
      if (variant !== "missing") {
        const body = (await f.response().json()) as {
          data: { id: string | null; attributes: Record<string, unknown> };
          warnings?: string[];
        };
        if (variant === "warning") body.warnings = ["ambiguous"];
        if (variant === "scope") body.data.attributes.property_id = randomUUID();
        if (variant === "malformed") body.data.id = null;
        await (
          await prepareChannexReceiptPersistence(
            pool,
            f.correlation,
            new Response(JSON.stringify(body), { status: 201 }),
          )
        )();
        if (variant === "conflict") {
          body.data.id = randomUUID();
          body.data.attributes.id = body.data.id;
          await (
            await prepareChannexReceiptPersistence(
              pool,
              { ...f.correlation, receiptId: randomUUID() },
              new Response(JSON.stringify(body), { status: 201 }),
            )
          )();
        }
      }
      expect(await recordRetained(pool, f.input, f.selection, f.claim.attemptId)).toMatchObject({
        kind: "unavailable",
      });
      expect(
        (
          await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
            f.claim.attemptId,
          ])
        ).rows[0].state,
      ).toBe("unresolved");
    },
  );
  it("preserves retained evidence when current authority has expired", async () => {
    const f = await receiptFixture();
    await (
      await prepareChannexReceiptPersistence(pool, f.correlation, f.response())
    )();
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
      [f.input.jobId],
    );
    expect(await recordRetained(pool, f.input, f.selection, f.claim.attemptId)).toMatchObject({
      kind: "unavailable",
    });
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.claim.attemptId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.claim.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it("persists late receipt independently and makes exact concurrent retries idempotent", async () => {
    const f = await receiptFixture();
    const save = await prepareChannexReceiptPersistence(pool, f.correlation, f.response());
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
      [f.input.jobId],
    );
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      f.claim.intentId,
    ]);
    await pool.query("UPDATE pms.channel_connections SET binding_generation=$2 WHERE id=$1", [
      f.correlation.connectionId,
      randomUUID(),
    ]);
    await save();
    await save();
    const results = await Promise.allSettled([save(), save()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason.code).toBe("55P03");
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.claim.attemptId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.claim.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          f.claim.targetId,
        ])
      ).rows[0].active_version,
    ).toBeNull();
  });
  it("rejects changed receipt evidence and wrong original scope without overwriting", async () => {
    const f = await receiptFixture();
    await (
      await prepareChannexReceiptPersistence(pool, f.correlation, f.response())
    )();
    const changed = new Response(JSON.stringify({ data: { id: "different" } }), { status: 201 });
    await expect(
      (await prepareChannexReceiptPersistence(pool, f.correlation, changed))(),
    ).rejects.toThrow("Channex receipt conflict");
    for (const key of [
      "attemptId",
      "jobAttemptId",
      "propertyId",
      "connectionId",
      "workerId",
    ] as const) {
      const bad = { ...f.correlation, [key]: randomUUID() };
      await expect(
        (await prepareChannexReceiptPersistence(pool, bad, f.response()))(),
      ).rejects.toThrow("Channex receipt correlation unavailable");
    }
    await (
      await prepareChannexReceiptPersistence(
        pool,
        { ...f.correlation, receiptId: randomUUID() },
        f.response(),
      )
    )();
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.claim.attemptId,
        ])
      ).rows,
    ).toHaveLength(2);
  });
  it("retries a lost persistence commit response without consuming the response again", async () => {
    const f = await receiptFixture();
    let lose = true;
    const lost = interceptRead(async (c, sql) => {
      if (sql === "COMMIT" && lose) {
        lose = false;
        await c.query("COMMIT");
        throw new Error("lost receipt commit");
      }
    });
    const response = f.response();
    const save = await prepareChannexReceiptPersistence(lost, f.correlation, response);
    const receiptId = f.correlation.receiptId;
    f.correlation.receiptId = randomUUID();
    f.correlation.workerId = "changed";
    expect(response.bodyUsed).toBe(true);
    await expect(save()).rejects.toThrow("lost receipt commit");
    expect(await save()).toEqual({ kind: "retained", receiptId });
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          f.claim.attemptId,
        ])
      ).rows,
    ).toEqual([{ id: receiptId }]);
  });
  it("blocks replacement creation when an identified attempt has missing or conflicting receipts", async () => {
    const f = await recordingFixture();
    await recordCreation(pool, f.input, f.selection, {
      attemptId: f.claim.attemptId,
      response: f.response,
    });
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      f.claim.intentId,
    ]);
    const selection = { ...f.selection, operationKey: "replacement" };
    expect(await claimPublishedChannexOfferCreate(pool, f.input, selection)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    const connectionId = (
      await pool.query("SELECT connection_id FROM pms.channex_offer_targets WHERE id=$1", [
        f.claim.targetId,
      ])
    ).rows[0].connection_id;
    const scope = {
      receiptId: randomUUID(),
      attemptId: f.claim.attemptId,
      jobAttemptId: f.claim.jobAttemptId,
      workerId: f.claim.workerId,
      propertyId: f.scope.propertyId,
      connectionId,
    };
    await (
      await prepareChannexReceiptPersistence(
        pool,
        scope,
        new Response(JSON.stringify(f.response), { status: 201 }),
      )
    )();
    const ready = await claimPublishedChannexOfferCreate(pool, f.input, selection);
    expect(ready.kind).toBe("claimed");
    if (ready.kind !== "claimed") throw new Error("claim required");
    // A separate logical target exercises an already identified conflicting history.
    const other = await recordingFixture();
    await recordCreation(pool, other.input, other.selection, {
      attemptId: other.claim.attemptId,
      response: other.response,
    });
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      other.claim.intentId,
    ]);
    const conn = (
      await pool.query("SELECT connection_id FROM pms.channex_offer_targets WHERE id=$1", [
        other.claim.targetId,
      ])
    ).rows[0].connection_id;
    const correlation = {
      ...scope,
      receiptId: randomUUID(),
      attemptId: other.claim.attemptId,
      jobAttemptId: other.claim.jobAttemptId,
      workerId: other.claim.workerId,
      propertyId: other.scope.propertyId,
      connectionId: conn,
    };
    await (
      await prepareChannexReceiptPersistence(
        pool,
        correlation,
        new Response(JSON.stringify(other.response), { status: 201 }),
      )
    )();
    await (
      await prepareChannexReceiptPersistence(
        pool,
        { ...correlation, receiptId: randomUUID() },
        new Response(JSON.stringify(createdResponse(other.claim.request.body)), { status: 201 }),
      )
    )();
    expect(
      await claimPublishedChannexOfferCreate(pool, other.input, {
        ...other.selection,
        operationKey: "replacement",
      }),
    ).toEqual({ kind: "unavailable", reason: "creation_reconciliation_required" });
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_target_intents WHERE target_id=$1", [
          other.claim.targetId,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("invalidates an older claim snapshot when receipt capture commits", async () => {
    const f = await receiptFixture();
    const save = await prepareChannexReceiptPersistence(pool, f.correlation, f.response());
    const reader = await pool.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await reader.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1", [
        f.claim.targetId,
      ]);
      await save();
      await expect(
        reader.query("SELECT id FROM pms.channex_offer_targets WHERE id=$1 FOR UPDATE NOWAIT", [
          f.claim.targetId,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
    }
  });
  function providerRoom(f: Awaited<ReturnType<typeof creationFixture>>) {
    return {
      data: {
        type: "room_type",
        id: f.externalRoomTypeId,
        attributes: {
          property_id: f.scope.propertyId,
          room_kind: "room",
          capacity: null,
          occ_adults: 2,
          occ_children: 0,
          occ_infants: 0,
        },
      },
    };
  }
  it("dispatches once through fresh checks and retains a simulated create response", async () => {
    const f = await creationFixture();
    const prepared = await prepareChannexOfferDispatch(pool, f.input, f.selection);
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    const getRoom = vi.fn(async () => providerRoom(f));
    const create = vi.fn(
      async (request: { body: unknown }) =>
        new Response(JSON.stringify(createdResponse(request.body)), { status: 201 }),
    );
    const first = prepared.dispatch({ getRoom, create });
    expect(await prepared.dispatch({ getRoom, create })).toEqual({
      kind: "unavailable",
      reason: "dispatch_already_used",
    });
    const result = await first;
    expect(result.kind).toBe("retained");
    expect(getRoom).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    if (result.kind !== "retained") throw new Error("receipt required");
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_create_receipts WHERE attempt_id=$1", [
          result.attemptId,
        ])
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          result.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
    expect((await prepareChannexOfferDispatch(pool, f.input, f.selection)).kind).toBe(
      "unavailable",
    );
  });
  it("does not send after authority changes during provider preflight", async () => {
    const f = await creationFixture();
    const prepared = await prepareChannexOfferDispatch(pool, f.input, f.selection);
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    const create = vi.fn(async () => new Response("{}", { status: 201 }));
    const result = await prepared.dispatch({
      getRoom: async () => {
        await pool.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
        return providerRoom(f);
      },
      create,
    });
    expect(result).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
    expect(create).not.toHaveBeenCalled();
    expect(await transportReceipts(f.scope.propertyId)).toEqual([]);
  });
  it("holds an ambiguous create failure without allowing another dispatch", async () => {
    const f = await creationFixture();
    const prepared = await prepareChannexOfferDispatch(pool, f.input, f.selection);
    if (prepared.kind !== "prepared") throw new Error("dispatch required");
    const create = vi.fn(async () => {
      throw new Error("private provider failure");
    });
    const ports = { getRoom: async () => providerRoom(f), create };
    expect(await prepared.dispatch(ports)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    expect(await prepared.dispatch(ports)).toEqual({
      kind: "unavailable",
      reason: "dispatch_already_used",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(await transportReceipts(f.scope.propertyId)).toEqual([transportEnvelope]);
    expect((await prepareChannexOfferDispatch(pool, f.input, f.selection)).kind).toBe(
      "unavailable",
    );
  });
  it("simulates room preflight, one creation, durable identity and configuration readback", async () => {
    const f = await creationFixture();
    const identity = {
      externalPropertyId: f.scope.propertyId,
      externalRoomTypeId: f.externalRoomTypeId,
    };
    const room = f.snapshot.rooms[0];
    await verifyChannexOfferRoom(room, identity, async () => ({
      data: {
        type: "room_type",
        id: f.externalRoomTypeId,
        attributes: {
          property_id: f.scope.propertyId,
          room_kind: "room",
          capacity: null,
          occ_adults: 2,
          occ_children: 0,
          occ_infants: 0,
        },
      },
    }));
    const claim = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    if (claim.kind !== "claimed") throw new Error("claim required");
    const send = vi.fn(async (_method: string, _path: string, _body: unknown) =>
      createdResponse(claim.request.body),
    );
    const response = await send(claim.request.method, claim.request.path, claim.request.body);
    const receipt = { attemptId: claim.attemptId, response };
    const result = await recordCreation(pool, f.input, f.selection, receipt);
    expect(result).toEqual({
      kind: "identified",
      attemptId: claim.attemptId,
      externalRatePlanId: response.data.id,
    });
    expect(await recordCreation(pool, f.input, f.selection, receipt)).toEqual(result);
    await expect(
      verifyChannexOfferConfiguration(
        room,
        "flex",
        1,
        { ...identity, externalRatePlanId: response.data.id },
        async () => response,
      ),
    ).resolves.toMatchObject({
      ...identity,
      externalRatePlanId: response.data.id,
      mealType: "room_only",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          claim.targetId,
        ])
      ).rows[0].active_version,
    ).toBeNull();
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_target_versions WHERE target_id=$1", [
          claim.targetId,
        ])
      ).rowCount,
    ).toBe(0);
    const publicRead = await f.serviceRead();
    expect(publicRead).not.toHaveProperty("identification");
    expect(publicRead).not.toHaveProperty("configurationIdentity");
    const changed = createdResponse(claim.request.body);
    expect(
      await recordCreation(pool, f.input, f.selection, {
        attemptId: claim.attemptId,
        response: changed,
      }),
    ).toEqual({ kind: "unavailable", reason: "creation_identity_conflict" });
  });
  it("rejects malformed, contradictory or wrong-scope creation responses", async () => {
    const f = await recordingFixture(),
      response = f.response;
    for (const bad of [
      null,
      {},
      { data: { ...response.data, type: "room_type" } },
      { data: { ...response.data, attributes: { ...response.data.attributes, id: "other" } } },
      { data: { ...response.data, relationships: { property: { data: null } } } },
      { data: { ...response.data, attributes: { ...response.data.attributes, property_id: "" } } },
    ])
      await expect(
        recordCreation(pool, f.input, f.selection, { attemptId: f.claim.attemptId, response: bad }),
      ).rejects.toThrow();
    response.data.attributes.room_type_id = "other";
    expect(
      await recordCreation(pool, f.input, f.selection, { attemptId: f.claim.attemptId, response }),
    ).toEqual({ kind: "unavailable", reason: "creation_identity_mismatch" });
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.claim.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it("captures primitive identity before asynchronous work and accepts relationship-only scope", async () => {
    const f = await recordingFixture(),
      response = f.response,
      id = response.data.id;
    delete response.data.attributes.property_id;
    delete response.data.attributes.room_type_id;
    Object.assign(response.data, {
      relationships: {
        property: { data: { id: f.scope.propertyId } },
        room_type: { data: { id: f.externalRoomTypeId } },
      },
    });
    const changing = interceptRead(async () => {
      response.data.id = randomUUID();
      response.data.attributes.id = response.data.id;
    });
    expect(
      await recordCreation(changing, f.input, f.selection, {
        attemptId: f.claim.attemptId,
        response,
      }),
    ).toEqual({ kind: "identified", attemptId: f.claim.attemptId, externalRatePlanId: id });
  });
  it("does not identify stale attempts or claim a rate retained by another owner", async () => {
    const f = await recordingFixture(),
      receipt = { attemptId: f.claim.attemptId, response: f.response };
    expect(
      await recordCreation(pool, f.input, f.selection, { ...receipt, attemptId: randomUUID() }),
    ).toEqual({ kind: "unavailable", reason: "creation_attempt_unavailable" });
    await pool.query(
      "SELECT pms.claim_channex_external_rate(id,$2,'legacy',$3,'[]') FROM pms.channel_connections WHERE property_id=$1",
      [f.scope.propertyId, f.response.data.id, randomUUID()],
    );
    await expect(recordCreation(pool, f.input, f.selection, receipt)).rejects.toMatchObject({
      code: "23514",
    });
    await pool.query(
      "UPDATE pms.channel_room_type_mappings SET external_room_type_id=$2 WHERE property_id=$1",
      [f.scope.propertyId, randomUUID()],
    );
    expect(await recordCreation(pool, f.input, f.selection, receipt)).toEqual({
      kind: "unavailable",
      reason: "creation_attempt_unavailable",
    });
    await pool.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await recordCreation(pool, f.input, f.selection, receipt)).toEqual({
      kind: "unavailable",
      reason: "operation_conflict",
    });
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.claim.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it("holds ambiguous simulated transport and late unauthorized receipts", async () => {
    const f = await recordingFixture();
    const send = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    await expect(send()).rejects.toThrow("provider timeout");
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    expect(send).toHaveBeenCalledTimes(1);
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
      [f.input.jobId],
    );
    expect(
      await recordCreation(pool, f.input, f.selection, {
        attemptId: f.claim.attemptId,
        response: f.response,
      }),
    ).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          f.claim.attemptId,
        ])
      ).rows[0].state,
    ).toBe("unresolved");
  });
  it("retains original creation correlation after the job is reclaimed", async () => {
    const f = await creationFixture();
    const claim = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    if (claim.kind !== "claimed") throw new Error("claim required");
    const original = (
      await pool.query(
        "SELECT id,worker_id FROM platform.job_attempts WHERE job_id=$1 AND attempt_number=1",
        [f.input.jobId],
      )
    ).rows[0];
    expect(claim.jobAttemptId).toBe(original.id);
    expect(claim.workerId).toBe(original.worker_id);
    await pool.query(
      "UPDATE platform.job_attempts SET status='timed_out',finished_at=now() WHERE id=$1",
      [original.id],
    );
    await pool.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,2,'replacement')",
      [f.input.jobId],
    );
    await pool.query(
      "UPDATE platform.jobs SET attempts_count=2,locked_by='replacement',locked_at=clock_timestamp() WHERE id=$1",
      [f.input.jobId],
    );
    expect(
      await claimPublishedChannexOfferCreate(
        pool,
        { ...f.input, attemptNumber: 2, workerId: "replacement" },
        f.selection,
      ),
    ).toEqual({ kind: "unavailable", reason: "creation_reconciliation_required" });
    expect(
      (
        await pool.query(
          "SELECT job_attempt_id,worker_id FROM pms.channex_offer_create_attempts WHERE id=$1",
          [claim.attemptId],
        )
      ).rows[0],
    ).toEqual({ job_attempt_id: original.id, worker_id: original.worker_id });
  });
  it("claims only a fresh creation and persists the derived closed request before return", async () => {
    const f = await creationFixture();
    const result = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") throw new Error("claim required");
    expect(result.request).toEqual({
      method: "POST",
      path: "/api/v1/rate_plans",
      body: {
        rate_plan: {
          property_id: f.scope.propertyId,
          room_type_id: f.externalRoomTypeId,
          title: `Vayada offer ${result.targetId} v1`,
          currency: "EUR",
          meal_type: "room_only",
          sell_mode: "per_person",
          rate_mode: "manual",
          parent_rate_plan_id: null,
          inherit_rate: false,
          inherit_stop_sell: false,
          auto_rate_settings: null,
          options: [
            { occupancy: 1, is_primary: true },
            { occupancy: 2, is_primary: false },
          ],
          stop_sell: Array(7).fill(true),
        },
      },
    });
    const stored = (
      await pool.query("SELECT * FROM pms.channex_offer_create_attempts WHERE id=$1", [
        result.attemptId,
      ])
    ).rows[0];
    expect(stored).toMatchObject({
      intent_id: result.intentId,
      target_id: result.targetId,
      version: "1",
      binding_generation: result.bindingGeneration,
      state: "unresolved",
      external_rate_plan_id: null,
      request_body: result.request.body,
      job_attempt_id: result.jobAttemptId,
      worker_id: result.workerId,
    });
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    expect(await reservePublishedChannexOfferTarget(pool, f.input, f.selection)).toEqual({
      kind: "reserved",
      targetId: result.targetId,
      intentId: result.intentId,
      version: "1",
    });
    const read = await f.serviceRead();
    expect(read).not.toHaveProperty("createClaim");
    await pool.query(
      "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
      [result.attemptId, randomUUID()],
    );
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "creation_already_identified",
    });
  });
  it("requires an active mapping scoped to this property, connection and room", async () => {
    const f = await creationFixture();
    // A valid mapping on another property does not satisfy this selection.
    await creationFixture();
    for (const status of ["disabled", "stale"]) {
      await pool.query("UPDATE pms.channel_room_type_mappings SET status=$2 WHERE property_id=$1", [
        f.scope.propertyId,
        status,
      ]);
      expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
        kind: "unavailable",
        reason: "room_mapping_unavailable",
      });
    }
    await pool.query("DELETE FROM pms.channel_room_type_mappings WHERE property_id=$1", [
      f.scope.propertyId,
    ]);
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "room_mapping_unavailable",
    });
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_targets WHERE property_id=$1", [
          f.scope.propertyId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("does not reuse a pending proposal after primary or binding changes", async () => {
    const f = await creationFixture();
    await reservePublishedChannexOfferTarget(pool, f.input, f.selection);
    expect(
      await claimPublishedChannexOfferCreate(pool, f.input, {
        ...f.selection,
        primaryOccupancy: 2,
      }),
    ).toEqual({ kind: "unavailable", reason: "operation_conflict" });
    await pool.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "operation_conflict",
    });
    expect(
      (
        await pool.query(
          `SELECT 1 FROM pms.channex_offer_create_attempts a JOIN pms.channex_offer_targets t ON t.id=a.target_id WHERE t.property_id=$1`,
          [f.scope.propertyId],
        )
      ).rowCount,
    ).toBe(0);
  });
  it("allows at most one concurrent fresh claim and holds later retries", async () => {
    const f = await creationFixture();
    const results = await Promise.allSettled([
      claimPublishedChannexOfferCreate(pool, f.input, f.selection),
      claimPublishedChannexOfferCreate(pool, f.input, f.selection),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled" && r.value.kind === "claimed"),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(["40001", "55P03"]).toContain(result.reason.code);
      else if (result.value.kind !== "claimed")
        expect(result.value).toEqual({
          kind: "unavailable",
          reason: "creation_reconciliation_required",
        });
    }
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
    expect(
      (
        await pool.query(
          `SELECT 1 FROM pms.channex_offer_create_attempts a JOIN pms.channex_offer_targets t ON t.id=a.target_id WHERE t.property_id=$1`,
          [f.scope.propertyId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("holds a replacement intent while an older create remains unresolved", async () => {
    const f = await creationFixture();
    const first = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    if (first.kind !== "claimed") throw new Error("claim required");
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      first.intentId,
    ]);
    expect(
      await claimPublishedChannexOfferCreate(pool, f.input, {
        ...f.selection,
        operationKey: "replacement",
      }),
    ).toEqual({ kind: "unavailable", reason: "creation_reconciliation_required" });
    expect(
      (
        await pool.query("SELECT id FROM pms.channex_offer_target_intents WHERE target_id=$1", [
          first.targetId,
        ])
      ).rows,
    ).toEqual([{ id: first.intentId }]);
    expect(
      (
        await pool.query("SELECT state FROM pms.channex_offer_create_attempts WHERE id=$1", [
          first.attemptId,
        ])
      ).rows[0],
    ).toEqual({ state: "unresolved" });
  });
  it("retains unresolved creation after the commit response is lost", async () => {
    const f = await creationFixture();
    const lostReply = interceptRead(async (c, sql) => {
      if (sql === "COMMIT") {
        await c.query("COMMIT");
        throw new Error("lost commit reply");
      }
    });
    await expect(claimPublishedChannexOfferCreate(lostReply, f.input, f.selection)).rejects.toThrow(
      "lost commit reply",
    );
    expect(await claimPublishedChannexOfferCreate(pool, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "creation_reconciliation_required",
    });
  });
  it("rolls back a new attempt and its intent when authority expires before commit", async () => {
    const f = await creationFixture();
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '298 seconds' WHERE id=$1",
      [f.input.jobId],
    );
    let reached = false;
    const delayed = interceptRead(async (c, sql) => {
      if (!reached && sql.includes("INSERT INTO pms.channex_offer_create_attempts")) {
        reached = true;
        await c.query(
          "SELECT pg_sleep(GREATEST(0,extract(epoch FROM locked_at+interval '5 minutes'-clock_timestamp()))+0.02) FROM platform.jobs WHERE id=$1",
          [f.input.jobId],
        );
      }
    });
    expect(await claimPublishedChannexOfferCreate(delayed, f.input, f.selection)).toEqual({
      kind: "unavailable",
      reason: "lease_unavailable",
    });
    expect(reached).toBe(true);
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_targets WHERE property_id=$1", [
          f.scope.propertyId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("reserves current offer work idempotently without activating and rejects conflicting work", async () => {
    const f = await serviceFixture();
    await f.publish();
    const selection = {
      roomTypeId: f.snapshot.rooms[0].roomTypeId,
      offerId: "flex",
      operationKey: "setup-1",
      primaryOccupancy: 1,
    };
    const result = await reservePublishedChannexOfferTarget(pool, f.input, selection);
    expect(result).toMatchObject({ kind: "reserved", version: "1" });
    expect(await reservePublishedChannexOfferTarget(pool, f.input, selection)).toEqual(result);
    const rows = (
      await pool.query(
        `SELECT t.active_version,i.proposal,c.binding_generation
      FROM pms.channex_offer_targets t JOIN pms.channex_offer_target_intents i ON i.target_id=t.id
      JOIN pms.channel_connections c ON c.id=t.connection_id WHERE t.property_id=$1`,
        [f.scope.propertyId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      active_version: null,
      proposal: {
        publicationRevision: 1,
        sources: f.sources,
        room: f.snapshot.rooms[0],
        bindingGeneration: rows[0].binding_generation,
        offerId: "flex",
        primaryOccupancy: 1,
        providerConfiguration: {
          sell_mode: "per_person",
          rate_mode: "manual",
          currency: "EUR",
          meal_type: "room_only",
          options: [
            { occupancy: 1, is_primary: true },
            { occupancy: 2, is_primary: false },
          ],
          stop_sell: Array(7).fill(true),
        },
      },
    });
    expect(
      await reservePublishedChannexOfferTarget(pool, f.input, {
        ...selection,
        operationKey: "setup-2",
      }),
    ).toEqual({ kind: "unavailable", reason: "pending_conflict" });
    expect(
      await reservePublishedChannexOfferTarget(pool, f.input, {
        ...selection,
        primaryOccupancy: 2,
      }),
    ).toEqual({ kind: "unavailable", reason: "operation_conflict" });
    await pool.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await reservePublishedChannexOfferTarget(pool, f.input, selection)).toEqual({
      kind: "unavailable",
      reason: "operation_conflict",
    });
  });
  it("does not reserve invalid or unauthorized selections", async () => {
    const f = await serviceFixture();
    await f.publish();
    const selection = {
      roomTypeId: f.snapshot.rooms[0].roomTypeId,
      offerId: "flex",
      operationKey: "setup",
      primaryOccupancy: 1,
    };
    for (const changed of [{ offerId: "missing" }, { roomTypeId: randomUUID() }])
      expect(
        await reservePublishedChannexOfferTarget(pool, f.input, { ...selection, ...changed }),
      ).toEqual({ kind: "unavailable", reason: "selection_unavailable" });
    for (const primaryOccupancy of [
      undefined,
      null,
      "1",
      0,
      -1,
      1.5,
      3,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(
        await reservePublishedChannexOfferTarget(pool, f.input, {
          ...selection,
          primaryOccupancy: primaryOccupancy as number,
        }),
      ).toEqual({ kind: "unavailable", reason: "invalid_primary_occupancy" });
    expect(
      await reservePublishedChannexOfferTarget(pool, f.input, { ...selection, operationKey: " " }),
    ).toEqual({ kind: "unavailable", reason: "invalid_selection" });
    expect(
      await reservePublishedChannexOfferTarget(pool, { ...f.input, workerId: "wrong" }, selection),
    ).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_targets WHERE property_id=$1", [
          f.scope.propertyId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("rolls back target and intent when authority expires during reservation", async () => {
    const f = await serviceFixture();
    await f.publish();
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '298 seconds' WHERE id=$1",
      [f.input.jobId],
    );
    let reached = false;
    const intercepted = interceptRead(async (c, sql) => {
      if (!reached && sql.includes("INSERT INTO pms.channex_offer_target_intents")) {
        reached = true;
        await c.query(
          "SELECT pg_sleep(GREATEST(0,extract(epoch FROM locked_at+interval '5 minutes'-clock_timestamp()))+0.02) FROM platform.jobs WHERE id=$1",
          [f.input.jobId],
        );
      }
    });
    expect(
      await reservePublishedChannexOfferTarget(intercepted, f.input, {
        roomTypeId: f.snapshot.rooms[0].roomTypeId,
        offerId: "flex",
        operationKey: "expires",
        primaryOccupancy: 1,
      }),
    ).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
    expect(reached).toBe(true);
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_targets WHERE property_id=$1", [
          f.scope.propertyId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("does not reserve an unavailable provider configuration", async () => {
    const f = await serviceFixture(101, 101);
    await f.publish();
    expect(
      await reservePublishedChannexOfferTarget(pool, f.input, {
        roomTypeId: f.snapshot.rooms[0].roomTypeId,
        offerId: "flex",
        operationKey: "oversized",
        primaryOccupancy: 1,
      }),
    ).toEqual({ kind: "unavailable", reason: "candidate_limit" });
    expect(
      (
        await pool.query("SELECT 1 FROM pms.channex_offer_targets WHERE property_id=$1", [
          f.scope.propertyId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("prepares exact nightly candidates from verified publication and retains evidence", async () => {
    const f = await serviceFixture();
    await f.publish();
    const selection = {
      roomTypeId: f.snapshot.rooms[0].roomTypeId,
      offerId: "flex",
      date: "2026-10-01",
    };
    const result = await preparePublishedChannexNightPrices(pool, f.input, selection);
    expect(result).toMatchObject({
      kind: "prepared",
      evidence: { publication: { revision: 1, sources: f.sources }, owners: { charges: f.charges } },
      candidates: [
        { occupancy: 1, rate: "100.00" },
        { occupancy: 2, rate: "100.00" },
      ],
    });
    if (result.kind === "prepared")
      for (const candidate of result.candidates) {
        expect(candidate.projection).toMatchObject({
          propertyId: f.scope.propertyId,
          roomTypeId: selection.roomTypeId,
          offerId: "flex",
          currency: "EUR",
          night: { date: selection.date, totalMinor: "10000" },
        });
      }
    for (const invalid of [
      { ...selection, roomTypeId: randomUUID() },
      { ...selection, offerId: "missing" },
      { ...selection, date: "invalid" },
    ]) {
      const denied = await preparePublishedChannexNightPrices(pool, f.input, invalid);
      expect(denied.kind).toBe("unavailable");
      expect(denied).not.toHaveProperty("candidates");
    }
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await preparePublishedChannexNightPrices(pool, f.input, selection)).toEqual({
      kind: "unavailable",
      reason: "sources_stale",
    });
  });
  it("prepares no candidates for a wrong lease or unpublished prices", async () => {
    const f = await serviceFixture();
    const selection = {
      roomTypeId: f.snapshot.rooms[0].roomTypeId,
      offerId: "flex",
      date: "2026-10-01",
    };
    expect(
      await preparePublishedChannexNightPrices(pool, { ...f.input, workerId: "wrong" }, selection),
    ).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
    expect(await preparePublishedChannexNightPrices(pool, f.input, selection)).toEqual({
      kind: "unavailable",
      reason: "publication_missing",
    });
  });
  it("reads complete publication for a live job without user membership authority", async () => {
    const f = await serviceFixture();
    await f.publish();
    await pool.query("UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1", [
      f.membershipId,
    ]);
    expect(await f.read()).toMatchObject({ reason: "denied" });
    const result = await f.serviceRead();
    expect(result).toMatchObject({
      kind: "available",
      authority: { organizationId: f.scope.organizationId, lease: f.input },
      publication: { revision: 1, sources: f.sources },
      owners: { kind: "verified", finance: f.finance, charges: f.charges },
    });
    if (result.kind === "available")
      expect(result.publication.rooms).toEqual(
        [...f.snapshot.rooms].sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId)),
      );
  });
  it("rejects prices exceeding current room capacity even with matching owner evidence", async () => {
    const f = await serviceFixture(1);
    await f.publish();
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "owner_unavailable" });
  });
  it("rejects stale source evidence independently of method readiness", async () => {
    const f = await serviceFixture();
    await f.publish();
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "sources_stale" });
  });
  it("does not read a draft as a publication and denies an expired job", async () => {
    const f = await serviceFixture();
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "publication_missing" });
    await f.publish();
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
      [f.input.jobId],
    );
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "lease_unavailable" });
  });
  it("denies revoked property access without returning prices", async () => {
    const f = await serviceFixture();
    await f.publish();
    await pool.query(
      "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
      [f.scope.organizationId],
    );
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "scope_unavailable" });
  });
  it.each(["terms", "finance", "room"])("rejects changed %s owner state", async (owner) => {
    const f = await serviceFixture();
    await f.publish();
    if (owner === "terms")
      await f.booking.save(f.context, f.scope, {
        requestId: randomUUID(),
        expectedRevision: f.terms[0].revision,
        terms: f.termsInput,
      });
    if (owner === "finance")
      await pool.query(
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        [f.scope.propertyId],
      );
    if (owner === "room")
      await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [
        f.snapshot.rooms[0].roomTypeId,
      ]);
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "owner_unavailable" });
  });
  it("rejects invalid source sets and unconfirmed charges", async () => {
    const f = await serviceFixture();
    await f.publish(f.snapshot, { ...f.sources, extra: "unsupported" } as typeof f.sources);
    expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "publication_invalid" });
    const g = await serviceFixture();
    await g.publish({
      ...g.snapshot,
      ownerReferences: { ...g.snapshot.ownerReferences, charges: randomUUID() },
    });
    expect(await g.serviceRead()).toEqual({ kind: "unavailable", reason: "owner_unavailable" });
  });
  it("bounds cumulative query delays and releases the transaction for retry", async () => {
    const f = await serviceFixture();
    await f.publish();
    const delayed = new Proxy(pool, {
      get(target, key) {
        if (key !== "connect") return Reflect.get(target, key);
        return async () => {
          const c = await target.connect();
          return new Proxy(c, {
            get(client, method) {
              if (method === "query")
                return async (sql: string, values?: unknown[]) => {
                  if (sql !== "ROLLBACK") await client.query("SELECT pg_sleep(0.12)");
                  return client.query(sql, values);
                };
              const value = Reflect.get(client, method);
              return typeof value === "function" ? value.bind(client) : value;
            },
          });
        };
      },
    });
    const started = performance.now();
    await expect(readPublishedPricingForChannexJob(delayed, f.input)).rejects.toMatchObject({
      code: "57014",
    });
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(await f.serviceRead()).toMatchObject({ kind: "available" });
  });
  function interceptRead(before: (c: pg.PoolClient, sql: string) => Promise<void>) {
    return new Proxy(pool, {
      get(target, key) {
        if (key !== "connect") return Reflect.get(target, key);
        return async () => {
          const c = await target.connect();
          return new Proxy(c, {
            get(client, method) {
              if (method === "query")
                return async (sql: string, values?: unknown[]) => {
                  await before(client, sql);
                  return client.query(sql, values);
                };
              const value = Reflect.get(client, method);
              return typeof value === "function" ? value.bind(client) : value;
            },
          });
        };
      },
    });
  }
  it.each(["lease", "access"])("denies %s expiry after initial authorization", async (boundary) => {
    const f = await serviceFixture();
    await f.publish();
    if (boundary === "lease")
      await pool.query(
        "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '298 seconds' WHERE id=$1",
        [f.input.jobId],
      );
    else
      await pool.query(
        "UPDATE identity.product_entitlements SET expires_at=clock_timestamp()+interval '2 seconds' WHERE organization_id=$1",
        [f.scope.organizationId],
      );
    let reached = false;
    const intercepted = interceptRead(async (c, sql) => {
      if (!reached && sql.includes("h.revision AS head_revision")) {
        reached = true;
        if (boundary === "lease")
          await c.query(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM locked_at+interval '5 minutes'-clock_timestamp()))+0.02) FROM platform.jobs WHERE id=$1",
            [f.input.jobId],
          );
        else
          await c.query(
            "SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))+0.02) FROM identity.product_entitlements WHERE organization_id=$1",
            [f.scope.organizationId],
          );
      }
    });
    expect(await readPublishedPricingForChannexJob(intercepted, f.input)).toEqual({
      kind: "unavailable",
      reason: boundary === "lease" ? "lease_unavailable" : "scope_unavailable",
    });
    expect(reached).toBe(true);
  });
  it("propagates a real serialization conflict and succeeds in a fresh transaction", async () => {
    const f = await serviceFixture();
    await f.publish();
    let changed = false;
    const intercepted = interceptRead(async (_c, sql) => {
      if (!changed && sql.includes("SELECT id FROM hotel_catalog.properties")) {
        changed = true;
        await pool.query(
          "UPDATE hotel_catalog.properties SET display_name='Concurrent update' WHERE id=$1",
          [f.scope.propertyId],
        );
      }
    });
    await expect(readPublishedPricingForChannexJob(intercepted, f.input)).rejects.toMatchObject({
      code: "40001",
    });
    expect(changed).toBe(true);
    expect(await f.serviceRead()).toMatchObject({ kind: "available" });
  });
  it("holds publication and Finance locks until the composed read returns", async () => {
    const f = await serviceFixture();
    await f.publish();
    let checked = false;
    const writer = await pool.connect();
    try {
      const intercepted = interceptRead(async (_c, sql) => {
        if (!checked && sql.includes("SELECT occupancy_limits FROM pms.room_types")) {
          checked = true;
          for (const query of [
            "SELECT pg_advisory_xact_lock(hashtextextended(concat('pms-inventory:', $1::uuid::text),0))",
            "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
          ]) {
            await writer.query("BEGIN");
            await writer.query("SET LOCAL lock_timeout='100ms'");
            await expect(writer.query(query, [f.scope.propertyId])).rejects.toMatchObject({
              code: "55P03",
            });
            await writer.query("ROLLBACK");
          }
        }
      });
      expect(await readPublishedPricingForChannexJob(intercepted, f.input)).toMatchObject({
        kind: "available",
      });
      expect(checked).toBe(true);
      await writer.query(
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        [f.scope.propertyId],
      );
      expect(await f.serviceRead()).toEqual({ kind: "unavailable", reason: "owner_unavailable" });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });
  it("rolls back publication lock contention and succeeds on a fresh retry", async () => {
    const f = await serviceFixture();
    await f.publish();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(concat('pms-inventory:', $1::uuid::text),0))",
        [f.scope.propertyId],
      );
      await expect(f.serviceRead()).rejects.toMatchObject({ code: "55P03" });
      await c.query("ROLLBACK");
      expect(await f.serviceRead()).toMatchObject({ kind: "available" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
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
});
