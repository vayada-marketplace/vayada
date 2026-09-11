import Fastify from "fastify";
import { readBookingAffiliateProbeEvidence } from "../domains/bookingAffiliateProbeEvidence.js";
import { chromium } from "@playwright/test";
import { context as hotelContext } from "../domains/affiliatePublicationTestFixture.js";
import { manageAffiliateValidationProbe } from "../domains/bookingAffiliateValidationProbe.js";
import type { AffiliateProbeCheckout } from "../domains/bookingAffiliateProbeBinding.js";
import { readBookingAffiliateCreationEvidence } from "../domains/bookingAffiliateCreationEvidence.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";
import {
  createTargetBookingWebCheckoutAdapter,
  registerBookingWebPublicRoutes,
  resolveTargetCheckoutProperty,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `11880000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = uuid(1);
const roomTypeId = uuid(2);
const successfulQuoteId = uuid(3);
const rollbackQuoteId = uuid(4);
const addonId = uuid(5);
const missingAddonId = uuid(6);
const occurredAt = new Date("2027-01-01T10:00:00.000Z");
const completedReservationQuoteIds = new Set<string>();
let validation: AffiliateProbeCheckout;
const freshProbeContext = async () => ({
  ...hotelContext(),
  actor: { ...hotelContext().actor, internalUserId: propertyId },
  selectedOrganization: { ...hotelContext().selectedOrganization, organizationId: propertyId },
  linkedResources: [
    {
      product: "marketplace" as const,
      resourceType: "hotel_profile" as const,
      resourceId: propertyId,
      status: "active" as const,
      relationship: "owner" as const,
    },
  ],
});

describe.skipIf(!TEST_DATABASE_URL)(
  "Booking Web canonical attribution PostgreSQL persistence",
  () => {
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
    const checkoutPool = new pg.Pool({
      connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
      max: 1,
    });

    beforeAll(async () => {
      const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
      if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
        throw new Error("Unsafe test database");
      }
      completedReservationQuoteIds.clear();
      await cleanup();
      await seedProperty();
      await admin.query(
        "INSERT INTO identity.users(id,email) VALUES($1,'probe-binding@example.invalid')",
        [propertyId],
      );
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Probe binding test','probe-binding-test')",
        [propertyId],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship) VALUES($1::uuid,'marketplace','hotel_profile',$1::uuid::text,'owner')",
        [propertyId],
      );
      await admin.query(
        "INSERT INTO booking.affiliate_destination_versions(id,property_id,display_name,booking_url,created_by_user_id,created_by_organization_id,request_id) VALUES($2,$1,'Probe test','https://example.invalid',$1,$1,'probe-seed')",
        [propertyId, uuid(9)],
      );
      const deployment = {
        environment: "local" as const,
        connectionReference: "binding-test",
        adapterVersion: "native-v1",
      };
      const probe = await manageAffiliateValidationProbe(
        admin,
        {
          context: await freshProbeContext(),
          propertyId,
          destinationVersionId: uuid(9),
          action: "create",
          idempotencyKey: "binding-probe",
          lifetimeSeconds: 3600,
        },
        deployment,
      );
      if (!probe.ok || !("probe" in probe)) throw new Error("Probe fixture creation failed");
      validation = {
        ...deployment,
        probe: probe.probe,
        destinationVersionId: uuid(9),
        freshContext: freshProbeContext,
      };
      await seedQuote(successfulQuoteId, "VAY-1188-SUCCESS", addonId);
      await seedQuote(rollbackQuoteId, "VAY-1188-ROLLBACK", missingAddonId);
      await admin.query(
        "INSERT INTO booking.affiliate_validation_quote_bindings(quote_id,property_id,probe_id,request_id) SELECT id,property_id,$2,'fixture' FROM booking.quote_sessions WHERE property_id=$1",
        [propertyId, validation.probe.slice(4)],
      );
    });

    afterAll(async () => {
      await cleanup();
      await checkoutPool.end();
      await admin.end();
    });

    it("owns canonical attribution across creation, replay, and rollback", async () => {
      const adapter = createAdapter(checkoutPool, validation);
      const context = command("success");
      const request = {
        ...checkoutRequest("VAY-1188-SUCCESS"),
        referralCode: "guest-forged-probe",
      };

      // Hold the first checkout after its initial property lock; the second must
      // wait there, not obtain SHARE and later deadlock upgrading both transactions.
      let releaseFirst!: () => void, enteredFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enteredFirst = resolve;
      });
      const secondPool = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
      const secondPid = (await secondPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const held = createAdapter(checkoutPool, {
        ...validation,
        freshContext: async () => {
          enteredFirst();
          await gate;
          return freshProbeContext();
        },
      });
      const firstBooking = held.createBooking("vay-1188-hotel", request, context);
      await entered;
      const secondBooking = createAdapter(secondPool, validation).createBooking(
        "vay-1188-hotel",
        request,
        context,
      );
      let created: unknown;
      try {
        await waitForLockWaiter(admin, secondPid);
        releaseFirst();
        const results = await Promise.all([firstBooking, secondBooking]);
        expect(results[1]).toEqual(results[0]);
        created = results[0];
      } finally {
        releaseFirst();
        await Promise.allSettled([firstBooking, secondBooking]);
        await secondPool.end();
      }
      await expect(adapter.createBooking("vay-1188-hotel", request, context)).resolves.toEqual(
        created,
      );
      const booking = (
        await admin.query(
          "SELECT id FROM booking.guest_bookings WHERE property_id=$1 AND quote_session_id=$2",
          [propertyId, successfulQuoteId],
        )
      ).rows[0];
      const originalBinding = (
        await admin.query(
          "SELECT * FROM booking.affiliate_validation_booking_bindings WHERE booking_id=$1",
          [booking.id],
        )
      ).rows;
      expect(originalBinding).toHaveLength(1);
      expect(originalBinding[0]).toMatchObject({
        property_id: propertyId,
        probe_id: validation.probe.slice(4),
        request_id: context.requestId,
      });
      const originalCharge = (
        await admin.query("SELECT * FROM booking.original_charge_snapshots WHERE booking_id=$1", [
          booking.id,
        ])
      ).rows;
      expect(originalCharge).toHaveLength(1);
      expect(originalCharge[0]).toMatchObject({
        quote_id: successfulQuoteId,
        property_id: propertyId,
        classification_status: "unclassified",
        contract_version: "native-checkout-charge.v1",
        request_id: context.requestId,
      });
      const sourceQuote = (
        await admin.query(
          "SELECT totals,selected_offer_snapshot FROM booking.quote_sessions WHERE id=$1",
          [successfulQuoteId],
        )
      ).rows[0];
      expect(originalCharge[0].totals).toEqual(sourceQuote.totals);
      expect(originalCharge[0].selected_offer).toEqual(sourceQuote.selected_offer_snapshot);
      for (const sql of [
        "UPDATE booking.original_charge_snapshots SET totals='{}' WHERE booking_id=$1",
        "DELETE FROM booking.original_charge_snapshots WHERE booking_id=$1",
      ])
        await expect(admin.query(sql, [booking.id])).rejects.toThrow();
      const denied = createAdapter(checkoutPool, {
        ...validation,
        freshContext: async () => ({ ...(await freshProbeContext()), entitlements: [] }),
      });
      await expect(denied.createBooking("vay-1188-hotel", request, context)).rejects.toThrow();
      const wrong = createAdapter(checkoutPool, { ...validation, adapterVersion: "changed" });
      await expect(wrong.createBooking("vay-1188-hotel", request, context)).rejects.toThrow(
        "Validation probe is unavailable",
      );
      const evidenceInput = { propertyId, bookingId: booking.id };
      const creationEvidence = await readBookingAffiliateCreationEvidence(
        admin,
        evidenceInput,
        occurredAt,
      );
      expect(creationEvidence).toMatchObject({
        status: "recorded",
        propertyId,
        bookingId: booking.id,
        originalBookedAt: occurredAt.toISOString(),
        requestId: context.requestId,
        correlationId: context.correlationId,
      });
      await expect(
        readBookingAffiliateCreationEvidence(
          admin,
          { ...evidenceInput, propertyId: uuid(999) },
          occurredAt,
        ),
      ).resolves.toMatchObject({ reason: "scope_unavailable" });
      const probeEvidence = await readBookingAffiliateProbeEvidence(
        admin,
        evidenceInput,
        validation,
        occurredAt,
      );
      expect(probeEvidence).toMatchObject({
        ...creationEvidence,
        purpose: "validation",
        probeId: validation.probe.slice(4),
        environment: "local",
        destinationVersionId: uuid(9),
        connectionReference: "binding-test",
      });
      await expect(
        readBookingAffiliateProbeEvidence(
          admin,
          { propertyId, bookingId: uuid(999) },
          validation,
          occurredAt,
        ),
      ).resolves.toMatchObject({ status: "pending", reason: "scope_unavailable" });
      await expect(
        readBookingAffiliateProbeEvidence(
          admin,
          evidenceInput,
          {
            ...validation,
            freshContext: async () => ({ ...(await freshProbeContext()), entitlements: [] }),
          },
          occurredAt,
        ),
      ).rejects.toThrow();
      await expect(
        readBookingAffiliateProbeEvidence(
          admin,
          evidenceInput,
          {
            ...validation,
            connectionReference: "other-connection",
          },
          occurredAt,
        ),
      ).rejects.toThrow("Validation probe is unavailable");
      // Committed synthetic edits let the owning read exercise its own snapshot.
      try {
        await admin.query(
          "UPDATE booking.booking_status_events SET event_payload=jsonb_set(event_payload,'{requestId}',to_jsonb('conflicting-request'::text)) WHERE id=$1",
          [creationEvidence.status === "recorded" ? creationEvidence.creationEventId : null],
        );
        await expect(
          readBookingAffiliateProbeEvidence(admin, evidenceInput, validation, occurredAt),
        ).resolves.toEqual({ status: "needs_review", reason: "conflicting_probe_binding" });
      } finally {
        await admin.query(
          "UPDATE booking.booking_status_events SET event_payload=jsonb_set(event_payload,'{requestId}',to_jsonb($2::text)) WHERE id=$1",
          [
            creationEvidence.status === "recorded" ? creationEvidence.creationEventId : null,
            context.requestId,
          ],
        );
      }
      try {
        await admin.query("UPDATE booking.guest_bookings SET quote_session_id=$2 WHERE id=$1", [
          booking.id,
          rollbackQuoteId,
        ]);
        await expect(
          readBookingAffiliateProbeEvidence(admin, evidenceInput, validation, occurredAt),
        ).resolves.toEqual(probeEvidence);
      } finally {
        await admin.query("UPDATE booking.guest_bookings SET quote_session_id=$2 WHERE id=$1", [
          booking.id,
          successfulQuoteId,
        ]);
      }
      // Exercise real persisted creation rows; roll back every negative fixture variation.
      const evidenceClient = await admin.connect();
      try {
        for (const [sql, reason] of [
          [
            "UPDATE booking.guest_bookings SET source_system='migration',source_booking_id='test-import' WHERE id=$1",
            "unsupported_source",
          ],
          [
            "UPDATE booking.guest_bookings SET created_at=created_at+interval '1 microsecond' WHERE id=$1",
            "conflicting_creation_evidence",
          ],
          [
            "DELETE FROM booking.booking_status_events WHERE guest_booking_id=$1 AND event_type='guest_booking.created'",
            "creation_evidence_missing",
          ],
          [
            "INSERT INTO booking.booking_status_events(guest_booking_id,event_type,actor_type,event_payload,occurred_at) SELECT guest_booking_id,event_type,actor_type,event_payload,occurred_at FROM booking.booking_status_events WHERE guest_booking_id=$1 AND event_type='guest_booking.created'",
            "conflicting_creation_evidence",
          ],
        ]) {
          await evidenceClient.query("BEGIN");
          await evidenceClient.query(sql!, [booking.id]);
          await expect(
            readBookingAffiliateCreationEvidence(evidenceClient, evidenceInput, occurredAt),
          ).resolves.toMatchObject({ reason });
          await evidenceClient.query("ROLLBACK");
        }
        await evidenceClient.query("BEGIN");
        await evidenceClient.query(
          "UPDATE booking.guest_bookings SET updated_at=updated_at+interval '1 day',quote_session_id='11880000-0000-4000-8000-000000000004' WHERE id=$1",
          [booking.id],
        );
        await expect(
          readBookingAffiliateCreationEvidence(evidenceClient, evidenceInput, occurredAt),
        ).resolves.toEqual(creationEvidence);
        expect(
          (
            await evidenceClient.query(
              "SELECT * FROM booking.original_charge_snapshots WHERE booking_id=$1",
              [booking.id],
            )
          ).rows,
        ).toEqual(originalCharge);
        expect(
          (
            await evidenceClient.query(
              "SELECT * FROM booking.affiliate_validation_booking_bindings WHERE booking_id=$1",
              [booking.id],
            )
          ).rows,
        ).toEqual(originalBinding);
        await evidenceClient.query("ROLLBACK");
        await expect(
          admin.query(
            "UPDATE booking.affiliate_validation_booking_bindings SET request_id='changed' WHERE booking_id=$1",
            [booking.id],
          ),
        ).rejects.toThrow();
      } finally {
        await evidenceClient.query("ROLLBACK").catch(() => undefined);
        evidenceClient.release();
      }
      await admin.query(
        `UPDATE booking.addon_definitions
            SET price_amount = 99, ownership_kind = 'property', partner_commission_rate = NULL
          WHERE id = $1::uuid`,
        [addonId],
      );

      const persisted = await admin.query<{
        bookingChannel: string;
        directBookingSource: string;
        sourceSystem: string;
        totalAmount: string;
        bookingCount: number;
        addonCount: number;
        addonGrossAmount: string;
        addonOwnership: string;
        addonCommissionMatches: boolean;
      }>(
        `SELECT
         min(booking_channel) AS "bookingChannel",
         min(direct_booking_source) AS "directBookingSource",
         min(source_system) AS "sourceSystem",
         min(total_amount)::text AS "totalAmount",
         count(DISTINCT booking.id)::int AS "bookingCount",
         count(evidence.selection_id)::int AS "addonCount",
         min(evidence.gross_amount)::text AS "addonGrossAmount",
         min(evidence.ownership_kind) AS "addonOwnership",
         bool_and(evidence.partner_commission_rate = 18.75) AS "addonCommissionMatches"
       FROM booking.guest_bookings booking
       LEFT JOIN booking.finance_addon_purchase_evidence evidence
         ON evidence.guest_booking_id = booking.id
       WHERE booking.property_id = $1::uuid AND booking.quote_session_id = $2::uuid`,
        [propertyId, successfulQuoteId],
      );
      expect(persisted.rows[0]).toEqual({
        bookingChannel: "direct",
        directBookingSource: "booking_engine",
        sourceSystem: "booking",
        totalAmount: "220.50",
        bookingCount: 1,
        addonCount: 1,
        addonGrossAmount: "20.50",
        addonOwnership: "partner",
        addonCommissionMatches: true,
      });
      const selection = await admin.query<{
        addonDefinitionId: string;
        addonSnapshot: Record<string, unknown>;
        quantity: number;
        serviceDate: string;
      }>(
        `SELECT addon_definition_id::text AS "addonDefinitionId",
                addon_snapshot AS "addonSnapshot", quantity,
                service_date::text AS "serviceDate"
           FROM booking.booking_addon_selections
          WHERE guest_booking_id = (
            SELECT id FROM booking.guest_bookings
             WHERE property_id = $1::uuid AND quote_session_id = $2::uuid
          )`,
        [propertyId, successfulQuoteId],
      );
      expect(selection.rows).toMatchObject([
        {
          addonDefinitionId: addonId,
          addonSnapshot: { name: "Partner spa", unitAmount: "10.25", pricingModel: "per_guest" },
          quantity: 2,
          serviceDate: "2027-02-01",
        },
      ]);

      await expect(
        adapter.createBooking(
          "vay-1188-hotel",
          checkoutRequest("VAY-1188-ROLLBACK"),
          command("rollback"),
        ),
      ).rejects.toMatchObject({ constraint: "fk_booking_addon_selections_definition_property" });
      expect(completedReservationQuoteIds).toContain(rollbackQuoteId);

      const rolledBack = await admin.query<{
        bookingCount: number;
        checkoutCount: number;
        addonCount: number;
        quoteStatus: string;
        idempotencyCount: number;
        inventoryAvailable: number;
        inventoryAssigned: number;
        publicAvailable: number;
      }>(
        `SELECT
         (SELECT count(*)::int FROM booking.guest_bookings
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "bookingCount",
         (SELECT count(*)::int FROM booking.checkout_contexts
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "checkoutCount",
         (SELECT count(*)::int FROM booking.booking_addon_selections
           WHERE property_id = $1::uuid AND addon_definition_id = $3::uuid) AS "addonCount",
         (SELECT status FROM booking.quote_sessions WHERE id = $2::uuid) AS "quoteStatus",
         (SELECT count(*)::int FROM platform.idempotency_keys
           WHERE property_id = $1::uuid
             AND correlation_id = 'vay-1188-rollback-correlation') AS "idempotencyCount",
         (SELECT min(available_count)::int FROM pms.inventory_days
           WHERE property_id = $1::uuid) AS "inventoryAvailable",
         (SELECT min(assigned_count)::int FROM pms.inventory_days
           WHERE property_id = $1::uuid) AS "inventoryAssigned",
         (SELECT min(available_rooms)::int FROM distribution.public_room_offer_snapshots
           WHERE property_id = $1::uuid) AS "publicAvailable"`,
        [propertyId, rollbackQuoteId, missingAddonId],
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM booking.original_charge_snapshots WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(rolledBack.rows[0]).toMatchObject({
        bookingCount: 0,
        checkoutCount: 0,
        addonCount: 0,
        quoteStatus: "active",
        idempotencyCount: 0,
        inventoryAvailable: 1,
        inventoryAssigned: 1,
        publicAvailable: 1,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM booking.affiliate_validation_booking_bindings WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0].n,
      ).toBe(1);
      const another = await manageAffiliateValidationProbe(
        admin,
        {
          context: await freshProbeContext(),
          propertyId,
          destinationVersionId: uuid(9),
          action: "create",
          idempotencyKey: "other-probe",
          lifetimeSeconds: 3600,
        },
        validation,
      );
      if (!another.ok || !("probe" in another)) throw new Error("Second probe fixture failed");
      await expect(
        readBookingAffiliateProbeEvidence(
          admin,
          evidenceInput,
          { ...validation, probe: another.probe },
          occurredAt,
        ),
      ).resolves.toEqual({ status: "pending", reason: "probe_binding_missing" });
      const swapped = createAdapter(checkoutPool, { ...validation, probe: another.probe });
      await expect(
        swapped.createBooking(
          "vay-1188-hotel",
          { ...request, validationProbe: another.probe },
          context,
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      const revoker = await admin.connect();
      const readerPid = (await checkoutPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let rejectionCheck: Promise<unknown> | undefined;
      try {
        await revoker.query("BEGIN");
        await revoker.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
          propertyId,
        ]);
        await revoker.query(
          `INSERT INTO booking.affiliate_validation_probe_revocations
          (probe_id,actor_id,organization_id,request_id) VALUES($1,$2,$2,'concurrent-revocation')`,
          [validation.probe.slice(4), propertyId],
        );
        const waitingRead = readBookingAffiliateProbeEvidence(
          checkoutPool,
          evidenceInput,
          validation,
          occurredAt,
        );
        // Attach the rejection assertion before releasing the blocked read.
        rejectionCheck = expect(waitingRead).rejects.toThrow("Validation probe is unavailable");
        await waitForLockWaiter(admin, readerPid);
        await revoker.query("COMMIT");
        await rejectionCheck;
      } finally {
        await revoker.query("ROLLBACK").catch(() => undefined);
        revoker.release();
        await rejectionCheck?.catch(() => undefined);
      }
      await expect(adapter.createBooking("vay-1188-hotel", request, context)).rejects.toThrow(
        "Validation probe is unavailable",
      );
      await expect(
        readBookingAffiliateProbeEvidence(admin, evidenceInput, validation, occurredAt),
      ).rejects.toThrow("Validation probe is unavailable");
    });

    it("reads the committed same-day policy after waiting for its property lock", async () => {
      await admin.query(
        `INSERT INTO booking.same_day_booking_policies
           (property_id, enabled, cutoff_local_time)
         VALUES ($1::uuid, TRUE, '18:00')
         ON CONFLICT (property_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, cutoff_local_time = EXCLUDED.cutoff_local_time`,
        [propertyId],
      );
      const settings = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      const checkout = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      await settings.connect();
      await checkout.connect();
      try {
        await settings.query("BEGIN");
        await settings.query(
          `SELECT property.id FROM hotel_catalog.properties property
           WHERE property.id = $1::uuid FOR UPDATE OF property`,
          [propertyId],
        );
        await settings.query(
          `UPDATE booking.same_day_booking_policies SET enabled = FALSE
           WHERE property_id = $1::uuid`,
          [propertyId],
        );

        await checkout.query("BEGIN");
        const pid = await backendPid(checkout);
        const propertyRead = resolveTargetCheckoutProperty(
          checkout as never,
          "vay-1188-hotel",
          true,
        );
        await waitForLockWaiter(admin, pid);
        await settings.query("COMMIT");

        await expect(propertyRead).resolves.toMatchObject({ sameDayBookingsEnabled: false });
        await checkout.query("COMMIT");
      } finally {
        await settings.query("ROLLBACK").catch(() => undefined);
        await checkout.query("ROLLBACK").catch(() => undefined);
        await settings.end();
        await checkout.end();
      }
    });

    it("reauthorizes quote retries and rolls back a failure after binding", async () => {
      const issued = await manageAffiliateValidationProbe(
        admin,
        {
          context: await freshProbeContext(),
          propertyId,
          destinationVersionId: uuid(9),
          action: "create",
          idempotencyKey: "quote-failure-probe",
          lifetimeSeconds: 3600,
        },
        validation,
      );
      if (!issued.ok || !("probe" in issued)) throw new Error("Quote failure probe fixture failed");
      const selected = { ...validation, probe: issued.probe };
      const adapter = createAdapter(checkoutPool, selected);
      const request = { ...checkoutRequest("unused"), roomTypeId, validationProbe: issued.probe };
      const context = { ...command("quote-authorization"), operation: "booking-quote" as const };
      const quoted = await adapter.quoteBooking("vay-1188-hotel", request, context);
      await expect(adapter.quoteBooking("vay-1188-hotel", request, context)).resolves.toEqual(
        quoted,
      );
      await expect(
        createAdapter(checkoutPool, {
          ...selected,
          freshContext: async () => ({ ...(await freshProbeContext()), entitlements: [] }),
        }).quoteBooking("vay-1188-hotel", request, context),
      ).rejects.toThrow();
      await expect(
        createAdapter(checkoutPool, {
          ...selected,
          adapterVersion: "changed",
        }).quoteBooking("vay-1188-hotel", request, context),
      ).rejects.toThrow("Validation probe is unavailable");

      const counts = async () =>
        (
          await admin.query(
            `SELECT
        (SELECT count(*)::int FROM booking.quote_sessions WHERE property_id=$1) AS quotes,
        (SELECT count(*)::int FROM booking.affiliate_validation_quote_bindings WHERE property_id=$1) AS bindings,
        (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS retries`,
            [propertyId],
          )
        ).rows[0];
      const before = await counts();
      // Fault injection runs AFTER the real binding insert, inside the quote transaction.
      await admin.query(`CREATE FUNCTION booking.test_quote_binding_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.property_id='${propertyId}'::uuid AND NEW.request_id='vay-1188-quote-rollback' THEN
            RAISE EXCEPTION 'injected failure after quote binding';
          END IF;
          RETURN NEW;
        END $$`);
      try {
        await admin.query(`CREATE TRIGGER test_quote_binding_failure AFTER INSERT
          ON booking.affiliate_validation_quote_bindings FOR EACH ROW
          EXECUTE FUNCTION booking.test_quote_binding_failure()`);
        await expect(
          adapter.quoteBooking("vay-1188-hotel", request, {
            ...command("quote-rollback"),
            occurredAt: new Date(occurredAt.getTime() + 1000),
            operation: "booking-quote",
          }),
        ).rejects.toThrow("injected failure after quote binding");
        expect(await counts()).toEqual(before);
      } finally {
        await admin.query(
          "DROP TRIGGER IF EXISTS test_quote_binding_failure ON booking.affiliate_validation_quote_bindings",
        );
        await admin.query("DROP FUNCTION booking.test_quote_binding_failure()");
      }
      const recovered = await adapter.quoteBooking("vay-1188-hotel", request, {
        ...command("quote-rollback"),
        occurredAt: new Date(occurredAt.getTime() + 1000),
        operation: "booking-quote",
      });
      expect(recovered).toHaveProperty("quoteId");
      expect(await counts()).toEqual({
        quotes: before.quotes + 1,
        bindings: before.bindings + 1,
        retries: before.retries + 1,
      });
      await manageAffiliateValidationProbe(
        admin,
        {
          context: await freshProbeContext(),
          propertyId,
          destinationVersionId: uuid(9),
          action: "revoke",
          probe: issued.probe,
        },
        validation,
      );
      await expect(adapter.quoteBooking("vay-1188-hotel", request, context)).rejects.toThrow(
        "Validation probe is unavailable",
      );
    });

    it("rejects an expired probe before returning a cached quote", async () => {
      const issued = await manageAffiliateValidationProbe(
        admin,
        {
          context: await freshProbeContext(),
          propertyId,
          destinationVersionId: uuid(9),
          action: "create",
          idempotencyKey: "expiring-quote-probe",
          lifetimeSeconds: 5,
        },
        validation,
      );
      if (!issued.ok || !("probe" in issued)) throw new Error("Expiring probe fixture failed");
      const adapter = createAdapter(checkoutPool, { ...validation, probe: issued.probe });
      const request = { ...checkoutRequest("unused"), roomTypeId, validationProbe: issued.probe };
      const context = { ...command("quote-expiry"), operation: "booking-quote" as const };
      const quoted = await adapter.quoteBooking("vay-1188-hotel", request, context);
      expect(quoted).toHaveProperty("quoteId");
      // Use the real database expiry; do not mutate immutable issuance or mock its clock.
      await admin.query(
        `SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))) + 0.02)
        FROM booking.affiliate_validation_probes WHERE id=$1`,
        [issued.probe.slice(4)],
      );
      await expect(adapter.quoteBooking("vay-1188-hotel", request, context)).rejects.toThrow(
        "Validation probe is unavailable",
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM booking.affiliate_validation_quote_bindings WHERE probe_id=$1",
            [issued.probe.slice(4)],
          )
        ).rows[0].n,
      ).toBe(1);
    }, 15000);

    it.skipIf(process.env["TEST_AFFILIATE_BROWSER"] !== "1")(
      "transports a probe from Chromium through the actual HTTP checkout route",
      async () => {
        const deployment = {
          environment: "local" as const,
          connectionReference: "binding-test",
          adapterVersion: "native-v1",
        };
        const issued = await manageAffiliateValidationProbe(
          admin,
          {
            context: await freshProbeContext(),
            propertyId,
            destinationVersionId: uuid(9),
            action: "create",
            idempotencyKey: "browser-probe",
            lifetimeSeconds: 3600,
          },
          deployment,
        );
        if (!issued.ok || !("probe" in issued)) throw new Error("Browser probe fixture failed");

        const selected = { ...validation, probe: issued.probe };
        await expect(
          createAdapter(checkoutPool).createBooking(
            "vay-1188-hotel",
            { ...checkoutRequest("VAY-1506-BROWSER"), validationProbe: issued.probe },
            command("disabled-validation"),
          ),
        ).rejects.toMatchObject({ statusCode: 409 });
        const app = Fastify({ logger: false });
        await app.register(
          async (scope) =>
            registerBookingWebPublicRoutes(scope, {
              profileRepository: { findProfileBySlug: async () => null },
              checkoutAdapter: createAdapter(checkoutPool, selected),
              now: () => occurredAt,
            }),
          { prefix: "/api/booking-web" },
        );
        // Deliberately synthetic diagnostic page: no guest app, cookie, storage or tracking script.
        app.get("/", async (_request, reply) =>
          reply
            .type("text/html")
            .send("<!doctype html><title>Isolated probe transport test</title>"),
        );
        const browser = await chromium.launch({ headless: true });
        try {
          const origin = await app.listen({ host: "127.0.0.1", port: 0 });
          const page = await browser.newPage();
          await page.goto(origin);
          const request: Record<string, unknown> = {
            ...checkoutRequest("VAY-1506-BROWSER"),
            roomTypeId,
            validationProbe: issued.probe,
          };
          const post = (body: Record<string, unknown>, key: string, suffix = "") =>
            page.evaluate(
              async ({ body, key, suffix }) => {
                const response = await fetch(
                  "/api/booking-web/hotels/vay-1188-hotel/bookings" + suffix,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json", "idempotency-key": key },
                    body: JSON.stringify(body),
                  },
                );
                return {
                  status: response.status,
                  cache: response.headers.get("cache-control"),
                  body: (await response.json()) as Record<string, unknown>,
                };
              },
              { body, key, suffix },
            );
          for (const validationProbe of [undefined, "avp_forged"])
            expect(
              await post({ ...request, validationProbe }, "bad-quote", "/quote"),
            ).toMatchObject({ status: 400, cache: "no-store" });
          const quoted = await post(request, "browser-quote", "/quote");
          expect(quoted, JSON.stringify(quoted.body)).toMatchObject({
            status: 200,
            cache: "no-store",
          });
          expect(await post(request, "browser-quote", "/quote")).toEqual(quoted);
          request.quoteId = quoted.body.quoteId;
          request.expectedTotalAmount = quoted.body.totalAmount;
          const browserQuote = (
            await admin.query(
              "SELECT id FROM booking.quote_sessions WHERE public_quote_reference=$1",
              [request.quoteId],
            )
          ).rows[0].id;
          expect(
            (
              await admin.query(
                "SELECT probe_id FROM booking.affiliate_validation_quote_bindings WHERE quote_id=$1",
                [browserQuote],
              )
            ).rows,
          ).toEqual([{ probe_id: issued.probe.slice(4) }]);
          await expect(
            admin.query(
              "UPDATE booking.affiliate_validation_quote_bindings SET request_id='changed' WHERE quote_id=$1",
              [browserQuote],
            ),
          ).rejects.toThrow();
          const other = await manageAffiliateValidationProbe(
            admin,
            {
              context: await freshProbeContext(),
              propertyId,
              destinationVersionId: uuid(9),
              action: "create",
              idempotencyKey: "other-quote-probe",
              lifetimeSeconds: 3600,
            },
            deployment,
          );
          if (!other.ok || !("probe" in other)) throw new Error("Other quote probe failed");
          await expect(
            createAdapter(checkoutPool, { ...selected, probe: other.probe }).createBooking(
              "vay-1188-hotel",
              { ...request, validationProbe: other.probe },
              command("mismatched-quote-probe"),
            ),
          ).rejects.toThrow("Quote validation probe does not match this checkout.");
          const { validationProbe: _ignored, ...normalRequest } = request;
          const normalAdapter = createAdapter(checkoutPool);
          await expect(
            normalAdapter.createBooking("vay-1188-hotel", normalRequest, command("bypass-probe")),
          ).rejects.toThrow("Quote validation probe does not match this checkout.");
          const unbound = (await normalAdapter.quoteBooking(
            "vay-1188-hotel",
            normalRequest,
            command("normal-quote"),
          )) as Record<string, unknown>;
          expect(
            await post({ ...request, quoteId: unbound.quoteId }, "unbound-checkout"),
          ).toMatchObject({ status: 409 });
          for (const validationProbe of [undefined, "avp_forged"]) {
            const rejected = await post({ ...request, validationProbe }, "browser-invalid");
            expect(rejected).toMatchObject({ status: 400, cache: "no-store" });
          }
          expect(
            (
              await admin.query("SELECT status FROM booking.quote_sessions WHERE id=$1", [
                browserQuote,
              ])
            ).rows[0].status,
          ).toBe("active");
          const created = await post(request, "browser-create");
          expect(created).toMatchObject({ status: 200, cache: "no-store" });
          expect(await post(request, "browser-create")).toEqual(created);
          const binding = (
            await admin.query(
              "SELECT b.probe_id FROM booking.affiliate_validation_booking_bindings b JOIN booking.guest_bookings g ON g.id=b.booking_id WHERE g.quote_session_id=$1",
              [browserQuote],
            )
          ).rows;
          expect(binding).toEqual([{ probe_id: issued.probe.slice(4) }]);
          expect(await page.context().cookies()).toEqual([]);
          expect(await page.evaluate("[localStorage.length, sessionStorage.length]")).toEqual([
            0, 0,
          ]);
        } finally {
          await browser.close();
          await app.close();
        }
      },
    );

    function createAdapter(pool: pg.Pool, affiliateValidation?: AffiliateProbeCheckout) {
      return createTargetBookingWebCheckoutAdapter({
        connectionString: TEST_DATABASE_URL!,
        affiliateValidation,
        pool,
        inventoryReservationPort,
        billingConfigReadPortFactory: () => ({
          async getBillingConfig(requestedPropertyId) {
            return {
              propertyId: requestedPropertyId,
              activePlan: "commission",
              bookingEngineFeePercent: 5,
              channelManagerFeePercent: 8,
              affiliatePlatformFeePercent: 2,
              updatedAt: occurredAt.toISOString(),
            };
          },
        }),
      });
    }

    async function seedProperty(): Promise<void> {
      await admin.query(
        `INSERT INTO hotel_catalog.properties
         (id, public_id, display_name, profile_status, lifecycle_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'complete', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'canonical', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Europe/Athens')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug,
          default_locale, supported_locales, profile_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'vay-1188-hotel',
               'en', ARRAY['en'], 'complete')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO finance.payment_settings
         (property_id, payments_enabled, accepted_methods, default_currency)
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash'], 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.booking_settings
         (property_id, acceptance_mode, phone_required, default_currency)
       VALUES ($1::uuid, 'request', FALSE, 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.addon_definitions
         (id, property_id, source_addon_id, name, pricing_model, price_amount,
          currency, ownership_kind, partner_commission_rate)
       VALUES ($1::uuid, $2::uuid, 'spa_partner', 'Partner spa', 'per_guest', 10.25,
               'EUR', 'partner', 18.75)`,
        [addonId, propertyId],
      );
      await admin.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, finance_payment_settings_property_id, public_id, canonical_slug,
          canonical_url, booking_base_url, timezone, default_currency,
          supported_currencies, profile_status, freshness_status,
          capabilities, public_setup_completeness, data_sources)
       VALUES (
         $1::uuid, $1::uuid, 'vay-1188-hotel', 'vay-1188-hotel',
         'https://booking.example.test/vay-1188-hotel', 'https://booking.example.test',
         'Europe/Athens', 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"paymentMethods":["pay_at_property"]}'::jsonb, '{"status":"ready"}'::jsonb,
         ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']
       )`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO pms.room_types
         (id, property_id, name, occupancy_limits, base_rate_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'VAY-1188 Room', '{"adults":2,"total":2}', 100, 'EUR')`,
        [roomTypeId, propertyId],
      );
      // prettier-ignore
      await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO pms.operating_calendar_revisions (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at) VALUES (gen_random_uuid(),'${propertyId}',1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,1,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now()); INSERT INTO pms.operating_calendar_room_bindings (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) VALUES ('${propertyId}',1,'${roomTypeId}',1,1,2,2); COMMIT;`);
      await admin.query(
        `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
          inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
          generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $1::uuid,$2::uuid,stay_date,2,2,1,1,2,2,1,0,0,0,0
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
      await admin.query(
        `INSERT INTO distribution.public_room_offer_snapshots
         (property_id, room_type_id, stay_date, public_offer_key, available_rooms,
          base_price_amount, currency, payment_options, freshness_status, rate_summary)
       SELECT $1::uuid, $2::uuid, stay_date, 'vay-1188-flex', 2,
              100, 'EUR', ARRAY['pay_at_property'], 'fresh', '{"code":"flex"}'::jsonb
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
    }

    async function seedQuote(id: string, reference: string, quotedAddonId: string): Promise<void> {
      await admin.query(
        `INSERT INTO booking.quote_sessions
         (id, property_id, request_hash, public_quote_reference,
          requested_check_in, requested_check_out, adults, children,
          requested_room_count, currency, selected_offer_snapshot, totals,
          policy_snapshot, expires_at)
       VALUES (
         $1::uuid, $2::uuid, $3, $4,
         DATE '2027-02-01', DATE '2027-02-03', 2, 0,
         1, 'EUR',
         jsonb_build_object(
           'roomTypeId', $5::text,
           'publicOfferKey', 'vay-1188-flex',
           'paymentMethod', 'pay_at_property',
           'acceptanceMode', 'request',
           'addonRequest', jsonb_build_object(
             'addonIds', jsonb_build_array('spa_partner'),
             'addonQuantities', '{"spa_partner":2}'::jsonb,
             'addonDates', '{}'::jsonb
           ),
           'addonPurchases', jsonb_build_array(jsonb_build_object(
             'addonDefinitionId', $6::text,
             'addonSnapshot', jsonb_build_object(
               'addonDefinitionId', $6::text,
               'sourceAddonId', 'spa_partner',
               'name', 'Partner spa',
               'pricingModel', 'per_guest',
               'unitAmount', '10.25',
               'currency', 'EUR'
             ),
             'quantity', 2,
             'serviceDate', '2027-02-01',
             'totalAmount', '20.50',
             'currency', 'EUR',
             'ownershipKind', 'partner',
             'partnerCommissionRate', '18.7500'
           ))
         ),
         '{"roomTotal":"200.00","addonTotal":"20.50","totalAmount":"220.50","balanceAmount":"220.50"}'::jsonb,
         '{}'::jsonb, TIMESTAMPTZ '2027-01-02T10:00:00Z'
       )`,
        [id, propertyId, `hash-${reference}`, reference, roomTypeId, quotedAddonId],
      );
    }

    async function cleanup(): Promise<void> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "DELETE FROM booking.affiliate_validation_quote_bindings WHERE property_id=$1",
          "DELETE FROM booking.affiliate_validation_booking_bindings WHERE property_id=$1",
          "DELETE FROM booking.affiliate_validation_probe_revocations WHERE probe_id IN (SELECT id FROM booking.affiliate_validation_probes WHERE property_id=$1)",
          "DELETE FROM booking.affiliate_validation_probes WHERE property_id=$1",
          "DELETE FROM booking.affiliate_destination_versions WHERE property_id=$1",
          "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
          "DELETE FROM identity.organizations WHERE id=$1",
          "DELETE FROM identity.users WHERE id=$1",
          "WITH s AS (DELETE FROM pms.inventory_reservation_statuses WHERE property_id=$1::uuid), w AS (DELETE FROM pms.inventory_reservation_day_watermarks WHERE property_id=$1::uuid), r AS (DELETE FROM pms.inventory_reservation_receipts WHERE property_id=$1::uuid) DELETE FROM platform.outbox_events WHERE property_id=$1::uuid",
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
          "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
          "DELETE FROM booking.direct_booking_summary_read_model WHERE property_id = $1::uuid",
          `DELETE FROM booking.booking_status_events
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          `DELETE FROM booking.booking_guests
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          "DELETE FROM booking.booking_addon_selections WHERE property_id = $1::uuid",
          "DELETE FROM booking.original_charge_snapshots WHERE property_id = $1::uuid",
          "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
          "DELETE FROM booking.checkout_contexts WHERE property_id = $1::uuid",
          "DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid",
          "DELETE FROM booking.addon_definitions WHERE property_id = $1::uuid",
          "DELETE FROM booking.same_day_booking_policies WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
          "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
          "WITH b AS (DELETE FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid) DELETE FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid",
          "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
          "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
          "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
        ]) {
          await client.query(statement, [propertyId]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  },
);

