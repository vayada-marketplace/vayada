import { randomUUID } from "node:crypto";
import { recordTargetCheckoutCommand } from "./bookingWebPublic.js";
import { describe, expect, it } from "vitest";
import { createPgBookingLifecycleStore } from "../jobs/bookingLifecycle.js";
import {
  enqueueBookingTransitionNotifications,
  loadBookingNotificationSnapshot,
} from "../jobs/bookingEmails.js";
import { createTargetBookingReservationsReadRepository } from "../platform/bookingReservations.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { releaseAbandonedBookingEdits } from "../jobs/pendingBookingEditCleanup.js";
import { enableCard, propertyId, roomTypeId } from "./pendingBookingEdits.fixtures.js";
import { pendingEditFixture } from "./pendingBookingEdits.testFixture.js";
describe.skipIf(!process.env["TEST_DATABASE_URL"])(
  "pending request edits through target checkout",
  () => {
    const fixture = pendingEditFixture();
    const { pool, now, adapter, command, edit, url, intents, stripe } = fixture;
    it("reads edit eligibility for a historical pending request", () => {
      expect(fixture.created.booking).toMatchObject({ status: "pending", canEditRequest: true });
    });

    it("resolves only valid property host contacts and audits missing recipients once", async () => {
      const client = await pool.connect();
      const input = { propertyId, guestBookingId: fixture.created.booking.id };
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO hotel_catalog.properties
          (id, public_id, display_name, profile_status, lifecycle_status)
          VALUES ('95900000-0000-4000-8000-000000000099', 'other-host', 'Other', 'complete', 'active')`);
        await client.query(
          `INSERT INTO hotel_catalog.property_contact_channels
          (property_id, channel_type, value, purpose, is_public, source_system) VALUES
          ($1, 'email', 'creator@example.test', 'creator', TRUE, 'platform'),
          ($1, 'email', 'invalid', 'operations', FALSE, 'platform'),
          ($1, 'email', 'legacy@example.test', 'general', TRUE, 'booking'),
          ('95900000-0000-4000-8000-000000000099', 'email', 'other@example.test', 'operations', FALSE, 'platform')`,
          [propertyId],
        );
        expect((await loadBookingNotificationSnapshot(client, input))?.hostEmail).toBe(
          "hotel@example.test",
        );
        await client.query(
          `INSERT INTO hotel_catalog.property_contact_channels
          (property_id, channel_type, value, purpose, is_public, source_system)
          VALUES ($1, 'email', 'operations@example.test', 'operations', FALSE, 'platform')`,
          [propertyId],
        );
        expect((await loadBookingNotificationSnapshot(client, input))?.hostEmail).toBe(
          "operations@example.test",
        );
        await client.query(
          `DELETE FROM hotel_catalog.property_contact_channels
          WHERE property_id=$1 AND value IN ('operations@example.test', 'hotel@example.test')`,
          [propertyId],
        );
        expect((await loadBookingNotificationSnapshot(client, input))?.hostEmail).toBe(
          "legacy@example.test",
        );
        await client.query(
          `DELETE FROM hotel_catalog.property_contact_channels
          WHERE property_id=$1 AND value='legacy@example.test'`,
          [propertyId],
        );
        expect((await loadBookingNotificationSnapshot(client, input))?.hostEmail).toBeNull();
        const transition = {
          eventType: "guest_booking.request_updated",
          fromStatus: "pending_payment",
          toStatus: "pending_payment",
          revision: "missing-host-test",
        };
        for (let replay = 0; replay < 2; replay++) {
          expect(
            await enqueueBookingTransitionNotifications(client, {
              ...input,
              occurredAt: now.toISOString(),
              transition,
            }),
          ).toEqual([]);
        }
        expect(
          (
            await client.query(
              `SELECT id FROM platform.jobs WHERE property_id=$1
          AND job_type='email.booking-host-request-updated'`,
              [propertyId],
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await client.query(
              `SELECT redacted_payload FROM platform.product_audit_events
          WHERE property_id=$1 AND action='booking.notification.missing_recipient'
          AND redacted_payload #>> '{transition,revision}'='missing-host-test'`,
              [propertyId],
            )
          ).rows,
        ).toEqual([
          {
            redacted_payload: expect.objectContaining({
              outcome: "blocked",
              reason: "host_recipient_missing",
            }),
          },
        ]);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("rejects missing credentials and invalid occupancy", async () => {
      await expect(
        adapter.editRequest!("vay-959-hotel", fixture.created.booking.id, "details", {}, command()),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        edit("quote", { revision: 0, roomTypeId, adults: -1, children: 0, numberOfRooms: 1 }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    async function snapshot() {
      const result: Record<string, unknown> = {};
      for (const table of [
        "booking.guest_bookings",
        "booking.quote_sessions",
        "booking.pending_booking_edit_attempts",
        "platform.idempotency_keys",
        "platform.jobs",
        "finance.payments",
        "pms.inventory_days",
        "pms.inventory_reservation_statuses",
      ]) {
        result[table] = (
          await pool.query(
            `SELECT to_jsonb(row) AS row FROM ${table} row WHERE property_id=$1 ORDER BY to_jsonb(row)::text`,
            [propertyId],
          )
        ).rows;
      }
      return result;
    }
    async function seedPreparedAttempt() {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO booking.pending_booking_edit_attempts
          (id,property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,quote_session_id,payment_method,request_snapshot,expires_at)
         SELECT $1::uuid,property_id,id,edit_revision,$1::text,repeat('a',64),quote_session_id,'pay_at_property',
           '{"quoteId":"edit-original","revision":0}'::jsonb,'2027-01-02T10:00:00Z'
         FROM booking.guest_bookings WHERE id=$2`,
        [id, fixture.created.booking.id],
      );
      return id;
    }
    it("rejects pricing edits and new checkout without changing the historical request or holds", async () => {
      const details = await edit("details", {});
      expect(details.revision).toBe(0);
      expect(details.input.addonIds).toEqual(["spa_partner"]);
      const attemptId = await seedPreparedAttempt();
      const before = await snapshot();
      const input = { ...details.input, revision: 0, adults: 1, quoteId: "edit-original" };
      for (const [action, request] of [
        ["quote", input],
        ["prepare", input],
        ["save", { revision: 0, attemptId }],
      ] as const) {
        await expect(edit(action, request)).rejects.toMatchObject({
          statusCode: 503,
          code: "PRICING_UNAVAILABLE",
        });
        expect(await snapshot()).toEqual(before);
      }
      await expect(adapter.createBooking("vay-959-hotel", input, command())).rejects.toMatchObject({
        statusCode: 503,
        code: "PRICING_UNAVAILABLE",
      });
      expect(await snapshot()).toEqual(before);
      expect(intents.size).toBe(0);
    });
    it("replays a committed historical save after acceptance and still requires credentials", async () => {
      const context = command();
      const body = { booking: fixture.created.booking, historicalReplay: true };
      await recordTargetCheckoutCommand(pool, {
        propertyId,
        context,
        resourceType: "guest_booking",
        resourceId: fixture.created.booking.id,
        body,
      });
      await pool.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='confirmed' WHERE id=$1",
        [fixture.created.booking.id],
      );
      try {
        expect(await edit("save", { revision: 0 }, context)).toEqual(body);
        await expect(
          adapter.editRequest!("vay-959-hotel", fixture.created.booking.id, "save", {}, context),
        ).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await pool.query(
          "UPDATE booking.guest_bookings SET lifecycle_status='pending_payment' WHERE id=$1",
          [fixture.created.booking.id],
        );
      }
    });
    it("reads historical requests in PMS and notifications without pricing", async () => {
      const repository = createTargetBookingReservationsReadRepository({
        connectionString: url!,
        pool,
      });
      const result = await repository.listReservationsByPropertyId(propertyId, {
        limit: 10,
        offset: 0,
        canReadGuestContact: true,
      });
      expect(result.reservations[0]).toMatchObject({
        paymentMethod: "pay_at_property",
        specialRequests: "Quiet room, please.",
      });
      const snapshot = await loadBookingNotificationSnapshot(pool, {
        propertyId,
        guestBookingId: fixture.created.booking.id,
      });
      expect(snapshot).toMatchObject({ hostEmail: "hotel@example.test" });
      const lifecycle = createPgBookingLifecycleStore({ connectionString: url!, pool });
      await expect(lifecycle.findPendingBookingExpiryCandidates(now, 10)).resolves.toEqual([]);
      await expect(lifecycle.findExpiredDraftCandidates(now, 10)).resolves.toEqual([]);
    });

    it("rejects closed lifecycle states and expired credentials", async () => {
      for (const status of ["confirmed", "declined", "canceled", "expired"]) {
        await pool.query("UPDATE booking.guest_bookings SET lifecycle_status=$2 WHERE id=$1", [
          fixture.created.booking.id,
          status,
        ]);
        await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      }
      await pool.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='pending_payment' WHERE id=$1",
        [fixture.created.booking.id],
      );
      await expect(
        adapter.editRequest!(
          "vay-959-hotel",
          fixture.created.booking.id,
          "details",
          { confirmationToken: "x".repeat(43) },
          command(),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=booking_metadata || jsonb_build_object('acceptedPaymentDeadlineAt','2027-01-02T10:00:00Z') WHERE id=$1",
        [fixture.created.booking.id],
      );
      await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=booking_metadata-'acceptedPaymentDeadlineAt' WHERE id=$1",
        [fixture.created.booking.id],
      );
    });

    it("rejects operational handoffs that have already started", async () => {
      await pool.query(
        "UPDATE platform.jobs SET status='running',locked_by='test',locked_at=now() WHERE property_id=$1 AND job_type='pms.reservation.create'",
        [propertyId],
      );
      await expect(edit("details", {})).rejects.toMatchObject({ statusCode: 409 });
      await pool.query(
        "UPDATE platform.jobs SET status='pending',locked_by=NULL,locked_at=NULL WHERE property_id=$1 AND job_type='pms.reservation.create'",
        [propertyId],
      );
    });

    it("refuses strict replacement of an already handed-off inventory receipt", async () => {
      const client = await pool.connect();
      await client.query("BEGIN");
      try {
        const booking = (
          await client.query("SELECT booking_metadata FROM booking.guest_bookings WHERE id=$1", [
            fixture.created.booking.id,
          ])
        ).rows[0];
        const receipt = booking.booking_metadata.inventoryReservation;
        await client.query("SET LOCAL session_replication_role=replica");
        await client.query(
          "UPDATE pms.inventory_reservation_statuses SET lifecycle_state='handed_off',lifecycle_revision=2,handed_off_at=now() WHERE receipt_id=$1",
          [receipt.receiptId],
        );
        await expect(
          createTargetPmsInventoryReservationPort().release({
            transaction: client,
            propertyId,
            reservation: receipt,
            occurredAt: now,
            requireReserved: true,
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("drains releases even when another account's recovery fails", async () => {
      await enableCard(pool);
      await pool.query(
        `INSERT INTO booking.pending_booking_edit_attempts
          (property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,quote_session_id,provider_account_id,payment_method,provider_request,created_at,expires_at,updated_at)
         SELECT b.property_id,b.id,0,'poison-recovery',repeat('a',64),b.quote_session_id,a.id,'card',
           '{"idempotencyKey":"poison"}'::jsonb,now()-interval '2 hours',now()-interval '1 hour',now()-interval '2 hours'
         FROM booking.guest_bookings b JOIN finance.payment_provider_accounts a ON a.property_id=b.property_id
         WHERE b.id=$1`,
        [fixture.created.booking.id],
      );
      const recovery = await stripe.createPaymentIntent({
        propertyId,
        bookingReference: fixture.created.booking.bookingReference,
        providerAccountRef: "acct_vay959",
        amountMinor: 100,
        currency: "EUR",
        applicationFeeAmountMinor: 5,
        captureMethod: "manual",
        idempotencyKey: "durable-release",
      });
      recovery.status = "requires_capture";
      await pool.query(
        `INSERT INTO booking.edit_authorization_releases(provider_payment_intent_id,provider_account_ref,property_id) VALUES($1,'acct_vay959',$2)`,
        [recovery.paymentIntentId, propertyId],
      );
      await releaseAbandonedBookingEdits(pool, {
        connectionString: url!,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: {
          ...stripe,
          async createPaymentIntent(input) {
            if (input.idempotencyKey === "poison") throw new Error("Disconnected account");
            return stripe.createPaymentIntent(input);
          },
        },
      });
      expect(recovery.status).toBe("canceled");

      expect(
        (
          await pool.query(
            "SELECT status FROM booking.pending_booking_edit_attempts WHERE idempotency_key='poison-recovery'",
          )
        ).rows[0].status,
      ).toBe("prepared");
    });

    it("releases an expired replacement card hold and preserves the booking's active authorization", async () => {
      const providerRequest = {
        propertyId,
        bookingReference: fixture.created.booking.bookingReference,
        providerAccountRef: "acct_vay959",
        amountMinor: 22050,
        currency: "EUR",
        applicationFeeAmountMinor: 1103,
        captureMethod: "manual" as const,
      };
      const active = await stripe.createPaymentIntent({
        ...providerRequest,
        idempotencyKey: "historical-active-card",
      });
      const abandoned = await stripe.createPaymentIntent({
        ...providerRequest,
        idempotencyKey: "historical-abandoned-card",
      });
      active.status = "requires_capture";
      abandoned.status = "requires_capture";
      const paymentId = randomUUID();
      const attemptId = randomUUID();
      await pool.query(
        `INSERT INTO finance.payments
          (id,property_id,guest_booking_id,provider_account_id,payment_kind,payment_method,status,amount,currency,provider_payment_intent_id)
         SELECT $1::uuid,$2::uuid,$3::uuid,id,'full','card','authorized',220.50,'EUR',$4
         FROM finance.payment_provider_accounts WHERE property_id=$2`,
        [paymentId, propertyId, fixture.created.booking.id, active.paymentIntentId],
      );
      await pool.query(
        "UPDATE booking.guest_bookings SET payment_status='authorized',active_card_payment_id=$2 WHERE id=$1",
        [fixture.created.booking.id, paymentId],
      );
      await pool.query(
        `INSERT INTO booking.pending_booking_edit_attempts
          (id,property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,quote_session_id,provider_account_id,payment_method,provider_request,provider_payment_intent_id,request_snapshot,created_at,expires_at,updated_at)
         SELECT $1::uuid,b.property_id,b.id,0,'historical-abandoned-card',repeat('a',64),b.quote_session_id,a.id,'card',$3::jsonb,$4,
           '{"specialRequests":"abandoned edit"}'::jsonb,now()-interval '2 hours',now()-interval '1 hour',now()-interval '2 hours'
         FROM booking.guest_bookings b JOIN finance.payment_provider_accounts a ON a.property_id=b.property_id WHERE b.id=$2`,
        [
          attemptId,
          fixture.created.booking.id,
          JSON.stringify({ ...providerRequest, idempotencyKey: "historical-abandoned-card" }),
          abandoned.paymentIntentId,
        ],
      );
      const before = await snapshot();
      await releaseAbandonedBookingEdits(pool, {
        connectionString: url!,
        inventoryReservationPort: createTargetPmsInventoryReservationPort(),
        stripePaymentProvider: {
          ...stripe,
          async createPaymentIntent(input) {
            if (input.idempotencyKey === "poison") throw new Error("Disconnected account");
            return stripe.createPaymentIntent(input);
          },
        },
      });
      expect(abandoned.status).toBe("canceled");
      expect(active.status).toBe("requires_capture");
      expect(
        (
          await pool.query(
            "SELECT status,request_snapshot FROM booking.pending_booking_edit_attempts WHERE id=$1",
            [attemptId],
          )
        ).rows,
      ).toEqual([{ status: "released", request_snapshot: {} }]);
      expect(
        (
          await pool.query(
            "SELECT released_at IS NOT NULL AS released,attempts FROM booking.edit_authorization_releases WHERE provider_payment_intent_id=$1",
            [abandoned.paymentIntentId],
          )
        ).rows,
      ).toEqual([{ released: true, attempts: 1 }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM booking.edit_authorization_releases WHERE provider_payment_intent_id=$1",
            [active.paymentIntentId],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      const after = await snapshot();
      for (const table of [
        "booking.guest_bookings",
        "finance.payments",
        "pms.inventory_days",
        "pms.inventory_reservation_statuses",
      ]) {
        expect(after[table]).toEqual(before[table]);
      }
    });

    it("rejects a prepared save when acceptance wins the booking lock", async () => {
      const details = await edit("details", {});
      const prepared = { attemptId: await seedPreparedAttempt() };
      const hotel = await pool.connect();
      await hotel.query("BEGIN");
      await hotel.query("SELECT id FROM booking.guest_bookings WHERE id=$1 FOR UPDATE", [
        fixture.created.booking.id,
      ]);
      const saving = edit("save", { revision: details.revision, attemptId: prepared.attemptId });
      const rejected = expect(saving).rejects.toMatchObject({ statusCode: 409 });
      await hotel.query(
        "UPDATE booking.guest_bookings SET lifecycle_status='confirmed' WHERE id=$1",
        [fixture.created.booking.id],
      );
      await hotel.query("COMMIT");
      hotel.release();
      await rejected;
      expect(
        (
          await pool.query("SELECT edit_revision FROM booking.guest_bookings WHERE id=$1", [
            fixture.created.booking.id,
          ])
        ).rows[0].edit_revision,
      ).toBe(details.revision);
    });
  },
);

describe.skipIf(!process.env["TEST_DATABASE_URL"])(
  "sold-out setup readiness during pending edits",
  () => {
    const fixture = pendingEditFixture(1);
    const { pool, edit } = fixture;
    it("keeps sold-out historical requests readable while pricing remains unavailable", async () => {
      const details = await edit("details", {});
      const input = { ...details.input, revision: details.revision, adults: 1 };
      for (const missing of [
        ["sellable_availability"],
        ["sellable_availability", "payment_methods"],
      ]) {
        await pool.query(
          `UPDATE distribution.public_hotel_bookability_profiles SET public_setup_completeness=jsonb_build_object('status','incomplete','missing',$2::jsonb) WHERE property_id=$1`,
          [propertyId, JSON.stringify(missing)],
        );
        expect((await edit("details", {})).revision).toBe(details.revision);
        await expect(edit("quote", input)).rejects.toMatchObject({
          statusCode: 503,
          code: "PRICING_UNAVAILABLE",
        });
        await expect(edit("prepare", input)).rejects.toMatchObject({
          statusCode: 503,
          code: "PRICING_UNAVAILABLE",
        });
      }
      expect(
        (
          await pool.query(
            "SELECT available_count FROM pms.inventory_days WHERE property_id=$1 AND stay_date<'2027-02-03' ORDER BY stay_date",
            [propertyId],
          )
        ).rows,
      ).toEqual([{ available_count: 0 }, { available_count: 0 }]);
    });
  },
);
