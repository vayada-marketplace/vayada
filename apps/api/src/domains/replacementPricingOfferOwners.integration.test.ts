import { createPublicPricingOfferCatalog } from "./publicPricingOfferCatalog.js";
import { externalBookingChanges } from "../integrations/externalBookingChanges.js";
import { parsePublicBookingQuote } from "@vayada/domain-booking/replacement-pricing";
import { createReplacementBookingQuoteIssuer } from "../routes/replacementBookingQuote.js";
import Fastify from "fastify";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
} from "../routes/bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import { createReplacementPricingPublicationReader } from "./replacementPricingPublicationReader.js";
import { createPmsBookingPublicationSource } from "./pmsBookingPublicationSource.js";
import { pricingEvidence } from "../bookingGuestPolicyTestFixtures.js";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import {
  buildBookingPublicContent,
  parseBookingPublicContent,
} from "@vayada/domain-distribution/booking-publication";
import { mapReplacementPublicOffers } from "./replacementPublicOfferMapping.js";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { createBookingGuestChoiceStore } from "./bookingGuestChoiceStore.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import {
  bookingQuoteAcceptanceRequirements,
  parseBookingQuoteAcceptanceInput,
} from "./bookingQuoteAcceptanceInput.js";
import {
  redeemCurrentQuotePromo,
  redeemLockedCurrentQuotePromo,
} from "./currentQuotePromoRedemption.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { createCurrentPricingQuoteStore } from "./currentPricingQuoteStore.js";
import { lockCurrentPricingQuote } from "./currentPricingQuote.js";
import {
  parsePublicPricingSelection,
  parseStoredPricingQuote,
  storedPricingQuoteStatus,
} from "@vayada/domain-booking";
import { lockPublicPricingPaymentAmounts } from "./publicPricingPaymentAmounts.js";
import { createFixedChargePolicyStore } from "./fixedChargePolicyStore.js";
import type { FixedChargePolicy } from "./replacementFixedCharges.js";
import { lockPublicPricingChargeTotals } from "./publicPricingChargeTotals.js";
import { lockPublicPricingComponents } from "./publicPricingComponents.js";
import { dispatchNextChannexClosedUpload } from "./channexNextClosedUpload.js";
import { runPmsChannexManagementWorkerOnce } from "../jobs/pmsChannexManagementWorker.js";
import { createPgPmsChannexManagementWorkerStore } from "../jobs/pmsChannexManagementWorkerStore.js";
import { prepareNextChannexInitialAriDispatch } from "./replacementPricingOfferOwners.js";
import { reconcilePendingChannexUploads } from "./channexPendingUploadReconciliation.js";
import { createChannexManagementProvider } from "../integrations/channexManagement.js";
import { bootstrapPublishedChannexOffer } from "../integrations/channexPublishedOfferBootstrap.js";
import { reconcileCurrentChannexInitialAri } from "./replacementPricingOfferOwners.js";
import { readCurrentChannexStagedPrices } from "./replacementPricingOfferOwners.js";
import { readCurrentChannexAriTaskFinishes } from "./replacementPricingOfferOwners.js";
import {
  prepareChannexAriReceiptPersistence,
  prepareChannexAriTransportFailurePersistence,
} from "./channexAriReceiptStore.js";
import {
  prepareChannexInitialAriDispatch,
  claimPublishedChannexInitialAri,
} from "./replacementPricingOfferOwners.js";
import {
  readCurrentChannexStagedRestrictions,
  readCurrentChannexNightRestrictions,
} from "./replacementPricingOfferOwners.js";
import {
  retainChannexOfferConfiguration,
  prepareChannexOfferDispatch,
  recordRetainedChannexOfferCreate as recordRetained,
} from "./replacementPricingOfferOwners.js";
import {
  prepareChannexReceiptPersistence,
  prepareChannexTransportFailurePersistence,
} from "./channexCreationReceiptStore.js";
import {
  verifyChannexOfferRoom,
  verifyChannexOfferConfiguration,
} from "../integrations/channexOfferConfiguration.js";
import { preparePublishedChannexNightPrices } from "./channexPublishedNightPrices.js";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import type { ReplacementOfferTerms } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createBookingPricingOfferTermsStore,
  lockBookingPricingTermsSource,
} from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import {
  lockReplacementPricingOfferOwners as verify,
  readPublishedPricingForChannexJob,
  reservePublishedChannexOfferTarget,
  claimPublishedChannexOfferCreate,
  recordPublishedChannexOfferCreate as recordCreation,
  activatePublishedChannexOffers,
} from "./replacementPricingOfferOwners.js";
import {
  createReplacementChargeDeclarationStore,
  replacementChargeFingerprint,
} from "./replacementChargeDeclarations.js";
import type { PricingStorageSnapshot, PricingStorageSources } from "./replacementPricingStore.js";
import { createReplacementPricingStore } from "./replacementPricingStore.js";
import { createReplacementPricingStorageGuard } from "./replacementPricingStorageGuard.js";
import { createBookingPricingAuthorityStore } from "./bookingPricingAuthority.js";
import { lockPublicPricingPublication } from "./publicPricingPublication.js";
import { lockPublicPricingRoomStay, publicPricingOfferBindings } from "./publicPricingRoomStay.js";
type TermsSetup = (
  terms: Omit<ReplacementOfferTerms, "revision">,
) => Omit<ReplacementOfferTerms, "revision">;
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("live replacement pricing offer owners", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture(
    configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot,
    configureTerms?: TermsSetup,
    enableCard = false,
  ) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const actorUserId = randomUUID(),
      organizationId = randomUUID(),
      propertyId = randomUUID(),
      roomTypeId = randomUUID(),
      membershipId = randomUUID();
    const roleKey = `terms_test_${randomUUID()}`,
      scope = { actorUserId, organizationId, propertyId };
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Terms test')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Terms test',$2)",
      [organizationId, organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Terms test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits)
       VALUES($1,$2,'Terms room','{"total":2,"adults":2,"children":0}'::jsonb)`,
      [roomTypeId, propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
      VALUES($1,$2,$3,$4,'all','agency')`,
      [membershipId, organizationId, actorUserId, roleKey],
    );
    for (const permission of ["pms.rooms_rates.read", "pms.rooms_rates.manage"])
      await pool.query(
        `INSERT INTO identity.role_permission_grants
      (organization_kind,role_key,permission_key) VALUES('hotel_group',$1,$2)`,
        [roleKey, permission],
      );
    for (const [product, type] of [
      ["pms", "pms_property"],
      ["hotel_catalog", "property"],
    ])
      await pool.query(
        `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship) VALUES($1,$2,$3,$4,'owner')`,
        [organizationId, product, type, propertyId],
      );
    await pool.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [organizationId],
    );
    const context: RequestContext = {
      actor: {
        internalUserId: actorUserId,
        email: "terms@example.test",
        status: "active",
        providerIdentity: { provider: "workos", providerUserId: "test-user" },
      },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId,
        roleKey,
        status: "active",
        permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"],
        workosRoleSlugs: [],
      },
      linkedResources: [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      locale: "en",
      currency: "EUR",
      audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
    };
    const booking = createBookingPricingOfferTermsStore(pool),
      secondRoomId = randomUUID();
    await pool.query(
      `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits)
       VALUES($1,$2,'Second room','{"total":2,"adults":2,"children":0}'::jsonb)`,
      [secondRoomId, propertyId],
    );
    const termsInput: Omit<ReplacementOfferTerms, "revision"> = {
      roomTypeId,
      offerId: "flex",
      cancellation: { kind: "non_refundable" },
      payment: { kind: "full" },
    };
    const terms: ReplacementOfferTerms[] = [];
    for (const [room, offerId] of [
      [roomTypeId, "flex"],
      [roomTypeId, "other"],
      [secondRoomId, "flex"],
    ])
      terms.push(
        await booking.save(context, scope, {
          requestId: randomUUID(),
          expectedRevision: null,
          terms: configureTerms
            ? configureTerms({ ...termsInput, roomTypeId: room!, offerId: offerId! })
            : { ...termsInput, roomTypeId: room, offerId },
        }),
      );
    await pool.query(
      `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
      VALUES($1,true,ARRAY['pay_at_property'],'EUR')`,
      [propertyId],
    );
    if (enableCard) {
      const accountId = randomUUID(),
        evidenceId = randomUUID();
      await pool.query(
        `INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status,onboarding_status,
        charges_enabled,payouts_enabled,capabilities,card_capability_revision,account_metadata)
        VALUES($1,$2,'property','stripe',$3,'active','completed',true,true,ARRAY['card_payments'],1,'{"detailsSubmitted":true,"cardPaymentsStatus":"active"}')`,
        [accountId, propertyId, `acct_synthetic_${accountId}`],
      );
      await pool.query(
        "UPDATE finance.payment_settings SET provider_account_id=$2,accepted_methods=ARRAY['card','pay_at_property'] WHERE property_id=$1",
        [propertyId, accountId],
      );
      await pool.query(
        `INSERT INTO finance.online_card_execution_evidence
        (id,property_id,provider_account_id,contract_version,test_suite,provider_capability_revision,property_readiness_revision,
         evidence_fingerprint_hash,executed_at,accepted_at,accepted_by_organization_id,accepted_by_user_id)
        SELECT $1,s.property_id,s.provider_account_id,'finance-online-card-execution-evidence.v1','onb-25a',a.card_capability_revision,
          s.online_card_readiness_revision,$2,now(),now(),$3,$4 FROM finance.payment_settings s
        JOIN finance.payment_provider_accounts a ON a.id=s.provider_account_id WHERE s.property_id=$5`,
        [
          evidenceId,
          evidenceId.replaceAll("-", "").repeat(2),
          organizationId,
          actorUserId,
          propertyId,
        ],
      );
    }
    const client = await pool.connect();
    let finance, roomSource, termsSource, financeSource;
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(
        true,
      );
      roomSource = await lockPmsReplacementPricingRoomSource(client, propertyId);
      termsSource = await lockBookingPricingTermsSource(client, propertyId);
      financeSource = await lockFinanceReplacementPricingSource(client, propertyId);
      finance = await lockFinanceReplacementPricingReadiness(client, {
        propertyId,
        currency: "EUR",
        pricingRevision: 1,
        terms,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    if (finance.kind !== "ready" || !roomSource || !termsSource || !financeSource)
      throw new Error("fixture requires owner evidence");
    let snapshot: PricingStorageSnapshot = {
      currency: "EUR",
      ownerReferences: { finance: finance.evidenceId },
      rooms: [roomTypeId, secondRoomId].map((id) => ({
        version: "pricing.v2",
        propertyId,
        roomTypeId: id,
        revision: 1,
        currency: "EUR",
        capacity: { total: 2, adults: 2, children: 0 },
        children: {
          adultFromAge: 12,
          bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
        },
        offers: terms
          .filter((t) => t.roomTypeId === id)
          .map((t) => ({
            id: t.offerId,
            termsRevision: t.revision,
            meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
            price: {
              kind: "independent",
              calendar: {
                base: { mode: "flat", amountMinor: "10000" },
                months: [],
                seasons: [],
                weekdays: [],
                dates: [],
              },
            },
            restrictions: {
              kind: "own",
              rules: {
                minArrivalNights: 1,
                maxStayNights: null,
                closedToArrival: false,
                closedToDeparture: false,
                stopSell: false,
              },
              seasons: [],
              dates: [],
            },
          })),
      })),
    };
    if (configure) snapshot = configure(snapshot);
    // Source evidence is proposal-independent; ownerReferences.finance is separate readiness evidence.
    const sources = { room: roomSource, terms: termsSource, finance: financeSource },
      draftId = randomUUID();
    // Seed the draft boundary, then create evidence through the real authorized declaration writer.
    await pool.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [propertyId]);
    await pool.query(
      `INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id)
      VALUES($1,$2,1,0,$3,$4,$5)`,
      [propertyId, draftId, sources, snapshot, actorUserId],
    );
    const charges = await createReplacementChargeDeclarationStore(pool).confirm(context, scope, {
      draftId,
      expectedDraftRevision: 1,
      claimedFingerprint: replacementChargeFingerprint(propertyId, snapshot, sources)!,
      declaration: "all_mandatory_charges_included",
      requestId: randomUUID(),
    });
    const declared = {
      ...snapshot,
      ownerReferences: { ...snapshot.ownerReferences, charges: charges.id },
    };
    async function read(
      proposed: unknown = declared,
      auth: RequestContext | null = context,
      currentSources: PricingStorageSources = sources,
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await verify(client, auth, scope, proposed, currentSources);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    async function currentTermsSource() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(
          true,
        );
        const source = await lockBookingPricingTermsSource(client, propertyId);
        expect(await lockBookingPricingTermsSource(client, propertyId.toUpperCase())).toBe(source);
        return source!;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    return {
      scope,
      context,
      membershipId,
      snapshot: declared,
      read,
      booking,
      terms,
      termsInput,
      finance,
      charges,
      sources,
      draftId,
      currentTermsSource,
    };
  }
  async function serviceFixture(total = 2, publishedAdults = 2, baseMinor = "10000") {
    const f = await fixture((snapshot) => ({
        ...snapshot,
        rooms: snapshot.rooms.map((room) => ({
          ...room,
          capacity: { total: publishedAdults, adults: publishedAdults, children: 0 },
          offers: room.offers.map((offer) => ({
            ...offer,
            price:
              offer.price.kind === "independent"
                ? {
                    ...offer.price,
                    calendar: {
                      ...offer.price.calendar,
                      base: { mode: "flat", amountMinor: baseMinor },
                    },
                  }
                : offer.price,
          })),
        })),
      })),
      propertyId = f.scope.propertyId,
      jobId = randomUUID();
    await pool.query(
      "UPDATE pms.room_types SET occupancy_limits=jsonb_build_object('total',$2::int,'adults',$2::int,'children',0) WHERE property_id=$1",
      [propertyId, total],
    );
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
  async function creationFixture(baseMinor = "10000", savedOffer = false) {
    const f = await serviceFixture(2, 2, baseMinor);
    await f.publish();
    const roomTypeId = f.snapshot.rooms[0].roomTypeId,
      externalRoomTypeId = randomUUID();
    if (savedOffer)
      await pool.query(
        `UPDATE platform.jobs SET job_type='channex.provision',
           payload=jsonb_build_object('operationType','provision','publishedOffer',
             jsonb_build_object('roomTypeId',$2::text,'offerId','flex',
               'publicationRevision',1,'primaryOccupancy',1)) WHERE id=$1`,
        [f.input.jobId, roomTypeId],
      );
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings
      (property_id,connection_id,room_type_id,external_room_type_id)
      SELECT property_id,id,$2,$3 FROM pms.channel_connections WHERE property_id=$1`,
      [f.scope.propertyId, roomTypeId, externalRoomTypeId],
    );
    return {
      ...f,
      externalRoomTypeId,
      selection: {
        roomTypeId,
        offerId: "flex",
        operationKey: savedOffer ? f.input.jobId : "create",
        primaryOccupancy: 1,
      },
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
  async function recordingFixture(baseMinor = "10000", savedOffer = false) {
    const f = await creationFixture(baseMinor, savedOffer);
    const claim = await claimPublishedChannexOfferCreate(pool, f.input, f.selection);
    if (claim.kind !== "claimed") throw new Error(`claim required: ${JSON.stringify(claim)}`);
    return { ...f, claim, response: createdResponse(claim.request.body) };
  }
  async function receiptFixture(baseMinor = "10000", savedOffer = false) {
    const f = await recordingFixture(baseMinor, savedOffer);
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
    if (prepared.kind !== "prepared")
      throw new Error(`dispatch required: ${JSON.stringify(prepared)}`);
    const create = vi.fn(async () => new Response("{}"));
    expect(
      await prepared.dispatch({
        getRoom: async () => {
          throw new Error("private GET error");
        },
        create,
      }),
    ).toEqual({ kind: "unavailable", reason: "creation_preflight_unavailable" });
    expect(create).not.toHaveBeenCalled();
    expect(await transportReceipts(f.scope.propertyId)).toEqual([]);
    expect((await prepareChannexOfferDispatch(pool, f.input, f.selection)).kind).toBe("prepared");
    expect(
      (
        await pool.query(
          `SELECT count(*) FILTER (WHERE state='released')::int AS released,
             count(*) FILTER (WHERE state='unresolved')::int AS unresolved
           FROM pms.channex_offer_create_attempts a
           JOIN pms.channex_offer_targets t ON t.id=a.target_id WHERE t.property_id=$1`,
          [f.scope.propertyId],
        )
      ).rows[0],
    ).toEqual({ released: 1, unresolved: 1 });
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
  async function configurationFixture(baseMinor = "10000", savedOffer = false) {
    const f = await receiptFixture(baseMinor, savedOffer);
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
  async function initialAriFixture(baseMinor = "10000", savedOffer = false) {
    const f = await configurationFixture(baseMinor, savedOffer);
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
  async function seedCurrentAvailability(f: Awaited<ReturnType<typeof initialAriFixture>>) {
    const today = new Date().toISOString().slice(0, 10),
      receiptId = randomUUID(),
      taskId = randomUUID(),
      attemptId = randomUUID(),
      digest = "a".repeat(64),
      observations = "b".repeat(64);
    const mapping = (
      await pool.query(
        `SELECT m.id,c.id AS connection_id,c.binding_generation,c.external_property_id,
           m.external_room_type_id
         FROM pms.channel_room_type_mappings m
         JOIN pms.channel_connections c ON c.id=m.connection_id
         WHERE m.property_id=$1 AND m.room_type_id=$2`,
        [f.scope.propertyId, f.selection.roomTypeId],
      )
    ).rows[0];
    const evidence = {
      kind: "available",
      day: {
        propertyId: f.scope.propertyId,
        roomTypeId: f.selection.roomTypeId,
        stayDate: today,
        calendarRevision: 1,
        inventoryRevision: 1,
        sourceRevisions: { generated: 1, channel: 0, manual: 0, block: 0, booking: 0 },
        operatingStatus: "open",
        physicalCapacityCount: 2,
        generatedSellableLimitCount: 2,
        channelSellableLimitCount: null,
        manualSellableLimitCount: null,
        effectiveSellableLimitCount: 2,
        assignedCount: 0,
        blockedCount: 0,
        linkedStopSell: false,
        linkedSourceRevision: 0,
        availableCount: 2,
      },
      configurationSource: {
        ownerDomain: "pms",
        entityType: "pms_operating_calendar.v1",
        entityId: f.scope.propertyId,
        revision: "calendar:1",
      },
      propertyProfileSource: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: f.scope.propertyId,
        revision: "profile:1",
      },
      propertyTimeZone: "Etc/UTC",
      materializedRevision: 1,
      sourceRoomFactsRevision: 1,
      sourceRoomUnitsRevision: 1,
    };
    const request = {
      values: [
        {
          property_id: mapping.external_property_id,
          room_type_id: mapping.external_room_type_id,
          date_from: today,
          date_to: today,
          availability: 2,
        },
      ],
    };
    const reconciliation = {
      schemaVersion: 1,
      completionBasis: "finished_task_fifo",
      observationsSha256: observations,
      inventoryEvidenceSha256: digest,
      originalReceiptId: receiptId,
      taskCount: 1,
      availability: {
        kind: "availability_observed",
        externalPropertyId: mapping.external_property_id,
        externalRoomTypeId: mapping.external_room_type_id,
        date: today,
        availableCount: 2,
      },
    };
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role='replica'");
      await client.query(
        `INSERT INTO pms.operating_calendar_revisions
          (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
           property_time_zone,schedule_mode,recurring_period_count,room_binding_count,
           default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,
           created_by_user_id,created_at,updated_at)
         VALUES($1,$2,1,'pms-operating-calendar.v1',1,'Etc/UTC','year_round',0,1,1,$3,$4,$5,$6,now(),now())`,
        [
          f.scope.organizationId,
          f.scope.propertyId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          f.scope.actorUserId,
        ],
      );
      await client.query(
        `INSERT INTO pms.operating_calendar_room_bindings
          (property_id,calendar_revision,room_type_id,source_room_facts_revision,
           source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
         VALUES($1,1,$2,1,1,2,2)`,
        [f.scope.propertyId, f.selection.roomTypeId],
      );
      await client.query(
        `INSERT INTO pms.inventory_materialization_coverage
          (property_id,organization_id,calendar_revision,materialized_revision,coverage_from,
           coverage_through,room_type_count,expected_day_count,materialized_day_count,
           last_changed_materialization_idempotency_key_id,
           last_changed_materialization_domain_event_id,last_changed_materialization_outbox_event_id,updated_at)
         VALUES($1,$2,1,1,$3,$3,1,1,1,$4,$5,$6,now())`,
        [
          f.scope.propertyId,
          f.scope.organizationId,
          today,
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO pms.inventory_days
          (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
           inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
           generated_source_revision,channel_source_revision,manual_source_revision,
           block_source_revision,booking_source_revision)
         VALUES($1,$2,$3,2,2,1,1,2,2,1,0,0,0,0)`,
        [f.scope.propertyId, f.selection.roomTypeId, today],
      );
      await client.query(
        `INSERT INTO pms.channex_room_availability_attempts
          (id,property_id,connection_id,mapping_id,room_type_id,binding_generation,
           external_property_id,external_room_type_id,job_attempt_id,worker_id,service_date,
           available_count,inventory_evidence,request_body,state,reconciliation_evidence,
           inventory_evidence_sha256)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2,$12,$13,'reconciled',$14,$15)`,
        [
          attemptId,
          f.scope.propertyId,
          mapping.connection_id,
          mapping.id,
          f.selection.roomTypeId,
          mapping.binding_generation,
          mapping.external_property_id,
          mapping.external_room_type_id,
          f.claim.jobAttemptId,
          f.claim.workerId,
          today,
          evidence,
          request,
          reconciliation,
          digest,
        ],
      );
      await client.query(
        `INSERT INTO pms.channex_room_availability_receipts
          (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         VALUES($1,$2,$3,$4,'complete_json',200,ARRAY[$5::uuid],false)`,
        [receiptId, attemptId, f.claim.jobAttemptId, f.claim.workerId, taskId],
      );
      await client.query(
        `INSERT INTO pms.channex_room_availability_reconciliation_attestations
          (attempt_id,receipt_id,inventory_evidence_sha256,observations_sha256,reconciliation_evidence)
         VALUES($1,$2,$3,$4,$5)`,
        [attemptId, receiptId, digest, observations, reconciliation],
      );
    } finally {
      await client.query("SET session_replication_role='origin'");
      client.release();
    }
  }
  async function seedCompletedInitialAri(f: Awaited<ReturnType<typeof initialAriFixture>>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role='replica'");
      await client.query(
        `CREATE TEMP TABLE activation_ari_seed ON COMMIT DROP AS
         SELECT gen_random_uuid() AS attempt_id,gen_random_uuid() AS receipt_id,
           gen_random_uuid() AS task_id,day::date AS service_date
         FROM generate_series(current_date,current_date+548,interval '1 day') day`,
      );
      await client.query(
        `INSERT INTO pms.channex_offer_ari_attempts
          (id,creation_attempt_id,target_id,intent_id,version,binding_generation,
           external_property_id,external_room_type_id,external_rate_plan_id,job_attempt_id,
           worker_id,service_date,request_body,state,reconciliation_evidence)
         SELECT seed.attempt_id,created.id,created.target_id,created.intent_id,created.version,
           created.binding_generation,created.external_property_id,created.external_room_type_id,
           created.external_rate_plan_id,created.job_attempt_id,created.worker_id,seed.service_date,
           '{"values":[{}]}'::jsonb,'reconciled',jsonb_build_object(
             'schemaVersion',1,'completionBasis','finished_task_fifo',
             'observationsSha256',repeat('c',64),'originalReceiptId',seed.receipt_id::text,
             'taskCount',1)
         FROM activation_ari_seed seed
         CROSS JOIN pms.channex_offer_create_attempts created WHERE created.id=$1`,
        [f.claim.attemptId],
      );
      await client.query(
        `INSERT INTO pms.channex_offer_ari_receipts
          (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         SELECT seed.receipt_id,seed.attempt_id,created.job_attempt_id,created.worker_id,
           'complete_json',200,ARRAY[seed.task_id],false
         FROM activation_ari_seed seed
         CROSS JOIN pms.channex_offer_create_attempts created WHERE created.id=$1`,
        [f.claim.attemptId],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
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
  async function continuationFixture() {
    const f = await initialDispatchFixture();
    const progress = await f.prepared.dispatch(f);
    if (progress.kind !== "retained") throw new Error("receipt required");
    const state = { succeed: vi.fn(), fail: vi.fn() };
    const store = createPgPmsChannexManagementWorkerStore({
      connectionString: url!,
      pool,
      targetState: state,
      ariSyncMutating: false,
    });
    const job = {
      jobId: f.input.jobId,
      propertyId: f.scope.propertyId,
      correlationId: null,
      attemptNumber: 1,
      maxAttempts: 1,
      input: {
        operationType: "sync_ari" as const,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    };
    await pool.query("UPDATE platform.jobs SET max_attempts=1,payload=$2::jsonb WHERE id=$1", [
      job.jobId,
      JSON.stringify(job.input),
    ]);
    const continued = {
      ok: false as const,
      code: "initial_upload_retained" as const,
      attemptId: progress.attemptId,
    };
    const run = () =>
      store.continueUpload(job, continued, { workerId: f.input.workerId, now: new Date() });
    return { ...f, store, state, job, continued, run };
  }
  it("credits a retained upload once without completing the job or target", async () => {
    const f = await continuationFixture();
    await f.run();
    expect(
      (
        await pool.query(
          "SELECT status,attempts_count,max_attempts,locked_by,finished_at FROM platform.jobs WHERE id=$1",
          [f.job.jobId],
        )
      ).rows[0],
    ).toEqual({
      status: "pending",
      attempts_count: 1,
      max_attempts: 2,
      locked_by: null,
      finished_at: null,
    });
    expect(f.state.succeed).not.toHaveBeenCalled();
    expect(f.state.fail).not.toHaveBeenCalled();
    await expect(f.run()).rejects.toThrow("Current retained Channex upload required");
    expect(
      (await pool.query("SELECT max_attempts FROM platform.jobs WHERE id=$1", [f.job.jobId]))
        .rows[0].max_attempts,
    ).toBe(2);
  });
  it.each(["expired", "wrong-worker", "foreign-upload", "restrictions-only", "finished-attempt"])(
    "rejects continuation for %s without granting credit",
    async (mode) => {
      const f = await continuationFixture();
      if (mode === "expired")
        await pool.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
          f.job.jobId,
        ]);
      if (mode === "wrong-worker") f.input.workerId = "other";
      if (mode === "foreign-upload")
        f.continued.attemptId = (await continuationFixture()).continued.attemptId;
      if (mode === "restrictions-only")
        await pool.query(
          `UPDATE platform.jobs SET payload=payload || '{"restrictionsOnly":true}'::jsonb WHERE id=$1`,
          [f.job.jobId],
        );
      if (mode === "finished-attempt")
        await pool.query(
          "UPDATE platform.job_attempts SET status='succeeded',finished_at=now() WHERE job_id=$1",
          [f.job.jobId],
        );
      await expect(f.run()).rejects.toThrow();
      expect(
        (
          await pool.query("SELECT max_attempts,status FROM platform.jobs WHERE id=$1", [
            f.job.jobId,
          ])
        ).rows[0],
      ).toEqual({ max_attempts: 1, status: "running" });
      expect(f.state.succeed).not.toHaveBeenCalled();
    },
  );
  it("recovers uncredited receipts after a final-attempt crash, once", async () => {
    const f = await continuationFixture();
    // Scope queue discovery to this fixture; all lease/credit SQL uses real PostgreSQL.
    const scopedPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: (text: string, values?: unknown[]) =>
            text.includes("pms.enqueue_restriction_ari")
              ? Promise.resolve({ rows: [], rowCount: 0 })
              : client.query(
                  text.includes('max_attempts AS "maxAttempts"')
                    ? text.replace(
                        "WHERE queue_name = $1",
                        `WHERE id='${f.job.jobId}'::uuid AND queue_name = $1`,
                      )
                    : text,
                  values,
                ),
        };
      },
      end: async () => {},
    };
    const scoped = createPgPmsChannexManagementWorkerStore({
      connectionString: url!,
      pool: scopedPool,
      targetState: f.state,
      ariSyncMutating: true,
    });
    await pool.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.job.jobId,
    ]);
    const recovered = await scoped.claim({ workerId: "replacement", now: new Date() });
    expect(recovered).toMatchObject({ jobId: f.job.jobId, attemptNumber: 2, maxAttempts: 2 });
    expect(f.state.fail).not.toHaveBeenCalled();
    // No receipt belongs to attempt 2: the old one cannot earn another credit.
    await pool.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
      f.job.jobId,
    ]);
    expect(await scoped.claim({ workerId: "third", now: new Date() })).toBeNull();
    expect(
      (await pool.query("SELECT status FROM platform.jobs WHERE id=$1", [f.job.jobId])).rows[0]
        .status,
    ).toBe("dead_lettered");
    expect(
      (await pool.query("SELECT max_attempts FROM platform.jobs WHERE id=$1", [f.job.jobId]))
        .rows[0].max_attempts,
    ).toBe(2);
  });
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
      ).toBe("prepared");
      expect(
        (
          await pool.query(
            `SELECT count(*) FILTER (WHERE state='released')::int AS released,
               count(*) FILTER (WHERE state='unresolved')::int AS unresolved
             FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1`,
            [f.claim.attemptId],
          )
        ).rows[0],
      ).toEqual({ released: 1, unresolved: 1 });
    },
  );
  it.each(["room_types", "rate_plans"])(
    "never sends after warning-bearing %s metadata",
    async (endpoint) => {
      const f = await initialDispatchFixture();
      const get = async (path: string) => {
        const response = await f.get(path);
        return path.includes(endpoint)
          ? { ...(response as object), meta: { warnings: ["partial"] } }
          : response;
      };
      expect(await f.prepared.dispatch({ get, post: f.post })).toMatchObject({
        reason: "ari_preflight_unavailable",
      });
      expect(f.post).not.toHaveBeenCalled();
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
      ).toBe("prepared");
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
      ).toBe("prepared");
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
  async function ariReceiptFixture(date = initialAriDate) {
    const f = await initialAriFixture(),
      claimed = await f.claimAri(date);
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
  async function stagedPriceFixture(date = initialAriDate) {
    const f = await ariReceiptFixture(date);
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
  it.each(["before", "during"])(
    "rejects authority loss %s staged restriction GET",
    async (when) => {
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
    },
  );
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
    expect(await f.read()).toMatchObject({
      kind: "unavailable",
      reason: "ari_attempt_unavailable",
    });
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
  async function reconciliationFixture(serviceDate = initialAriDate) {
    const f = await stagedPriceFixture(serviceDate);
    const { property_id, rate_plan_id, date, rates: _rates, ...restrictions } = f.stored;
    const task = {
      data: {
        type: "task",
        id: f.taskId,
        attributes: {
          id: f.taskId,
          task: "Property.UpdateRestrictions",
          payload: { values: [f.stored] },
          success: true,
          errors: [],
          received_at: "2026-09-14T00:00:00.000001",
          executed_at: "2026-09-14T00:00:00.000002",
          finished_at: "2026-09-14T00:00:00.000003",
        },
      },
    };
    const get = vi.fn(async (path: string) => {
      if (path.includes("/tasks/")) return structuredClone(task);
      const fields = new URL(path, "https://staging.channex.io").searchParams.get(
        "filter[restrictions]",
      );
      if (fields?.includes("min_stay"))
        return { data: { [rate_plan_id]: { [date]: restrictions } } };
      return f.get(path);
    });
    const reconcile = (port: (path: string, signal: AbortSignal) => Promise<unknown> = get) =>
      reconcileCurrentChannexInitialAri(
        pool,
        f.input,
        f.selection,
        f.claim.attemptId,
        f.ariCorrelation.attemptId,
        port,
      );
    const retain = (response = f.ariResponse()) =>
      prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, response).then((save) => save());
    const state = async () =>
      (
        await pool.query(
          "SELECT state,reconciliation_evidence FROM pms.channex_offer_ari_attempts WHERE id=$1",
          [f.ariCorrelation.attemptId],
        )
      ).rows[0];
    return { ...f, get, task, restrictions, reconcile, retain, state };
  }
  it("automatically selects the hotel-local first date and obtains only one fresh claim", async () => {
    const f = await initialAriFixture();
    await pool.query(
      "UPDATE hotel_catalog.property_locations SET timezone='Pacific/Kiritimati' WHERE property_id=$1",
      [f.scope.propertyId],
    );
    const expected = (
      await pool.query(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati','YYYY-MM-DD') AS date",
      )
    ).rows[0].date;
    expect(
      (await prepareNextChannexInitialAriDispatch(pool, f.input, f.selection, f.claim.attemptId))
        .kind,
    ).toBe("prepared");
    expect(
      (
        await pool.query(
          "SELECT service_date::text AS date FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1",
          [f.claim.attemptId],
        )
      ).rows,
    ).toEqual([{ date: expected }]);
    expect(
      await prepareNextChannexInitialAriDispatch(pool, f.input, f.selection, f.claim.attemptId),
    ).toMatchObject({ reason: "ari_reconciliation_required" });
  });
  it("automatically advances beyond a verified completed local date", async () => {
    const today = (
      await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS date")
    ).rows[0].date;
    const f = await reconciliationFixture(today);
    await f.retain();
    expect((await f.reconcile()).kind).toBe("ari_reconciled");
    expect(
      (await prepareNextChannexInitialAriDispatch(pool, f.input, f.selection, f.claim.attemptId))
        .kind,
    ).toBe("prepared");
    const expected = new Date(`${today}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    expect(
      (
        await pool.query(
          "SELECT service_date::text AS date FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1 AND state='unresolved'",
          [f.claim.attemptId],
        )
      ).rows,
    ).toEqual([{ date: expected.toISOString().slice(0, 10) }]);
  });
  it.each(["timezone", "configuration", "lease"])(
    "does not automatically claim a date with missing %s authority",
    async (mode) => {
      const f = await initialAriFixture();
      if (mode === "timezone")
        await pool.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
          f.scope.propertyId,
        ]);
      if (mode === "configuration")
        await pool.query(
          "UPDATE pms.channex_offer_target_intents SET result_evidence=result_evidence-'configuration' WHERE id=$1",
          [f.claim.intentId],
        );
      if (mode === "lease")
        await pool.query(
          "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
          [f.input.jobId],
        );
      expect(
        (await prepareNextChannexInitialAriDispatch(pool, f.input, f.selection, f.claim.attemptId))
          .kind,
      ).toBe("unavailable");
      expect(
        (
          await pool.query(
            "SELECT id FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1",
            [f.claim.attemptId],
          )
        ).rows,
      ).toEqual([]);
    },
  );
  async function completedDateFixture() {
    const f = await reconciliationFixture();
    await f.retain();
    expect((await f.reconcile()).kind).toBe("ari_reconciled");
    const prepare = (date = nextAriDate) =>
      prepareChannexInitialAriDispatch(pool, f.input, f.selection, f.claim.attemptId, date);
    const get = async (path: string) =>
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
          : f.response().json();
    const post = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ type: "task", id: randomUUID() }], meta: { warnings: [] } }),
        ),
    );
    return { ...f, prepare, preflightGet: get, post };
  }
  it("sends a distinct closed date once after verified earlier completion", async () => {
    const f = await completedDateFixture();
    const next = await f.prepare();
    if (next.kind !== "prepared") throw new Error("Next date must prepare");
    expect(await next.dispatch({ get: f.preflightGet, post: f.post })).toMatchObject({
      kind: "retained",
    });
    expect(f.post).toHaveBeenCalledOnce();
    expect(await next.dispatch({ get: f.preflightGet, post: f.post })).toMatchObject({
      reason: "dispatch_already_used",
    });
    expect(await f.prepare()).toMatchObject({
      kind: "unavailable",
      reason: "ari_reconciliation_required",
    });
    expect(
      (
        await pool.query(
          "SELECT state,service_date::text AS date,request_body#>>'{values,0,stop_sell}' AS closed FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1 ORDER BY service_date",
          [f.claim.attemptId],
        )
      ).rows,
    ).toEqual([
      { state: "reconciled", date: initialAriDate, closed: "true" },
      { state: "unresolved", date: nextAriDate, closed: "true" },
    ]);
  });
  it("does not claim or resend the already reconciled date", async () => {
    const f = await completedDateFixture();
    expect(await f.prepare(initialAriDate)).toMatchObject({
      kind: "unavailable",
      reason: "ari_date_already_reconciled",
    });
    expect(await f.claimAri(initialAriDate)).toMatchObject({
      kind: "unavailable",
      reason: "ari_date_already_reconciled",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1",
          [f.claim.attemptId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(f.post).not.toHaveBeenCalled();
  });
  it("does not use a storage-only release to authorize the next date", async () => {
    const f = await reconciliationFixture();
    await f.retain();
    await pool.query(
      "UPDATE pms.channex_offer_ari_attempts SET state='reconciled',reconciliation_evidence='{\"manual\":true}'::jsonb WHERE id=$1",
      [f.ariCorrelation.attemptId],
    );
    expect(await f.claimAri(nextAriDate)).toMatchObject({
      kind: "unavailable",
      reason: "ari_reconciliation_required",
    });
  });
  it.each(["before_claim", "before_dispatch", "during_preflight"])(
    "holds the next date after a late old receipt %s",
    async (when) => {
      const f = await completedDateFixture();
      const late = async () =>
        (
          await prepareChannexAriTransportFailurePersistence(pool, {
            ...f.ariCorrelation,
            receiptId: randomUUID(),
          })
        )();
      if (when === "before_claim") {
        await late();
        expect(await f.prepare()).toMatchObject({ reason: "ari_reconciliation_required" });
        return;
      }
      const next = await f.prepare();
      if (next.kind !== "prepared") throw new Error("Next date must prepare");
      if (when === "before_dispatch") await late();
      let added = false;
      expect(
        await next.dispatch({
          get: async (path) => {
            if (when === "during_preflight" && !added) {
              added = true;
              await late();
            }
            return f.preflightGet(path);
          },
          post: f.post,
        }),
      ).toMatchObject({ reason: "ari_reconciliation_required" });
      expect(f.post).not.toHaveBeenCalled();
    },
  );
  it("allows only one next-date claim after completion", async () => {
    const f = await completedDateFixture();
    const results = await Promise.allSettled([f.prepare(), f.prepare()]);
    expect(
      results.filter((r) => r.status === "fulfilled" && r.value.kind === "prepared"),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1 AND state='unresolved'",
          [f.claim.attemptId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("activates exactly once after complete ARI and current room availability", async () => {
    const f = await initialAriFixture();
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    const first = await activatePublishedChannexOffers(pool, f.input);
    expect(first).toEqual({ kind: "all_targets_active", count: 1 });
    expect(await activatePublishedChannexOffers(pool, f.input)).toEqual(first);
    const target = (
      await pool.query(
        `SELECT t.active_version,i.status,
           (SELECT count(*)::int FROM pms.channex_offer_target_versions v
             WHERE v.target_id=t.id) AS versions,
           v.readback_evidence#>>'{initialAri,from}' AS "ariFrom",
           v.readback_evidence#>>'{initialAri,through}' AS "ariThrough"
         FROM pms.channex_offer_targets t
         JOIN pms.channex_offer_target_intents i ON i.target_id=t.id
         JOIN pms.channex_offer_target_versions v
           ON v.target_id=t.id AND v.version=t.active_version
         WHERE t.id=$1`,
        [f.claim.targetId],
      )
    ).rows[0];
    const through = new Date(`${target.ariFrom}T00:00:00.000Z`);
    through.setUTCDate(through.getUTCDate() + 548);
    expect(target).toEqual({
      active_version: "1",
      status: "sealed",
      versions: 1,
      ariFrom: new Date().toISOString().slice(0, 10),
      ariThrough: through.toISOString().slice(0, 10),
    });
  });
  it("recognizes the saved operation after activation commits but before job completion", async () => {
    const f = await initialAriFixture("10000", true);
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    expect(await activatePublishedChannexOffers(pool, f.input)).toMatchObject({
      kind: "all_targets_active",
    });
    const job = {
      ...f.input,
      propertyId: f.scope.propertyId,
      correlationId: null,
      maxAttempts: 3,
      input: {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        operationType: "provision" as const,
        publishedOffer: {
          roomTypeId: f.selection.roomTypeId,
          offerId: f.selection.offerId,
          publicationRevision: 1,
          primaryOccupancy: 1,
        },
      },
    };
    const create = vi.fn();
    expect(
      await bootstrapPublishedChannexOffer(pool, job, f.input.workerId, {
        get: vi.fn(),
        create,
      }),
    ).toEqual({ kind: "ready" });
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["availability", "binding"])(
    "keeps the target pending when current %s evidence changes",
    async (changed) => {
      const f = await initialAriFixture();
      await seedCurrentAvailability(f);
      await seedCompletedInitialAri(f);
      if (changed === "availability")
        await pool.query(
          `UPDATE pms.inventory_days SET assigned_count=1,available_count=1,
             booking_source_revision=booking_source_revision+1,
             inventory_revision=inventory_revision+1
           WHERE property_id=$1 AND room_type_id=$2`,
          [f.scope.propertyId, f.selection.roomTypeId],
        );
      else
        await pool.query(
          "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
          [f.scope.propertyId],
        );
      expect(await activatePublishedChannexOffers(pool, f.input)).toMatchObject({
        kind: "unavailable",
      });
      expect(
        (
          await pool.query(
            `SELECT t.active_version,i.status FROM pms.channex_offer_targets t
             JOIN pms.channex_offer_target_intents i ON i.target_id=t.id WHERE t.id=$1`,
            [f.claim.targetId],
          )
        ).rows[0],
      ).toEqual({ active_version: null, status: "pending" });
    },
  );
  it("does not duplicate a version when activation races", async () => {
    const f = await initialAriFixture();
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    const raced = await Promise.allSettled([
      activatePublishedChannexOffers(pool, f.input),
      activatePublishedChannexOffers(pool, f.input),
    ]);
    expect(
      raced.some(
        (result) => result.status === "fulfilled" && result.value.kind === "all_targets_active",
      ),
    ).toBe(true);
    expect(await activatePublishedChannexOffers(pool, f.input)).toEqual({
      kind: "all_targets_active",
      count: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM pms.channex_offer_target_versions WHERE target_id=$1",
          [f.claim.targetId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("does not accept an incomplete replacement over the active version", async () => {
    const f = await initialAriFixture();
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    expect(await activatePublishedChannexOffers(pool, f.input)).toMatchObject({
      kind: "all_targets_active",
    });
    const replacement = { ...f.selection, operationKey: "replacement-pending" };
    expect(await reservePublishedChannexOfferTarget(pool, f.input, replacement)).toMatchObject({
      kind: "reserved",
      version: "2",
    });
    expect(await activatePublishedChannexOffers(pool, f.input)).toEqual({
      kind: "unavailable",
      reason: "target_activation_pending",
    });
    expect(
      (
        await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [
          f.claim.targetId,
        ])
      ).rows[0].active_version,
    ).toBe("1");
  });
  it("activates a fully verified replacement and preserves both versions", async () => {
    const f = await initialAriFixture();
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    await activatePublishedChannexOffers(pool, f.input);
    const selection = { ...f.selection, operationKey: "replacement-complete" };
    const claim = await claimPublishedChannexOfferCreate(pool, f.input, selection);
    if (claim.kind !== "claimed") throw new Error("replacement claim required");
    const created = createdResponse(claim.request.body),
      correlation = {
        ...f.correlation,
        receiptId: randomUUID(),
        attemptId: claim.attemptId,
        jobAttemptId: claim.jobAttemptId,
        workerId: claim.workerId,
      };
    await (
      await prepareChannexReceiptPersistence(
        pool,
        correlation,
        Response.json(created, { status: 201 }),
      )
    )();
    expect(await recordRetained(pool, f.input, selection, claim.attemptId)).toMatchObject({
      kind: "identified",
    });
    expect(
      await retainChannexOfferConfiguration(pool, f.input, selection, claim.attemptId, async () =>
        Response.json(created).json(),
      ),
    ).toMatchObject({ kind: "configuration_retained" });
    await seedCompletedInitialAri({ ...f, selection, claim });
    expect(await activatePublishedChannexOffers(pool, f.input)).toEqual({
      kind: "all_targets_active",
      count: 1,
    });
    expect(
      (
        await pool.query(
          `SELECT active_version,
             (SELECT count(*)::int FROM pms.channex_offer_target_versions version
               WHERE version.target_id=target.id) AS versions
           FROM pms.channex_offer_targets target WHERE id=$1`,
          [f.claim.targetId],
        )
      ).rows[0],
    ).toEqual({ active_version: "2", versions: 2 });
  });
  it("does not accept an active version after its binding changes", async () => {
    const f = await initialAriFixture();
    await seedCurrentAvailability(f);
    await seedCompletedInitialAri(f);
    await activatePublishedChannexOffers(pool, f.input);
    await pool.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await activatePublishedChannexOffers(pool, f.input)).toEqual({
      kind: "unavailable",
      reason: "target_activation_pending",
    });
  });
  it("worker reconciles today, sends tomorrow closed once, and continues without sync success", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const f = await reconciliationFixture(today),
      foreign = await initialAriFixture();
    await f.retain();
    const posts: { values: { date: string; stop_sell: boolean }[] }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "user-api-key": "synthetic" });
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      if (init?.method === "POST") {
        expect(path).toBe("/api/v1/restrictions");
        posts.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            data: [{ type: "task", id: randomUUID() }],
            meta: { message: "Success" },
          }),
        );
      }
      return Response.json(
        path.includes("/properties/")
          ? {
              data: {
                type: "property",
                id: f.scope.propertyId,
                attributes: { settings: { min_stay_type: "both" } },
              },
            }
          : path.includes("/room_types/")
            ? providerRoom(f)
            : await f.get(path),
      );
    });
    const plan = vi.fn(async () => ({ requests: [] }));
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      plans: { plan },
      fetch: fetcher,
      reconcileClosedUploads: (lease, get) => reconcilePendingChannexUploads(pool, lease, get),
      dispatchClosedUpload: (lease, ports) => dispatchNextChannexClosedUpload(pool, lease, ports),
    });
    const state = { succeed: vi.fn(), fail: vi.fn() };
    const job = {
      jobId: f.input.jobId,
      propertyId: f.scope.propertyId,
      correlationId: null,
      attemptNumber: 1,
      maxAttempts: 1,
      input: {
        operationType: "sync_ari" as const,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    };
    await pool.query("UPDATE platform.jobs SET max_attempts=1,payload=$2::jsonb WHERE id=$1", [
      job.jobId,
      JSON.stringify(job.input),
    ]);
    const store = createPgPmsChannexManagementWorkerStore({
      connectionString: url!,
      pool,
      targetState: state,
    });
    expect(
      await runPmsChannexManagementWorkerOnce({
        store: { ...store, claim: async () => job },
        provider,
        workerId: f.input.workerId,
      }),
    ).toMatchObject({ outcome: "continued" });
    expect(posts).toEqual([
      {
        values: [
          expect.objectContaining({
            date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
            stop_sell: true,
          }),
        ],
      },
    ]);
    expect((await f.state()).state).toBe("reconciled");
    expect(
      (await pool.query("SELECT status,max_attempts FROM platform.jobs WHERE id=$1", [job.jobId]))
        .rows[0],
    ).toEqual({ status: "pending", max_attempts: 2 });
    expect(
      (
        await pool.query(
          "SELECT id FROM pms.channex_offer_ari_attempts WHERE creation_attempt_id=$1",
          [foreign.claim.attemptId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(state.succeed).not.toHaveBeenCalled();
    expect(state.fail).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    await provider.execute(job, { workerId: f.input.workerId });
    expect(posts).toHaveLength(1);
  });
  it("discovers and reconciles only the leased property uploads through the worker provider", async () => {
    const f = await reconciliationFixture(),
      foreign = await reconciliationFixture();
    await f.retain();
    await foreign.retain();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      const parsed = new URL(String(url));
      return new Response(JSON.stringify(await f.get(parsed.pathname + parsed.search)));
    });
    const plan = vi.fn(async () => {
      throw new Error("Pricing dispatch remains unavailable");
    });
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      canSyncAri: true,
      plans: { plan },
      fetch: fetcher,
      reconcileClosedUploads: (lease, get) => reconcilePendingChannexUploads(pool, lease, get),
    });
    const job = {
      jobId: f.input.jobId,
      propertyId: f.scope.propertyId,
      correlationId: null,
      attemptNumber: f.input.attemptNumber,
      maxAttempts: 3,
      input: {
        operationType: "sync_ari" as const,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    };
    expect(await provider.execute(job, { workerId: f.input.workerId })).toMatchObject({
      ok: false,
      code: "invalid_state",
    });
    expect((await f.state()).state).toBe("reconciled");
    expect((await foreign.state()).state).toBe("unresolved");
    const calls = fetcher.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(await provider.execute(job, { workerId: f.input.workerId })).toMatchObject({
      ok: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect(plan).toHaveBeenCalledTimes(2);
  });
  it("rejects stale worker identity before discovering pending uploads", async () => {
    const f = await reconciliationFixture();
    await f.retain();
    expect(
      await reconcilePendingChannexUploads(pool, { ...f.input, workerId: "old-worker" }, f.get),
    ).toMatchObject({ kind: "unavailable", reason: "lease_unavailable" });
    expect(f.get).not.toHaveBeenCalled();
    expect((await f.state()).state).toBe("unresolved");
  });
  it("holds discovered uploads without original receipts", async () => {
    const f = await reconciliationFixture();
    expect(await reconcilePendingChannexUploads(pool, f.input, f.get)).toMatchObject({
      kind: "unavailable",
      reason: "ari_receipt_history_unavailable",
    });
    expect(f.get).not.toHaveBeenCalled();
    expect((await f.state()).state).toBe("unresolved");
  });
  it("reconciles closed ARI atomically with all provider observations and cannot replay", async () => {
    const f = await reconciliationFixture();
    await f.retain();
    expect(await f.reconcile()).toMatchObject({
      kind: "ari_reconciled",
      ariAttemptId: f.ariCorrelation.attemptId,
    });
    expect(await f.state()).toMatchObject({
      state: "reconciled",
      reconciliation_evidence: {
        completionBasis: "finished_task_fifo",
        originalReceiptId: f.ariCorrelation.receiptId,
        taskCount: 1,
        priceCount: 2,
        observationsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        restrictions: { restrictions: { stop_sell: true } },
      },
    });
    const calls = f.get.mock.calls.length;
    expect(await f.reconcile()).toMatchObject({
      kind: "unavailable",
      reason: "ari_attempt_unavailable",
    });
    expect(f.get).toHaveBeenCalledTimes(calls);
    expect(
      (
        await pool.query("SELECT status FROM pms.channex_offer_target_intents WHERE id=$1", [
          f.claim.intentId,
        ])
      ).rows[0].status,
    ).toBe("pending");
  });
  it.each(["missing", "warnings"])(
    "keeps %s ARI receipts unresolved before reconciliation IO",
    async (mode) => {
      const f = await reconciliationFixture();
      if (mode === "warnings")
        await f.retain(
          new Response(
            JSON.stringify({
              data: [{ type: "task", id: f.taskId }],
              meta: { warnings: ["partial"] },
            }),
          ),
        );
      expect(await f.reconcile()).toMatchObject({
        kind: "unavailable",
        reason: "ari_receipt_history_unavailable",
      });
      expect(f.get).not.toHaveBeenCalled();
      expect((await f.state()).state).toBe("unresolved");
    },
  );
  it.each(["task", "price", "restriction"])(
    "keeps mismatched %s evidence unresolved",
    async (mode) => {
      const f = await reconciliationFixture();
      await f.retain();
      if (mode === "task") f.task.data.attributes.success = false;
      if (mode === "restriction") f.restrictions.stop_sell = false;
      await expect(
        f.reconcile(async (path) => {
          if (mode === "price" && path.includes("/restrictions")) return { data: {} };
          return f.get(path);
        }),
      ).rejects.toThrow();
      expect((await f.state()).state).toBe("unresolved");
    },
  );
  it.each(["lease", "receipt", "configuration"])(
    "rolls back ARI reconciliation after %s changes during IO",
    async (mode) => {
      const f = await reconciliationFixture();
      await f.retain();
      let changed = false;
      const result = await f.reconcile(async (path) => {
        if (!changed) {
          changed = true;
          if (mode === "lease")
            await pool.query(
              "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
              [f.input.jobId],
            );
          if (mode === "configuration")
            await pool.query(
              "UPDATE pms.channex_offer_target_intents SET result_evidence=result_evidence-'configuration' WHERE id=$1",
              [f.claim.intentId],
            );
          if (mode === "receipt")
            await (
              await prepareChannexAriTransportFailurePersistence(pool, {
                ...f.ariCorrelation,
                receiptId: randomUUID(),
              })
            )();
        }
        return f.get(path);
      });
      expect(result.kind).toBe("unavailable");
      expect((await f.state()).state).toBe("unresolved");
    },
  );
  it("reconciles 100 original tasks within the durable evidence size limit", async () => {
    const f = await reconciliationFixture();
    const ids = Array.from({ length: 100 }, () => randomUUID());
    await f.retain(
      new Response(
        JSON.stringify({ data: ids.map((id) => ({ type: "task", id })), meta: { warnings: [] } }),
      ),
    );
    let count = 0;
    expect(
      (
        await f.reconcile(async (path) => {
          if (!path.includes("/tasks/")) return f.get(path);
          const id = path.split("/").at(-1)!;
          expect(ids).toContain(id);
          count++;
          return { data: { ...f.task.data, id, attributes: { ...f.task.data.attributes, id } } };
        })
      ).kind,
    ).toBe("ari_reconciled");
    expect(count).toBe(100);
    expect((await f.state()).reconciliation_evidence.taskCount).toBe(100);
    expect(
      (
        await pool.query(
          "SELECT octet_length(reconciliation_evidence::text) AS bytes FROM pms.channex_offer_ari_attempts WHERE id=$1",
          [f.ariCorrelation.attemptId],
        )
      ).rows[0].bytes,
    ).toBeLessThan(8192);
  });
  it("rolls back a saved ARI reconciliation when final lease verification fails", async () => {
    const f = await reconciliationFixture();
    await f.retain();
    const name = `expire_reconcile_${randomUUID().replaceAll("-", "")}`;
    // Isolated test DB: expire this lease inside the same transaction as the transition.
    await pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '10 minutes'
        WHERE id='${f.input.jobId}'; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${name} AFTER UPDATE ON pms.channex_offer_ari_attempts
          FOR EACH ROW WHEN (NEW.id='${f.ariCorrelation.attemptId}' AND NEW.state='reconciled')
          EXECUTE FUNCTION public.${name}()`);
      expect(await f.reconcile()).toMatchObject({
        kind: "unavailable",
        reason: "lease_unavailable",
      });
      expect((await f.state()).state).toBe("unresolved");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON pms.channex_offer_ari_attempts`);
      await pool.query(`DROP FUNCTION public.${name}()`);
    }
    expect((await f.reconcile()).kind).toBe("ari_reconciled");
  });
  it("allows only one concurrent ARI reconciliation to commit", async () => {
    const f = await reconciliationFixture();
    await f.retain();
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const get = async (path: string) => {
      if (path.includes("/tasks/")) {
        if (++started === 2) release();
        await barrier;
      }
      return f.get(path);
    };
    const results = await Promise.allSettled([f.reconcile(get), f.reconcile(get)]);
    expect(
      results.filter((r) => r.status === "fulfilled" && r.value.kind === "ari_reconciled"),
    ).toHaveLength(1);
    expect((await f.state()).state).toBe("reconciled");
  });
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
  it("admits retained explicit Success without warnings for original task observation", async () => {
    const f = await taskReadFixture();
    await f.retain(
      new Response(
        JSON.stringify({ data: [{ type: "task", id: f.taskId }], meta: { message: "Success" } }),
      ),
    );
    expect(
      (
        await pool.query(
          "SELECT warning_reason,has_warnings FROM pms.channex_offer_ari_receipts WHERE id=$1",
          [f.ariCorrelation.receiptId],
        )
      ).rows,
    ).toEqual([{ warning_reason: null, has_warnings: false }]);
    expect((await f.readTasks(async () => f.task())).kind).toBe("ari_tasks_observed");
  });
  it("retains distinct warning classifications and rejects same-receipt diagnostic changes", async () => {
    const f = await taskReadFixture();
    const response = (meta: unknown) =>
      new Response(JSON.stringify({ data: [{ type: "task", id: f.taskId }], meta }));
    const persist = await prepareChannexAriReceiptPersistence(
      pool,
      f.ariCorrelation,
      response({ warnings: ["private message"] }),
    );
    await persist();
    await persist();
    expect(
      (
        await pool.query(
          "SELECT warning_reason,has_warnings FROM pms.channex_offer_ari_receipts WHERE id=$1",
          [f.ariCorrelation.receiptId],
        )
      ).rows,
    ).toEqual([{ warning_reason: "provider_warnings", has_warnings: true }]);
    await expect(
      (await prepareChannexAriReceiptPersistence(pool, f.ariCorrelation, response({})))(),
    ).rejects.toThrow("conflict");
    const get = vi.fn(async () => f.task());
    expect(await f.readTasks(get)).toMatchObject({
      kind: "unavailable",
      reason: "ari_receipt_history_unavailable",
    });
    expect(get).not.toHaveBeenCalled();
    await expect(
      pool.query("UPDATE pms.channex_offer_ari_receipts SET warning_reason=NULL WHERE id=$1", [
        f.ariCorrelation.receiptId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
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
        "SELECT outcome,http_status,task_ids,has_warnings,warning_reason FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1",
        [f.ariCorrelation.attemptId],
      )
    ).rows;
    expect(rows).toEqual([
      {
        outcome: "complete_json",
        http_status: 200,
        task_ids: [f.taskId],
        has_warnings: false,
        warning_reason: null,
      },
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
        "SELECT outcome,http_status,provider_request_id,task_ids,has_warnings,warning_reason FROM pms.channex_offer_ari_receipts WHERE attempt_id=$1 ORDER BY captured_at",
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
        warning_reason: null,
      },
      {
        outcome: "complete_json",
        http_status: 200,
        provider_request_id: null,
        task_ids: [f.taskId],
        has_warnings: true,
        warning_reason: "provider_warnings",
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
  function providerRoom(
    f: Pick<Awaited<ReturnType<typeof creationFixture>>, "externalRoomTypeId" | "scope">,
  ) {
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
  it("replays a saved-offer creation receipt without creating a second Channex rate", async () => {
    const f = await creationFixture("10000", true);
    const selection = f.selection;
    const job = {
      ...f.input,
      propertyId: f.scope.propertyId,
      correlationId: null,
      maxAttempts: 3,
      input: {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        operationType: "provision" as const,
        publishedOffer: {
          roomTypeId: selection.roomTypeId,
          offerId: selection.offerId,
          publicationRevision: 1,
          primaryOccupancy: 1,
        },
      },
    };
    let created: unknown;
    const create = vi.fn(async (request: { body: unknown }) => {
      created = createdResponse(request.body);
      return new Response(JSON.stringify(created), { status: 201 });
    });
    const get = vi.fn(async (path: string) =>
      path.includes("/room_types/") ? providerRoom(f) : created,
    );
    expect(
      await bootstrapPublishedChannexOffer(pool, job, f.input.workerId, { get, create }),
    ).toMatchObject({ kind: "creation_retained" });
    expect(create).toHaveBeenCalledOnce();
    expect(
      await bootstrapPublishedChannexOffer(pool, job, f.input.workerId, { get, create }),
    ).toEqual({ kind: "ready" });
    expect(create).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM pms.channex_offer_create_receipts receipt
       JOIN pms.channex_offer_create_attempts attempt ON attempt.id=receipt.attempt_id
       JOIN pms.channex_offer_targets target ON target.id=attempt.target_id
       WHERE target.property_id=$1`,
          [f.scope.propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
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
      evidence: {
        publication: { revision: 1, sources: f.sources },
        owners: { charges: f.charges },
      },
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
    await pool.query(
      "UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1",
      [f.membershipId],
    );
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
    expect(await f.read()).toEqual({
      kind: "verified",
      terms: f.terms,
      finance: f.finance,
      charges: f.charges,
    });
    expect(await f.read({ ...f.snapshot, rooms: [...f.snapshot.rooms].reverse() })).toMatchObject({
      kind: "verified",
    });
    expect(await f.read({ ...f.snapshot, rooms: [f.snapshot.rooms[0]] })).toMatchObject({
      reason: "finance_unavailable",
      financeReason: "stale",
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM platform.domain_events WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].n,
    ).toBe(4); // terms + declaration writers only
  });
  it("denies missing or revoked authorization and foreign or inactive room scope", async () => {
    const f = await fixture(),
      other = await fixture();
    expect(await f.read(f.snapshot, null)).toMatchObject({ reason: "denied" });
    expect(await f.read(f.snapshot, other.context)).toMatchObject({ reason: "denied" });
    const foreignRoom = { ...f.snapshot.rooms[1], roomTypeId: other.snapshot.rooms[0].roomTypeId };
    expect(
      await f.read({ ...f.snapshot, rooms: [f.snapshot.rooms[0], foreignRoom] }),
    ).toMatchObject({ reason: "room_unavailable" });
    await pool.query("UPDATE pms.room_types SET active=false WHERE id=$1", [
      f.snapshot.rooms[1].roomTypeId,
    ]);
    expect(await f.read()).toMatchObject({ reason: "room_unavailable" });
    await pool.query(
      "UPDATE identity.organization_memberships SET status='suspended' WHERE id=$1",
      [f.membershipId],
    );
    expect(await f.read()).toMatchObject({ reason: "denied" });
  });
  it("rejects malformed, duplicate, mixed-revision and cross-property configurations", async () => {
    const f = await fixture(),
      first = f.snapshot.rooms[0];
    for (const input of [
      null,
      { ...f.snapshot, rooms: [] },
      { ...f.snapshot, ownerReferences: {} },
      { ...f.snapshot, rooms: [first, first] },
      { ...f.snapshot, rooms: [first, { ...f.snapshot.rooms[1], revision: 2 }] },
      { ...f.snapshot, rooms: [{ ...first, roomTypeId: "not-a-uuid" }] },
      { ...f.snapshot, rooms: [{ ...first, propertyId: randomUUID() }] },
      { ...f.snapshot, currency: "USD" },
    ])
      expect(await f.read(input)).toMatchObject({ reason: "invalid" });
  });
  it("rejects stale and foreign terms on any selected offer", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const index of [0, 1]) {
      const rooms = [...f.snapshot.rooms];
      rooms[0] = {
        ...rooms[0],
        offers: rooms[0].offers.map((o, i) =>
          i === index ? { ...o, termsRevision: other.terms[0].revision } : o,
        ),
      };
      expect(await f.read({ ...f.snapshot, rooms })).toMatchObject({ reason: "terms_stale" });
    }
    const last = f.terms[2];
    await f.booking.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: last.revision,
      terms: { ...f.termsInput, roomTypeId: last.roomTypeId, offerId: last.offerId },
    });
    expect(await f.read()).toMatchObject({ reason: "terms_stale" });
  });
  it("rejects foreign/stale Finance evidence, disabled payments and requested deposits", async () => {
    const f = await fixture(),
      other = await fixture();
    expect(
      await f.read({ ...f.snapshot, ownerReferences: { finance: other.finance.evidenceId } }),
    ).toMatchObject({ financeReason: "stale" });
    expect(
      await f.read({ ...f.snapshot, rooms: f.snapshot.rooms.map((r) => ({ ...r, revision: 2 })) }),
    ).toMatchObject({ financeReason: "stale" });
    expect(
      await f.read({
        ...f.snapshot,
        currency: "USD",
        rooms: f.snapshot.rooms.map((r) => ({ ...r, currency: "USD" })),
      }),
    ).toMatchObject({ financeReason: "currency_mismatch" });
    await pool.query(
      "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await f.read()).toMatchObject({ financeReason: "payments_disabled" });
    await pool.query(
      "UPDATE finance.payment_settings SET payments_enabled=true WHERE property_id=$1",
      [f.scope.propertyId],
    );
    const saved = await f.booking.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: f.terms[0].revision,
      terms: {
        ...f.termsInput,
        payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 },
      },
    });
    const rooms = [...f.snapshot.rooms];
    rooms[0] = {
      ...rooms[0],
      offers: rooms[0].offers.map((o, i) =>
        i === 0 ? { ...o, termsRevision: saved.revision } : o,
      ),
    };
    expect(
      await f.read({ ...f.snapshot, rooms }, f.context, {
        ...f.sources,
        terms: await f.currentTermsSource(),
      }),
    ).toMatchObject({ financeReason: "deposit_execution_unavailable" });
  });
  it("holds live owner locks until transaction end, then rejects the replaced terms", async () => {
    const f = await fixture(),
      client = await pool.connect(),
      writer = new pg.Pool({ connectionString: url, max: 1 });
    const command = {
      requestId: randomUUID(),
      expectedRevision: f.terms[0].revision,
      terms: f.termsInput,
    };
    try {
      await writer.query("SET lock_timeout='150ms'");
      await client.query("BEGIN");
      expect(await verify(client, f.context, f.scope, f.snapshot, f.sources)).toMatchObject({
        kind: "verified",
      });
      await expect(
        createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        writer.query(
          "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
          [f.scope.propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await client.query("COMMIT");
      await createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command);
      expect(await f.read()).toMatchObject({ reason: "terms_stale" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await writer.end();
    }
  });
  it("requires the exact property declaration and rejects changed pricing or source evidence", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const id of [undefined, "unconfirmed", randomUUID(), other.charges.id]) {
      const ownerReferences: Record<string, string> = { finance: f.finance.evidenceId };
      if (id !== undefined) ownerReferences.charges = id;
      expect(await f.read({ ...f.snapshot, ownerReferences })).toMatchObject({
        reason: "charges_stale",
      });
    }
    const first = f.snapshot.rooms[0],
      offer = first.offers[0];
    const changes = [
      {
        ...first,
        children: {
          ...first.children,
          bands: first.children.bands.map((b) => ({ ...b, nightlyMinor: "500" })),
        },
      },
      {
        ...first,
        offers: [
          { ...offer, meal: { kind: "breakfast", charge: { kind: "room", amountMinor: "1500" } } },
          first.offers[1],
        ],
      },
      {
        ...first,
        offers: [
          {
            ...offer,
            price: {
              kind: "independent",
              calendar: {
                base: { mode: "flat", amountMinor: "11000" },
                months: [],
                seasons: [],
                weekdays: [],
                dates: [],
              },
            },
          },
          first.offers[1],
        ],
      },
    ];
    for (const changed of changes)
      expect(await f.read({ ...f.snapshot, rooms: [changed, f.snapshot.rooms[1]] })).toMatchObject({
        reason: "charges_stale",
      });
    expect(await f.read(f.snapshot, f.context, { ...f.sources, finance: "changed" })).toMatchObject(
      { reason: "finance_source_stale" },
    );
    // Only the declaration's own reference is excluded from the fingerprint.
    expect(
      await f.read(f.snapshot, f.context, { ...f.sources, charges: f.charges.id }),
    ).toMatchObject({ kind: "verified", charges: f.charges });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM platform.outbox_events WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].n,
    ).toBe(4);
  });
  it("rejects missing, forged and stale complete-room sources before charge approval", async () => {
    const f = await fixture();
    for (const sources of [{ finance: f.finance.evidenceId }, { ...f.sources, room: "forged" }])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({
        reason: "room_source_stale",
      });
    const forged = { ...f.sources, room: "forged" };
    await pool.query(
      "UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1",
      [f.scope.propertyId, forged],
    );
    await expect(
      createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
        draftId: f.draftId,
        expectedDraftRevision: 2,
        claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
        declaration: "all_mandatory_charges_included",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "stale" });
    // A matching declaration is still insufficient when its saved source was never authoritative.
    expect(
      await f.read(
        {
          ...f.snapshot,
          ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id },
        },
        f.context,
        forged,
      ),
    ).toMatchObject({ reason: "room_source_stale" });
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'New room')", [
      randomUUID(),
      f.scope.propertyId,
    ]);
    expect(await f.read()).toMatchObject({ reason: "room_source_stale" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "manage")).toBe(
        true,
      );
      const room = await lockPmsReplacementPricingRoomSource(client, f.scope.propertyId);
      expect(
        await verify(client, f.context, f.scope, f.snapshot, { ...f.sources, room: room! }),
      ).toMatchObject({ reason: "charges_stale" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("binds the complete Booking terms set and rejects forged-source confirmation", async () => {
    const f = await fixture(),
      other = await fixture();
    expect(await f.currentTermsSource()).toBe(f.sources.terms);
    expect(await other.currentTermsSource()).not.toBe(f.sources.terms);
    for (const sources of [
      { room: f.sources.room, finance: f.finance.evidenceId },
      { ...f.sources, terms: other.sources.terms },
    ])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({
        reason: "terms_source_stale",
      });
    const forged = { ...f.sources, terms: "forged" };
    await pool.query(
      "UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1",
      [f.scope.propertyId, forged],
    );
    await expect(
      createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
        draftId: f.draftId,
        expectedDraftRevision: 2,
        claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
        declaration: "all_mandatory_charges_included",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(
      await f.read(
        {
          ...f.snapshot,
          ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id },
        },
        f.context,
        forged,
      ),
    ).toMatchObject({ reason: "terms_source_stale" });
    await f.booking.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: null,
      terms: { ...f.termsInput, offerId: "unselected" },
    });
    expect(await f.read()).toMatchObject({ reason: "terms_source_stale" });
    const changed = await f.currentTermsSource();
    expect(changed).not.toBe(f.sources.terms);
    expect(await f.read(f.snapshot, f.context, { ...f.sources, terms: changed })).toMatchObject({
      reason: "charges_stale",
    });
    const updated = await f.booking.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: f.terms[0].revision,
      terms: f.termsInput,
    });
    expect(updated.revision).not.toBe(f.terms[0].revision);
    expect(await f.currentTermsSource()).not.toBe(changed);
  });
  it("holds the complete terms source against new offers through the real Booking writer", async () => {
    const f = await fixture(),
      reader = await pool.connect(),
      writer = new pg.Pool({ connectionString: url, max: 1 });
    const command = {
      requestId: randomUUID(),
      expectedRevision: null,
      terms: { ...f.termsInput, offerId: "concurrent-new" },
    };
    try {
      await writer.query("SET lock_timeout='150ms'");
      await reader.query("BEGIN");
      expect(await verify(reader, f.context, f.scope, f.snapshot, f.sources)).toMatchObject({
        kind: "verified",
      });
      await expect(
        createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command),
      ).rejects.toMatchObject({ code: "55P03" });
      await reader.query("COMMIT");
      await createBookingPricingOfferTermsStore(writer).save(f.context, f.scope, command);
      expect(await f.read()).toMatchObject({ reason: "terms_source_stale" });
    } finally {
      await reader.query("ROLLBACK");
      reader.release();
      await writer.end();
    }
  });
  it("requires independent Finance sources even with matching declaration or readiness evidence", async () => {
    const f = await fixture();
    for (const sources of [
      { room: f.sources.room, terms: f.sources.terms },
      { ...f.sources, finance: f.finance.evidenceId },
    ])
      expect(await f.read(f.snapshot, f.context, sources)).toMatchObject({
        reason: "finance_source_stale",
      });
    const forged = { ...f.sources, finance: "forged" };
    await pool.query(
      "UPDATE pms.pricing_v2_drafts SET source_revisions=$2,draft_revision=2 WHERE property_id=$1",
      [f.scope.propertyId, forged],
    );
    await expect(
      createReplacementChargeDeclarationStore(pool).confirm(f.context, f.scope, {
        draftId: f.draftId,
        expectedDraftRevision: 2,
        claimedFingerprint: replacementChargeFingerprint(f.scope.propertyId, f.snapshot, forged)!,
        declaration: "all_mandatory_charges_included",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(
      await f.read(
        {
          ...f.snapshot,
          ownerReferences: { ...f.snapshot.ownerReferences, charges: f.charges.id },
        },
        f.context,
        forged,
      ),
    ).toMatchObject({ reason: "finance_source_stale" });
    // Tax policy is source state but does not change method capability; readiness alone is insufficient.
    await pool.query(
      "UPDATE finance.payment_settings SET tax_policy='{\"version\":2}'::jsonb WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect(await f.read()).toMatchObject({ reason: "finance_source_stale" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, f.context, f.scope, "manage")).toBe(
        true,
      );
      await lockPmsReplacementPricingRoomSource(client, f.scope.propertyId);
      await lockBookingPricingTermsSource(client, f.scope.propertyId);
      const finance = await lockFinanceReplacementPricingSource(client, f.scope.propertyId);
      expect(
        await verify(client, f.context, f.scope, f.snapshot, { ...f.sources, finance: finance! }),
      ).toMatchObject({ reason: "charges_stale" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  async function publicFixture(
    publish = true,
    configure?: (snapshot: PricingStorageSnapshot) => PricingStorageSnapshot,
    policy?: FixedChargePolicy,
    configureTerms?: TermsSetup,
    enableCard = false,
  ) {
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
        requestId: randomUUID(),
        expectedRevision: null,
        policy,
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
      try {
        await client.query("BEGIN");
        return await lockCurrentPricingPublication(client, scope);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    expect(await readOwner()).toBeNull(); // A draft cannot satisfy publication.
    await f.publishPrices();
    const before = await f.readPublic();
    expect((await readOwner())?.pmsSourceRevision).toBe(before?.pmsSourceRevision);
    await pool.query(
      "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id=$1",
      [f.scope.propertyId],
    );
    await pool.query(
      "UPDATE hotel_catalog.properties SET profile_status='incomplete' WHERE id=$1",
      [f.scope.propertyId],
    );
    expect(await f.readPublic()).toBeNull();
    expect(await readOwner()).toMatchObject({
      publication: { revision: 1, currency: "EUR" },
      terms: before!.terms,
      charges: before!.charges,
    });
    expect(await readOwner({ ...f.scope, organizationId: randomUUID() })).toBeNull();
    expect(await readOwner({ ...f.scope, propertyId: "malformed" })).toBeNull();
    for (const sql of [
      "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
      "DELETE FROM identity.organization_resource_links WHERE organization_id=$1 AND product='pms'",
      "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 second' WHERE organization_id=$1",
    ]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql, [f.scope.organizationId]);
        expect(await lockCurrentPricingPublication(client, f.scope)).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    const external = await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: f.choice.revision,
      authority: "external",
    });
    expect(await readOwner()).toBeNull();
    await f.authority.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: external.revision,
      authority: "vayada",
    });
    expect(await readOwner()).not.toBeNull();
    await pool.query(
      "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
      [f.scope.organizationId],
    );
    expect(await readOwner()).toBeNull();
    await pool.query(
      "UPDATE identity.product_entitlements SET status='active' WHERE organization_id=$1",
      [f.scope.organizationId],
    );
    await pool.query(
      "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
      [f.scope.propertyId],
    );
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
    const mapped = mapReplacementPublicOffers(result!);
    expect(mapped).toHaveLength(2);
    const offers = mapped!.flatMap((room) => room.offers);
    expect(offers).toHaveLength(3);
    expect(new Set(offers.map((offer) => offer.ratePlanId)).size).toBe(3);
    expect(offers.map((offer) => offer.ratePlanId)).toEqual(
      publicPricingOfferBindings(result!).map((binding) => binding.publicOfferKey),
    );
    expect(
      offers.every(
        (offer) =>
          offer.pricing.kind === "quote_required" && offer.pricing.publicationRevision === 1,
      ),
    ).toBe(true);
    expect(
      offers.every(
        (offer) =>
          !Object.hasOwn(offer, "baseNightlyAmount") && !Object.hasOwn(offer, "paymentTiming"),
      ),
    ).toBe(true);
    expect(mapReplacementPublicOffers({ ...result!, terms: [] })).toBeNull();
    expect(
      mapReplacementPublicOffers({ ...result!, terms: [...result!.terms, result!.terms[0]!] }),
    ).toBeNull();
    expect(result?.pmsSourceRevision).toMatch(/^booking\.pms\.publication\.v2:[a-f0-9]{64}$/);
    await pool.query(
      "UPDATE pms.pricing_v2_drafts SET draft_revision=draft_revision+1 WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect((await f.readPublic())?.pmsSourceRevision).toBe(result?.pmsSourceRevision);
    expect(await f.readPublic(randomUUID())).toBeNull();
  });
  it("publishes current database offers through PMS and final Distribution content", async () => {
    const f = await publicFixture(),
      scope = f.scope;
    const single = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const pricing = createReplacementPricingPublicationReader(single);
      const current = await pricing.getCurrentPricingOffers(scope);
      expect(
        await pricing.getCurrentPricingOffers({ ...scope, organizationId: randomUUID() }),
      ).toBeNull();
      expect(await pricing.getCurrentPricingOffers({ ...scope, propertyId: "invalid" })).toBeNull();
      expect(current?.rooms).toHaveLength(2);
      const roomTypeIds = current!.rooms.map((room) => room.roomTypeId);
      const source = {
        ownerDomain: "pms" as const,
        entityType: "pms_operating_calendar.v1",
        entityId: scope.propertyId,
        revision: "calendar:1",
      };
      const roomTemplate = pricingEvidence().roomPublication.rooms[0]!;
      const pms = createPmsBookingPublicationSource({
        pricing,
        rooms: {
          async getRoomPublicationSnapshot() {
            return {
              ...pricingEvidence().roomPublication,
              propertyId: scope.propertyId,
              rooms: roomTypeIds.map((roomTypeId) => ({
                ...roomTemplate,
                propertyId: scope.propertyId,
                roomTypeId,
                facts: {
                  ...roomTemplate.facts,
                  beds: [
                    {
                      type: "king" as (typeof roomTemplate.facts.beds)[number]["type"],
                      quantity: 1,
                    },
                  ],
                },
                media: [
                  {
                    mediaObjectId: randomUUID(),
                    altText: "Suite",
                    sortOrder: 0,
                    publicVariants: [
                      {
                        variantName: "original_safe" as const,
                        publicUrl: "https://cdn.example.test/suite.webp",
                      },
                    ],
                  },
                ],
              })),
            };
          },
        },
        operatingCalendar: {
          async getCurrentOperatingCalendarConfiguration() {
            return {
              sourceStatus: "current",
              configuration: {
                propertyId: scope.propertyId,
                source,
                updatedAt: "2026-06-06T11:00:00.000Z",
                sourceInputs: {
                  propertyTimeZone: "Etc/UTC",
                  propertyProfile: {
                    ownerDomain: "hotel_catalog",
                    entityType: "property_profile",
                    entityId: scope.propertyId,
                    revision: "profile:1",
                  },
                },
              },
            } as any;
          },
          async getOperatingCalendarConfigurationBySource() {
            return null;
          },
        },
        inventory: {
          async getInventoryLaunchReadiness({ requiredCoverage }) {
            return {
              ready: true,
              blockers: [],
              requiredCoverage,
              snapshot: {
                configuration: { source },
                coverage: {
                  coverageFrom: requiredCoverage.from,
                  coverageThrough: requiredCoverage.through,
                  expectedDayCount: 732,
                  materializedDayCount: 732,
                  gaps: [],
                  roomTypeIds,
                },
              },
            } as any;
          },
        },
        now: () => new Date("2026-06-06T11:00:00.000Z"),
      });
      const evidence = await pms.getBookingLaunchEvidence(scope);
      if (evidence.outcome !== "evidence") throw new Error("PMS evidence required");
      expect(evidence.entities.flatMap((entity) => entity.blockers)).toEqual([]);
      const hash = `sha256:${"a".repeat(64)}` as const;
      const request = {
        ...scope,
        sourceManifestHash: hash,
        sourceManifest: {
          contractVersion: "onboarding-source-manifest.v1" as const,
          propertyId: scope.propertyId,
          sources: evidence.sources,
        },
      };
      const snapshot = await pms.getSnapshot(request);
      if (snapshot.outcome !== "snapshot") throw new Error("PMS snapshot required");
      const profile = structuredClone(PUBLIC_BOOKABILITY_FIXTURES[0]!.profile);
      profile.hotel.propertyId = scope.propertyId;
      profile.hotel.slug = scope.propertyId;
      const built = buildBookingPublicContent({
        sourceManifestHash: hash,
        readinessHash: hash,
        profile,
        rooms: snapshot.content.rooms,
        calendar: snapshot.content.calendar,
        finance: {
          defaultCurrency: "EUR",
          supportedCurrencies: ["EUR"],
          onlinePayment: true,
          payAtProperty: true,
          readyPaymentMethods: ["card", "pay_at_property"],
        },
      });
      expect(built).not.toBeNull();
      expect(parseBookingPublicContent(built?.publicContent)).toEqual(built?.publicContent);
      expect(built?.publicContent.rooms.flatMap((room) => room.rates)).toEqual(
        current!.rooms.flatMap((room) => room.offers),
      );
      const catalog = createPublicPricingOfferCatalog(single);
      expect(await catalog.read(scope.propertyId)).toBeNull(); // Approved pricing alone is not published content.
      let revisionNumber = 0;
      const publishContent = async (content: unknown) => {
        const revision = randomUUID();
        await pool.query(
          `INSERT INTO distribution.public_booking_content_revisions
          (id,property_id,revision_number,readiness_contract_version,source_manifest,source_manifest_hash,readiness_hash,readiness_product,readiness_status,public_content,built_by_user_id)
          VALUES($1,$2,$3,'onboarding-product-readiness.v1',$4,$5,$5,'booking','ready',$6,$7)`,
          [
            revision,
            scope.propertyId,
            ++revisionNumber,
            request.sourceManifest,
            hash,
            content,
            scope.actorUserId,
          ],
        );
        await pool.query(
          `INSERT INTO distribution.active_public_booking_revision(property_id,content_revision_id,activated_by_user_id)
          VALUES($1,$2,$3) ON CONFLICT(property_id) DO UPDATE SET content_revision_id=EXCLUDED.content_revision_id`,
          [scope.propertyId, revision, scope.actorUserId],
        );
      };
      await publishContent(built!.publicContent);
      const offers = await catalog.read(scope.propertyId);
      expect(offers?.version).toBe("public-pricing-offers.v1");
      expect(
        offers?.rooms.flatMap((room) => room.offers.map((offer) => offer.publicOfferKey)),
      ).toEqual(current!.rooms.flatMap((room) => room.offers.map((offer) => offer.ratePlanId)));
      expect(offers?.rooms.every((room) => room.name === "Suite" && room.images.length === 1)).toBe(
        true,
      );
      expect(JSON.stringify(offers)).not.toMatch(
        /baseNightlyAmount|termsRevision|publicationRevision|ownerReferences|sourceRevision/,
      );
      expect(await catalog.read(randomUUID())).toBeNull();
      const app = Fastify({ logger: false });
      await app.register(registerBookingWebPublicRoutes, {
        profileRepository: {
          async findProfileBySlug() {
            return null;
          },
        },
        checkoutAdapter: createTargetBookingWebCheckoutAdapter({
          externalChanges: externalBookingChanges,
          connectionString: url!,
          pool: single,
          inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        }),
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: `/hotels/${scope.propertyId}/pricing-offers`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.json()).toEqual(offers);
        expect(
          (await app.inject({ method: "GET", url: `/hotels/${randomUUID()}/pricing-offers` }))
            .statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
      for (const change of [
        (content: NonNullable<typeof built>["publicContent"]) => {
          content.profile.hotel.propertyId = randomUUID();
        },
        (content: NonNullable<typeof built>["publicContent"]) => {
          (content.rooms as unknown[]).pop();
        },
        (content: NonNullable<typeof built>["publicContent"]) => {
          (content.rooms[0]!.rates as unknown[])[0] = {
            ratePlanId: "old",
            currency: "EUR",
            baseNightlyAmount: "100.00",
            refundable: true,
            paymentTiming: "pay_at_property",
          };
        },
      ]) {
        const invalid = structuredClone(built!.publicContent);
        change(invalid);
        await publishContent(invalid);
        expect(await catalog.read(scope.propertyId)).toBeNull();
      }
      await publishContent(built!.publicContent);
      await f.authority.save(f.context, f.scope, {
        requestId: randomUUID(),
        expectedRevision: f.choice.revision,
        authority: "vayada",
      });
      expect(await catalog.read(scope.propertyId)).toBeNull(); // Previously published keys cannot survive a new authority revision.
      await pool.query(
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        [scope.propertyId],
      );
      expect(await pms.getSnapshot(request)).toEqual({ outcome: "unavailable", owner: "pms" });
    } finally {
      await single.end();
    }
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
  async function componentsFixture(
    policy?: FixedChargePolicy,
    configureTerms?: TermsSetup,
    enableCard = false,
  ) {
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
    expect(
      (await f.components({ ...f.selection, promoCode: null, addons: [] }))?.subtotalMinor,
    ).toBe("18000");
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
    await pool.query("UPDATE booking.addon_definitions SET public_visible=false WHERE id=$1", [
      f.id,
    ]);
    expect(await f.components()).toBeNull();
    await pool.query("UPDATE booking.addon_definitions SET public_visible=true WHERE id=$1", [
      f.id,
    ]);
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
    expect(property).toMatchObject({
      totalMinor: "20600",
      dueNowMinor: "0",
      dueLaterMinor: "20600",
    });
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
    expect(record?.calculation.charges.charges[0]).toMatchObject({
      amountMinor: "600",
      quantity: 2,
    });
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
      store.issue(f.scope.propertyId, {
        ...command,
        selection: { ...f.selection, promoCode: null },
      }),
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
  it("issues public HTTP quotes from current stored pricing without exposing private evidence", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms);
    const app = Fastify({ logger: false });
    await app.register(registerBookingWebPublicRoutes, {
      profileRepository: {
        async findProfileBySlug() {
          return null;
        },
      },
      checkoutAdapter: createTargetBookingWebCheckoutAdapter({
        externalChanges: externalBookingChanges,
        connectionString: url!,
        pool,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      }),
    });
    try {
      const path = `/hotels/${f.scope.propertyId}/bookings/quote`;
      const payload = {
        version: "public-booking-quote-request.v1",
        selection: parsePublicPricingSelection(f.selection)!,
        paymentMethod: "pay_at_property",
      } as const;
      const failed = createReplacementBookingQuoteIssuer({
        async issue() {
          throw new Error("private database details");
        },
      });
      await expect(failed(f.scope.propertyId, payload, randomUUID())).rejects.toMatchObject({
        statusCode: 503,
        message: "Quote temporarily unavailable.",
      });
      const headers = { "Idempotency-Key": randomUUID() };
      const post = (body: unknown = payload, key = headers) =>
        app.inject({
          method: "POST",
          url: path,
          headers: key,
          payload: body as Record<string, unknown>,
        });
      const first = await post();
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      const body = first.json();
      expect(parsePublicBookingQuote(body, payload)).toEqual(body);
      expect(body).toMatchObject({
        version: "public-booking-quote.v1",
        acceptanceMode: "instant",
        replayed: false,
        currency: "EUR",
        totalMinor: "20600",
        dueNowMinor: "0",
        dueLaterMinor: "20600",
      });
      expect(body.rooms).toHaveLength(f.selection.rooms.length);
      expect(Object.keys(body).sort()).toEqual(
        [
          "version",
          "quoteId",
          "replayed",
          "checkIn",
          "checkOut",
          "currency",
          "paymentMethod",
          "acceptanceMode",
          "issuedAt",
          "expiresAt",
          "totalMinor",
          "dueNowMinor",
          "dueLaterMinor",
          "lines",
          "rooms",
        ].sort(),
      );
      expect(
        body.rooms.every(
          (room: Record<string, unknown>) =>
            Object.keys(room).sort().join(",") === "cancellation,mealPlan,payment,selectionId",
        ),
      ).toBe(true);
      const stored = await createCurrentPricingQuoteStore(pool, 300).read(
        f.scope.propertyId,
        body.quoteId,
      );
      expect(stored?.quote.evidence.totalMinor).toBe(body.totalMinor);
      const oldQuote = structuredClone(stored!.quote);
      Reflect.deleteProperty(oldQuote, "acceptanceMode");
      const oldIssuer = createReplacementBookingQuoteIssuer({
        async issue() {
          return { ...stored!, quote: oldQuote, replayed: true };
        },
      });
      await expect(oldIssuer(f.scope.propertyId, payload, randomUUID())).rejects.toMatchObject({
        statusCode: 409,
        code: "QUOTE_REFRESH_REQUIRED",
      });
      const refreshApp = Fastify();
      try {
        refreshApp.post("/quote", async () => oldIssuer(f.scope.propertyId, payload, randomUUID()));
        expect((await refreshApp.inject({ method: "POST", url: "/quote" })).json().code).toBe(
          "QUOTE_REFRESH_REQUIRED",
        );
      } finally {
        await refreshApp.close();
      }
      await pool.query(
        "UPDATE booking.booking_settings SET acceptance_mode='request' WHERE property_id=$1",
        [f.scope.propertyId],
      );
      expect((await post(payload, { "Idempotency-Key": randomUUID() })).json().acceptanceMode).toBe(
        "request",
      );
      expect((await post()).json()).toEqual({ ...body, replayed: true });
      expect(
        (await post({ ...payload, selection: { ...f.selection, promoCode: null } })).statusCode,
      ).toBe(409);
      for (const invalid of [
        {},
        { ...payload, propertyId: randomUUID() },
        { ...payload, totalMinor: "1" },
        { ...payload, paymentMethod: "cash" },
        { ...payload, selection: { ...f.selection, rooms: [] } },
      ])
        expect((await post(invalid)).statusCode).toBe(400);
      for (const key of [undefined, "", "a,b", "x".repeat(201)]) {
        const response = await app.inject({
          method: "POST",
          url: path,
          headers: key === undefined ? {} : { "Idempotency-Key": key },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { "Idempotency-Key": ["one", "two"] },
            payload,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { ...headers, "content-type": "application/json" },
            payload: " ".repeat(65537),
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: { ...headers, "content-type": "application/json" },
            payload: "{",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/hotels/${randomUUID()}/bookings/quote`,
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(404);
      await pool.query(
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        [f.scope.propertyId],
      );
      expect((await post(payload, { "Idempotency-Key": randomUUID() })).statusCode).toBe(404);
      await pool.query("UPDATE hotel_catalog.properties SET profile_status='private' WHERE id=$1", [
        f.scope.propertyId,
      ]);
      expect((await post()).statusCode).toBe(404); // Historical retry still needs public authority.
    } finally {
      await app.close();
    }
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
      command = {
        requestId: randomUUID(),
        selection: f.selection,
        paymentMethod: "pay_at_property",
      };
    const first = await store.issue(f.scope.propertyId, command);
    expect(await store.read(other.scope.propertyId, first.quote.quoteId)).toBeNull();
    expect(await store.read(f.scope.propertyId, randomUUID())).toBeNull();
    expect(await store.read(f.scope.propertyId, "bad-id")).toBeNull();
    await pool.query("UPDATE hotel_catalog.properties SET profile_status='private' WHERE id=$1", [
      f.scope.propertyId,
    ]);
    expect(await store.read(f.scope.propertyId, first.quote.quoteId)).toBeNull();
    await expect(store.issue(f.scope.propertyId, command)).rejects.toMatchObject({
      code: "denied",
    });
  });
  it("rejects unavailable or malformed issuance without leaving a stored quote", async () => {
    const f = await componentsFixture(fixedPolicy()),
      store = createCurrentPricingQuoteStore(pool, 300);
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
    await expect(store.issue(f.scope.propertyId, command)).rejects.toMatchObject({
      code: "denied",
    });
    for (const input of [
      { ...command, requestId: " " },
      { ...command, extra: true },
      { ...command, selection: {} },
      { ...command, paymentMethod: "cash" },
    ])
      await expect(store.issue(f.scope.propertyId, input)).rejects.toMatchObject({
        code: "invalid",
      });
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
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
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
  it("freezes acceptance mode through settings edits, replay and revalidation", async () => {
    const f = await componentsFixture(fixedPolicy(), propertyTerms),
      store = createCurrentPricingQuoteStore(pool, 300);
    const command = {
      requestId: randomUUID(),
      selection: f.selection,
      paymentMethod: "pay_at_property",
    };
    const first = await store.issue(f.scope.propertyId, command);
    expect(first.quote.acceptanceMode).toBe("instant");
    await pool.query(
      "UPDATE booking.booking_settings SET acceptance_mode='request' WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect((await store.issue(f.scope.propertyId, command)).quote).toEqual(first.quote);
    expect((await revalidate(f, first.quote.quoteId))?.quote.acceptanceMode).toBe("instant");
    const second = await store.issue(f.scope.propertyId, { ...command, requestId: randomUUID() });
    expect(second.quote.acceptanceMode).toBe("request");
    await pool.query(
      "UPDATE booking.booking_settings SET acceptance_mode='instant' WHERE property_id=$1",
      [f.scope.propertyId],
    );
    expect((await revalidate(f, second.quote.quoteId))?.quote.acceptanceMode).toBe("request");
  });
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
    await pool.query(
      "UPDATE booking.addon_definitions SET name='Changed description' WHERE id=$1",
      [f.id],
    );
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
  it("composes locked promo consumption and same-command replay without invalidating its own usage, then rolls back", async () => {
    const r = await redemptionFixture(false, 1);
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const current = await lockCurrentQuoteRevalidation(
        client,
        r.f.scope.propertyId,
        r.quote.quoteId,
      );
      expect(current).not.toBeNull();
      const first = await redeemLockedCurrentQuotePromo(
        client,
        r.f.scope.propertyId,
        current!,
        r.id,
      );
      expect(first).toMatchObject({ kind: "applied", discountMinor: "2000", replayed: false });
      expect(
        (
          await client.query(
            "SELECT current_uses FROM booking.promo_definitions WHERE property_id=$1",
            [r.f.scope.propertyId],
          )
        ).rows[0].current_uses,
      ).toBe(1);
      // A full re-read now rejects the command's own consumed final use.
      expect(
        await lockCurrentQuoteRevalidation(client, r.f.scope.propertyId, r.quote.quoteId),
      ).toBeNull();
      expect(
        await redeemLockedCurrentQuotePromo(client, r.f.scope.propertyId, current!, r.id),
      ).toEqual({ ...first, replayed: true });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await r.uses()).toBe(0);
    expect(
      (
        await pool.query("SELECT id FROM booking.promo_applications WHERE guest_booking_id=$1", [
          r.id,
        ])
      ).rows,
    ).toEqual([]);
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
      { ...f.policy.choices, childrenEnabled: false, adultAgeThreshold: 9 },
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
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    expect(await read()).toBeNull();
    const store = createBookingGuestChoiceStore(pool, () => ({
      async authorizeGuestPolicyScope(scope) {
        expect(scope).toMatchObject(f.scope);
        return true;
      },
    }));
    const saved = await store.save(f.scope, {
      requestId: randomUUID(),
      expectedRevision: null,
      confirmed: true,
      choices: f.policy.choices,
    });
    const disclosure = await read();
    expect(disclosure!.policy.sourceRevision).toBe(`guest-choices:${saved.revision}`);
    expect(disclosure!.disclosure.choices).toEqual(f.policy.choices);
    expect(disclosure!.quote).toEqual(f.quote);
    expect(
      parseBookingQuoteAcceptanceInput(
        {
          ...f.input,
          acceptance: {
            accepted: true,
            quoteEvidenceId: disclosure!.quoteEvidenceId,
            guestPolicyEvidenceId: disclosure!.guestPolicyEvidenceId,
          },
        },
        disclosure!.quote,
        disclosure!.policy,
      ),
    ).not.toBeNull();
  });
});
