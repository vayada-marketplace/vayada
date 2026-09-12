import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect } from "vitest";
import {
  createTargetBookingWebCheckoutAdapter,
  loadTargetBooking,
  serializeTargetBooking,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import {
  cleanup,
  seedProperty,
  seedQuote,
  addonId,
  roomTypeId,
  propertyId,
} from "./pendingBookingEdits.fixtures.js";
import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "../domains/stripeBookingPayments.js";
export function pendingEditFixture(capacity = 2) {
  const intents = new Map<string, StripeBookingPaymentIntent>();
  const keys = new Map<string, string>();
  const stripe: StripeBookingPaymentProvider = {
    async createPaymentIntent(input) {
      let id = keys.get(input.idempotencyKey);
      if (!id) {
        id = `pi_${randomUUID()}`;
        keys.set(input.idempotencyKey, id);
        intents.set(id, {
          ...input,
          paymentIntentId: id,
          clientSecret: `${id}_secret`,
          status: "requires_payment_method",
        });
      }
      expect(input.captureMethod).toBe("manual");
      return intents.get(id)!;
    },
    async retrievePaymentIntent(id) {
      return intents.get(id)!;
    },
    async capturePaymentIntent() {
      throw new Error("Editing must never capture funds");
    },
    async cancelPaymentIntent(id) {
      const intent = intents.get(id)!;
      intent.status = "canceled";
      return intent;
    },
  };
  const url = process.env["TEST_DATABASE_URL"];
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const now = new Date("2027-01-01T10:00:00Z");
  const adapter = createTargetBookingWebCheckoutAdapter({
    connectionString: url ?? "",
    pool,
    stripePaymentProvider: stripe,
    now: () => new Date(now),
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
    billingConfigReadPortFactory: () => ({
      async getBillingConfig(id) {
        return {
          propertyId: id,
          activePlan: "commission",
          bookingEngineFeePercent: 5,
          channelManagerFeePercent: 8,
          affiliatePlatformFeePercent: 2,
          updatedAt: now.toISOString(),
        };
      },
    }),
  });
  function command(): BookingWebCheckoutCommandContext {
    const key = randomUUID();
    return {
      operation: "booking-edit-test",
      requestId: key,
      correlationId: key,
      idempotencyKey: key,
      fingerprint: key.replaceAll("-", "").repeat(2),
      occurredAt: now,
    };
  }
  let created: any;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_edit_test"))
      throw new Error("Use the dedicated edit test database.");
    await cleanup(pool);
    await seedProperty(pool, capacity);
    const quoteId = randomUUID();
    const bookingId = randomUUID();
    const token = "historical-confirmation-token-".padEnd(43, "x");
    await seedQuote(pool, quoteId, "edit-original", addonId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const receipt = await createTargetPmsInventoryReservationPort().reserve({
        transaction: client,
        propertyId,
        quoteSessionId: quoteId,
        roomTypeId,
        publicOfferKey: "vay-959-flex",
        checkIn: "2027-02-01",
        checkOut: "2027-02-03",
        roomCount: 1,
        currency: "EUR",
        occurredAt: now,
      });
      if (!receipt) throw new Error("Historical booking inventory fixture could not reserve");
      await client.query(
        `INSERT INTO booking.guest_bookings
          (id, property_id, quote_session_id, public_reference, lifecycle_status,
           check_in, check_out, adults, children, room_count, currency, total_amount,
           balance_amount, booking_metadata, booking_channel, direct_booking_source)
         SELECT $1,$2,id,'EDIT-HISTORICAL','pending_payment',requested_check_in,requested_check_out,
           adults,children,requested_room_count,currency,220.50,220.50,
           jsonb_build_object('selectedOffer',selected_offer_snapshot,'paymentMethod','pay_at_property',
             'hostResponseDeadlineAt','2027-01-02T10:00:00Z', 'inventoryReservation',$3::jsonb,
             'confirmationTokenHash',$4::text,'confirmationTokenExpiresAt','2027-01-03T10:00:00Z'),
           'direct','booking_engine'
         FROM booking.quote_sessions WHERE id=$5`,
        [
          bookingId,
          propertyId,
          JSON.stringify(receipt),
          createHash("sha256").update(token).digest("hex"),
          quoteId,
        ],
      );
      await client.query(
        `INSERT INTO booking.booking_guests
          (guest_booking_id,guest_role,first_name,last_name,email,special_requests)
         VALUES ($1,'booker','Ada','Lovelace','ada@example.test','Quiet room, please.')`,
        [bookingId],
      );
      await client.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
         VALUES ($1,'pms-reservation-handoff','pms.reservation.create','property',$2,'booking','guest_booking',$3,'{}')`,
        [`historical-handoff:${bookingId}`, propertyId, bookingId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    created = {
      booking: { id: bookingId, bookingReference: "EDIT-HISTORICAL" },
      confirmationToken: token,
    };
    created.booking = serializeTargetBooking(
      await loadTargetBooking(
        pool,
        propertyId,
        bookingId,
        null,
        createHash("sha256").update(token).digest("hex"),
      ),
    );
  });
  afterAll(async () => {
    await adapter.close?.();
    await pool.end();
  });

  const edit = (action: string, input: Record<string, unknown>, context = command()) =>
    adapter.editRequest!(
      "vay-959-hotel",
      created.booking.id,
      action,
      { ...input, confirmationToken: created.confirmationToken },
      context,
    ) as Promise<any>;

  return {
    pool,
    now,
    adapter,
    command,
    edit,
    url,
    intents,
    stripe,
    get created() {
      return created;
    },
  };
}