const realInventoryReservationPort = createTargetPmsInventoryReservationPort();
const inventoryReservationPort: DirectBookingInventoryReservationPort = {
  async reserve(input) {
    const reservation = await realInventoryReservationPort.reserve(input);
    if (reservation) completedReservationQuoteIds.add(input.quoteSessionId);
    return reservation;
  },
  async release(input) {
    await realInventoryReservationPort.release(input);
  },
};

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function waitForLockWaiter(observer: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for checkout to acquire the property lock");
}

function checkoutRequest(quoteId: string): Record<string, unknown> {
  return {
    validationProbe: validation?.probe,
    quoteId,
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    currency: "EUR",
    paymentMethod: "pay_at_property",
    addonIds: ["spa_partner"],
    addonQuantities: { spa_partner: 2 },
    expectedTotalAmount: "220.50",
    firstName: "Ada",
    lastName: "Lovelace",
    guestEmail: "ada@example.test",
    bookingChannel: "ota",
    directBookingSource: "phone",
    booking_channel: "ota",
    direct_booking_source: "email",
  };
}

function command(suffix: string): BookingWebCheckoutCommandContext {
  return {
    operation: "booking-create",
    requestId: `vay-1188-${suffix}`,
    correlationId: `vay-1188-${suffix}-correlation`,
    idempotencyKey: `vay-1188-${suffix}-idempotency`,
    fingerprint: suffix.padEnd(64, "0"),
    occurredAt,
  };
}
