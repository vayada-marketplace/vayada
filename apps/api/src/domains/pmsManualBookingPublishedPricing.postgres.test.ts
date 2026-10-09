import { createHash, randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import {
  composeBookingPricingReadiness,
  createBookingMandatoryChargeConfirmationEvidenceAdapter,
  type ReplacementOfferTerms,
} from "@vayada/domain-booking";
import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBookingPmsManualAttributionOwner } from "./bookingPmsManualAttribution.js";
import { createBookingPmsManualNightlyRevenueEvidenceOwner } from "./bookingPmsManualNightlyRevenueEvidence.js";
import {
  createBookingPricingOfferTermsStore,
  lockBookingPricingTermsSource,
} from "./bookingPricingOfferTerms.js";
import { lockCurrentPricingPublication } from "./currentPricingPublication.js";
import { createFinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import { lockFinanceReplacementPricingReadiness } from "./financeReplacementPricingReadiness.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { createPgPmsManualBookingPlatformOwnerPort } from "./pmsManualBookingCommandEvidence.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import {
  createPgPmsManualBookingBookingOwnerPort,
  createPgPmsManualBookingOperationsOwnerPort,
} from "./pmsManualBookingPersistence.js";
import {
  createManualBookingPricingPublicationReader,
  createPmsManualBookingCurrentPricingEvidence,
  createPmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionalPricing.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { createPgPmsMandatoryChargeConfirmationReadModel } from "./pmsMandatoryChargeConfirmationReadModel.js";
import { loadPmsMandatoryChargePricingSourceSnapshot } from "./pmsMandatoryChargePricingSourceSnapshot.js";
import { createPgPmsPricingReadModel } from "./pmsPricingReadModel.js";
import { createPgPmsRecurringPricingReadModel } from "./pmsRecurringPricingReadModel.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { createPmsRoomAssignmentOptimizationTriggerPort } from "./pmsRoomAssignmentOptimizationTriggers.js";
import {
  createReplacementChargeDeclarationStore,
  replacementChargeFingerprint,
} from "./replacementChargeDeclarations.js";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";
import { createReplacementPricingStorageGuard } from "./replacementPricingStorageGuard.js";
import {
  createReplacementPricingStore,
  type PricingStorageSnapshot,
} from "./replacementPricingStore.js";

const url = process.env["TEST_DATABASE_URL"];

// VAY-1422 slice A: manual bookings price from the active pricing-v2 publication on the
// ordinary target login. The publication is built through the real owner stores, as in
// replacementPricingOfferOwners.integration.test.ts, so the stored rows are not faked.
describe.skipIf(!url)("manual booking priced from the published offers", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const actorUserId = randomUUID(),
    organizationId = randomUUID(),
    propertyId = randomUUID(),
    roomTypeId = randomUUID(),
    roomIds = [randomUUID(), randomUUID()],
    membershipId = randomUUID(),
    flexId = randomUUID(),
    nrId = randomUUID(),
    roleKey = `manual_pricing_${randomUUID()}`,
    scope = { actorUserId, organizationId, propertyId };
  const acceptedAt = new Date("2026-10-07T10:00:00.000Z");

  beforeAll(async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Manual pricing')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Manual pricing',$2)",
      [organizationId, organizationId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name,lifecycle_status,profile_status)
       VALUES($1::uuid,$1::text,'Manual pricing','active','complete')`,
      [propertyId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Etc/UTC')",
      [propertyId],
    );
    await pool.query(
      // As the room-facts flow creates it: no legacy rate and no currency.
      `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits)
       VALUES($1,$2,'Garden room','{"total":2,"adults":2,"children":0}'::jsonb)`,
      [roomTypeId, propertyId],
    );
    await pool.query(
      "INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1,'EUR')",
      [propertyId],
    );
    for (const [index, roomId] of roomIds.entries())
      await pool.query(
        `INSERT INTO pms.rooms(id,property_id,room_type_id,room_number,operational_label_status)
         VALUES($1,$2,$3,$4,'verified')`,
        [roomId, propertyId, roomTypeId, String(101 + index)],
      );
    await pool.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
       VALUES($1,$2,$3,$4,'all','agency')`,
      [membershipId, organizationId, actorUserId, roleKey],
    );
    for (const permission of ["pms.rooms_rates.read", "pms.rooms_rates.manage"])
      await pool.query(
        `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
         VALUES('hotel_group',$1,$2)`,
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
    await pool.query(
      `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
       VALUES($1,true,ARRAY['pay_at_property'],'EUR')`,
      [propertyId],
    );
    await seedInventory();
  });
  afterAll(() => pool.end());

  it("refuses offer stays before publishing and books custom rates in the property currency", async () => {
    const offer = command(flexId);
    await expect(repository().createManualBooking(offer)).rejects.toMatchObject({
      status: 409,
      body: { code: "pricing_not_published" },
    });
    expect(
      (
        await pool.query("SELECT 1 FROM booking.guest_bookings WHERE source_booking_id=$1", [
          offer.commandId,
        ])
      ).rowCount,
    ).toBe(0);

    const custom = command(null, { roomId: roomIds[1]!, checkIn: "2027-02-01" });
    const created = await repository().createManualBooking(custom);
    expect(created).toMatchObject({
      outcome: "created",
      total: { amountDecimal: "150.00", currency: "EUR" },
    });
    const payload = (
      await pool.query(
        "SELECT assignment_payload FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
        [created.guestBookingId],
      )
    ).rows[0].assignment_payload;
    expect(payload.pricingOffer).toBeUndefined();
  });

  it("keeps legacy plans while pricing-v2 has only a draft head", async () => {
    const legacyPropertyId = randomUUID(),
      legacyRoomTypeId = randomUUID(),
      legacyPlanId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO hotel_catalog.properties(id,public_id,display_name)
         VALUES($1::uuid,$1::text,'Legacy pricing')`,
        [legacyPropertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types(id,property_id,name,occupancy_limits)
         VALUES($1,$2,'Legacy room','{"total":2,"adults":2,"children":0}'::jsonb)`,
        [legacyRoomTypeId, legacyPropertyId],
      );
      await client.query(
        "INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1,'EUR')",
        [legacyPropertyId],
      );
      await client.query(
        `INSERT INTO pms.rate_plans(
           id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,active,
           cancellation_policy_snapshot,pricing_contract_version,flexible_rate_plan_revision,
           source_room_facts_revision,source_pricing_currency_revision)
         VALUES($1,$2,$3,'flexible','Flexible','flexible',100,'EUR',TRUE,
           '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":1,
             "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
           'pms-pricing.v1',1,1,1)`,
        [legacyPlanId, legacyPropertyId, legacyRoomTypeId],
      );
      // Saving a pricing-v2 draft creates the head at revision 0; nothing is published yet.
      await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [
        legacyPropertyId,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const pricing = await createPgPmsPricingReadModel({
      connectionString: url!,
      pool,
    }).getPricingSourceSnapshot(legacyPropertyId);
    expect(pricing?.flexibleRatePlans).toEqual([
      expect.objectContaining({ roomTypeId: legacyRoomTypeId, flexibleRatePlanId: legacyPlanId }),
    ]);
    // The setup pricing step keeps the legacy completion rule too.
    expect(
      await createPgPmsPricingReadModel({
        connectionString: url!,
        pool,
      }).listPublishedOfferRoomTypeIds(legacyPropertyId),
    ).toBeNull();
  });

  describe("once published", () => {
    beforeAll(() => publish(ownerContext()));

    it("reads the active publication with its offer terms", async () => {
      const reader = createManualBookingPricingPublicationReader(pool);
      const publication = await reader.readCurrentPricingPublication({ propertyId });
      expect(publication).toMatchObject({ revision: 1, currency: "EUR" });
      expect(publication!.rooms.map((room) => room.offers.map((offer) => offer.id))).toEqual([
        [flexId, nrId],
      ]);
      expect(publication!.terms.map((terms) => terms.offerId).sort()).toEqual(
        [flexId, nrId].sort(),
      );
      expect(await reader.readCurrentPricingPublication({ propertyId: randomUUID() })).toBeNull();
    });

    it("serves the published offers as flexible plans and room-type rate plans", async () => {
      const pricing = createPgPmsPricingReadModel({ connectionString: url!, pool });
      expect(await pricing.listFlexibleRatePlans(propertyId)).toEqual([
        expect.objectContaining({
          roomTypeId,
          flexibleRatePlanId: flexId,
          flexibleRatePlanRevision: 1,
          baseAmount: { amountDecimal: "100.00", currency: "EUR" },
          cancellationTerms: expect.objectContaining({ freeCancellationDeadlineDays: 7 }),
        }),
      ]);
      const operations = createTargetPmsOperationsReadRepository({ connectionString: url!, pool });
      const roomTypes = await operations.listRoomTypesByPropertyId(propertyId);
      expect(
        roomTypes.items[0]!.ratePlans.filter(
          (plan) => plan.pricingContractVersion === "pricing.v2",
        ).map(({ ratePlanId, rateType, baseRate }) => ({ ratePlanId, rateType, baseRate })),
      ).toEqual([
        {
          ratePlanId: flexId,
          rateType: "flexible",
          baseRate: { amountDecimal: "100.00", currency: "EUR" },
        },
        {
          ratePlanId: nrId,
          rateType: "non_refundable",
          baseRate: { amountDecimal: "0", currency: "EUR" },
        },
      ]);
    });

    it("stores the published price and keeps the offer out of the legacy rate-plan column", async () => {
      const created = await repository().createManualBooking(command(nrId));
      // Non-refundable is 10% below the flat 100.00 Flexible price: 90.00 for each of two nights.
      expect(created).toMatchObject({ outcome: "created", total: { amountDecimal: "180.00" } });
      const assignment = (
        await pool.query(
          `SELECT rate_plan_id, assignment_payload FROM pms.operational_booking_assignments
         WHERE guest_booking_id=$1`,
          [created.guestBookingId],
        )
      ).rows[0];
      expect(assignment.rate_plan_id).toBeNull();
      expect(assignment.assignment_payload).toMatchObject({
        contractVersion: "pms-manual-booking.v1",
        pricingOffer: { offerId: nrId, pricingRevision: 1 },
      });
      const nights = (
        await pool.query(
          `SELECT gross_room_amount::numeric(19, 2)::text AS amount FROM booking.nightly_revenue_evidence
         WHERE guest_booking_id=$1 ORDER BY stay_date`,
          [created.guestBookingId],
        )
      ).rows.map((row) => row.amount);
      expect(nights).toEqual(["90.00", "90.00"]);
      // Booking Detail names the plan from the stored offer, as rate_plan_id stays empty.
      const reservation = await createTargetPmsOperationsReadRepository({
        connectionString: url!,
        pool,
      }).findReservationByGuestBookingId(propertyId, created.guestBookingId);
      expect(reservation?.assignments[0]).toMatchObject({ ratePlanId: null, pricingOfferId: nrId });
    });

    it("refuses a save priced from a different publication revision, without writing", async () => {
      const stale = { ...command(nrId, { checkIn: "2027-07-01" }), expectedPricingRevision: 2 };
      await expect(repository().createManualBooking(stale)).rejects.toMatchObject({
        status: 409,
        body: { code: "pricing_changed", field: "expectedPricingRevision" },
      });
      expect(
        (
          await pool.query("SELECT 1 FROM booking.guest_bookings WHERE source_booking_id=$1", [
            stale.commandId,
          ])
        ).rowCount,
      ).toBe(0);
      const current = await repository().createManualBooking({
        ...stale,
        expectedPricingRevision: 1,
      });
      expect(current).toMatchObject({ outcome: "created", total: { amountDecimal: "180.00" } });
    });

    it("books concurrently while previews read the same publication", async () => {
      const reader = createManualBookingPricingPublicationReader(pool);
      // Separate dates: each create re-optimizes room assignments, which may move the other stay.
      const [first, second, preview] = await Promise.all([
        repository().createManualBooking(
          command(flexId, { roomId: roomIds[0]!, checkIn: "2027-05-01" }),
        ),
        repository().createManualBooking(
          command(nrId, { roomId: roomIds[1]!, checkIn: "2027-05-10" }),
        ),
        reader.readCurrentPricingPublication({ propertyId }),
      ]);
      expect([first.total.amountDecimal, second.total.amountDecimal]).toEqual(["200.00", "180.00"]);
      expect(preview?.revision).toBe(1);
    });

    it("lists the room types the publication offers for the setup pricing step", async () => {
      const pricing = createPgPmsPricingReadModel({ connectionString: url!, pool });
      expect(await pricing.listPublishedOfferRoomTypeIds(propertyId)).toEqual([roomTypeId]);
      expect(await pricing.listPublishedOfferRoomTypeIds(randomUUID())).toBeNull();
    });

    // VAY-1943 slice B.2: guest-policy pricing evidence of a property with only pricing-v2 data.
    it("binds the pricing source and mandatory-charge confirmation to the publication", async () => {
      const pricing = await createPgPmsPricingReadModel({
        connectionString: url!,
        pool,
      }).getPricingSourceSnapshot(propertyId);
      expect(pricing?.flexibleRatePlans).toEqual([
        expect.objectContaining({
          roomTypeId,
          flexibleRatePlanId: flexId,
          flexibleRatePlanRevision: 1,
        }),
      ]);
      const recurringPricing = await createPgPmsRecurringPricingReadModel({
        connectionString: url!,
        pool,
      }).getRecurringPricingBookingEvidence(propertyId);
      const source = await loadPmsMandatoryChargePricingSourceSnapshot(
        pool,
        propertyId,
        new Date(),
      );
      expect(source?.sourceRevisions.flexibleRatePlans).toEqual([
        {
          roomTypeId,
          flexibleRatePlanId: flexId,
          flexibleRatePlanRevision: 1,
          sourceRoomFactsRevision: 1,
        },
      ]);
      expect(recurringPricing).toMatchObject({ optionalPricingAggregateRevision: 0, sources: [] });
      // The publication's charge declaration is the final-price confirmation: no legacy write.
      const read = await createPgPmsMandatoryChargeConfirmationReadModel({
        connectionString: url!,
        pool,
      }).getMandatoryChargeConfirmation({ organizationId, propertyId });
      expect(read).toMatchObject({
        outcome: "available",
        evidence: {
          pricingSourceFingerprint: createHash("sha256")
            .update(source!.serializedPayload)
            .digest("hex"),
          confirmationRevision: 1,
        },
      });
      expect(
        await createPgPmsMandatoryChargeConfirmationReadModel({
          connectionString: url!,
          pool,
        }).getMandatoryChargeConfirmation({ organizationId: randomUUID(), propertyId }),
      ).toMatchObject({ outcome: "missing" });
      const confirmation = await createBookingMandatoryChargeConfirmationEvidenceAdapter(
        createPgPmsMandatoryChargeConfirmationReadModel({ connectionString: url!, pool }),
      ).getMandatoryChargeConfirmation({ organizationId, propertyId });

      // The booking-side readiness recomputes the fingerprint from the same owner reads.
      const room = (
        await pool.query("SELECT room_facts_revision FROM pms.room_types WHERE id=$1", [roomTypeId])
      ).rows[0];
      const readiness = composeBookingPricingReadiness(
        { organizationId, propertyId },
        {
          roomPublication: {
            contractVersion: "pms-room-publication.v1",
            propertyId,
            status: "ready",
            blockers: [],
            sourceRevision: "room-publication:1",
            rooms: [
              {
                propertyId,
                roomTypeId,
                activeUnitCount: 2,
                media: [],
                amenities: [],
                sourceRevision: "room:1",
                facts: {
                  name: "Garden room",
                  description: "",
                  category: null,
                  occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
                  beds: [],
                  bedrooms: null,
                  bathrooms: null,
                  bathroomType: "private",
                  size: null,
                },
                sourceRevisions: {
                  roomFactsRevision: Number(room.room_facts_revision),
                  roomUnitsRevision: 1,
                  roomMediaRevision: 1,
                  roomAmenitiesRevision: 1,
                },
              },
            ],
          } as never,
          pricing: pricing!,
          recurringPricing: recurringPricing!,
        },
        confirmation,
        null,
      );
      expect(readiness.flexibleRates).toEqual([
        expect.objectContaining({ roomTypeId, status: "ready" }),
      ]);
      expect(readiness.mandatoryChargeConfirmation).toMatchObject({ status: "current" });
      expect(readiness.blockers.map(({ code }) => code)).not.toEqual(
        expect.arrayContaining(["flexible_rate_plan_missing"]),
      );
    });

    it("keeps front-desk pricing when the booking engine is switched off", async () => {
      await pool.query(
        "UPDATE finance.payment_settings SET payments_enabled=false WHERE property_id=$1",
        [propertyId],
      );
      // The booking engine's owner read now refuses the property...
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        expect(
          await lockCurrentPricingPublication(client, { propertyId, organizationId }),
        ).toBeNull();
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      // ...while staff bookings still price from the publication.
      const created = await repository().createManualBooking(
        command(flexId, { roomId: roomIds[1]!, checkIn: "2027-06-01" }),
      );
      expect(created.total.amountDecimal).toBe("200.00");
    });
  });

  function ownerContext(): RequestContext {
    return {
      actor: {
        internalUserId: actorUserId,
        email: "manual-pricing@example.test",
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
  }

  /** Terms, owner sources and charge declaration through their real stores, then publish. */
  async function publish(context: RequestContext) {
    const terms: ReplacementOfferTerms[] = [];
    const flexible = {
      type: "free_until_days_before_arrival" as const,
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount" as const,
      noShowPenalty: "full_booking_amount" as const,
    };
    for (const [offerId, cancellation] of [
      [flexId, { kind: "flexible" as const, terms: flexible }],
      [nrId, { kind: "non_refundable" as const }],
    ] as const)
      terms.push(
        await createBookingPricingOfferTermsStore(pool).save(context, scope, {
          requestId: randomUUID(),
          expectedRevision: null,
          terms: { roomTypeId, offerId, cancellation, payment: { kind: "full" } },
        }),
      );
    const client = await pool.connect();
    let room, termsSource, financeSource, finance;
    try {
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(
        true,
      );
      room = await lockPmsReplacementPricingRoomSource(client, propertyId);
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
    if (finance.kind !== "ready" || !room || !termsSource || !financeSource)
      throw new Error("fixture requires owner evidence");
    const rules = {
      minArrivalNights: 1,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      stopSell: false,
    };
    const meal = {
      kind: "room_only" as const,
      charge: { kind: "room" as const, amountMinor: "0" },
    };
    const flex = terms.find((t) => t.offerId === flexId)!,
      nr = terms.find((t) => t.offerId === nrId)!;
    const snapshot: PricingStorageSnapshot = {
      currency: "EUR",
      ownerReferences: { finance: finance.evidenceId },
      rooms: [
        {
          version: "pricing.v2",
          propertyId,
          roomTypeId,
          revision: 1,
          currency: "EUR",
          capacity: { total: 2, adults: 2, children: 0 },
          children: {
            adultFromAge: 12,
            bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
          },
          offers: [
            {
              id: flexId,
              termsRevision: flex.revision,
              meal,
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
              restrictions: { kind: "own", rules, seasons: [], dates: [] },
            },
            {
              id: nrId,
              termsRevision: nr.revision,
              meal,
              price: {
                kind: "linked",
                parentId: flexId,
                adjustment: { kind: "percentage", basisPoints: -1000 },
                dateOverrides: [],
              },
              restrictions: { kind: "inherit" },
            },
          ],
        },
      ],
    };
    const sources = { room, terms: termsSource, finance: financeSource },
      draftId = randomUUID();
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
    await createReplacementPricingStore(pool, createReplacementPricingStorageGuard(context)).save(
      scope,
      {
        requestId: randomUUID(),
        expectedRevision: 0,
        sources,
        snapshot: {
          ...snapshot,
          ownerReferences: { ...snapshot.ownerReferences, charges: charges.id },
        },
      },
    );
  }

  async function seedInventory() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `WITH revision AS (
           INSERT INTO pms.operating_calendar_revisions (organization_id,property_id,calendar_revision,contract_version,
             property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,
             default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
           VALUES ($2,$1,1,'pms-operating-calendar.v1',1,'Etc/UTC','year_round',0,1,1,gen_random_uuid(),gen_random_uuid(),
             gen_random_uuid(),$4,now(),now())
           RETURNING property_id,calendar_revision),
         binding AS (
           INSERT INTO pms.operating_calendar_room_bindings (property_id,calendar_revision,room_type_id,source_room_facts_revision,
             source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
           SELECT property_id,calendar_revision,$3,1,1,2,2 FROM revision)
         INSERT INTO pms.inventory_days (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
           inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,
           channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
         SELECT $1::uuid,$3::uuid,day,2,2,1,1,2,2,1,0,0,0,0
         FROM generate_series('2027-01-01'::date,'2027-12-31','1 day') day`,
        [propertyId, organizationId, roomTypeId, actorUserId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function repository() {
    return createPgPmsManualBookingCommandRepository({
      connectionString: url!,
      pool,
      now: () => acceptedAt,
      dependencies: {
        booking: createPgPmsManualBookingBookingOwnerPort(),
        operations: createPgPmsManualBookingOperationsOwnerPort(),
        platform: createPgPmsManualBookingPlatformOwnerPort(),
        pricing: createPmsManualBookingTransactionalPricingPort(
          createPmsManualBookingCurrentPricingEvidence(),
        ),
        financeSettlement: createFinanceManualBookingSettlementPort(),
        attribution: createBookingPmsManualAttributionOwner(),
        nightlyEvidence: createBookingPmsManualNightlyRevenueEvidenceOwner(),
        roomAssignmentOptimization: createPmsRoomAssignmentOptimizationTriggerPort(),
      },
    });
  }

  function command(
    offerId: string | null,
    stay: { roomId?: string; checkIn?: string } = {},
  ): PmsManualBookingCreateCommand {
    const suffix = randomUUID();
    const checkIn = stay.checkIn ?? "2027-03-01";
    const checkOut = new Date(Date.parse(`${checkIn}T00:00:00Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      contractVersion: "pms-manual-booking.v1",
      commandId: `command-${suffix}`,
      idempotencyKey: `key-${suffix}`,
      propertyId,
      organizationId,
      guest: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.test",
        phoneE164: null,
        countryCode: null,
        specialRequests: null,
      },
      privateNote: null,
      directSource: "email",
      stays: [
        {
          position: 1,
          roomId: stay.roomId ?? roomIds[0]!,
          checkIn,
          checkOut,
          adults: 2,
          children: 0,
          ...(offerId === null
            ? {
                ratePlanId: null,
                pricing: {
                  kind: "custom" as const,
                  nightlyAmount: { amountDecimal: "75.00", currency: "EUR" },
                },
              }
            : {
                ratePlanId: offerId,
                pricing: { kind: "rate_plan" as const, manualOverride: null },
              }),
        },
      ],
      addOns: [],
      payment: { expectedMethod: "pay_at_property", settlement: { status: "unpaid" } },
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: `request-${suffix}`,
        correlationId: null,
        requestedAt: acceptedAt.toISOString(),
      },
    };
  }
});
