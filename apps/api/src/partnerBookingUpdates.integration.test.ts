import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runPartnerBookingSweep } from "./domains/partnerBookingUpdates.js";
import {
  createPgPartnerConnectionsRepository,
  pkceChallenge,
  type PartnerConnectionsRepository,
} from "./domains/partnerConnections.js";
import { createPgPartnerPromoCodesRepository } from "./domains/partnerPromoCodes.js";
import {
  deliverPartnerWebhooks,
  deriveWebhookSigningSecret,
  webhookSignature,
} from "./domains/partnerWebhooks.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import { registerPartnerApp } from "./platform/partnerAppRegistration.js";

/**
 * VAY-2438: bookings that used a connected partner app's code reach its webhook, signed, as
 * booking.confirmed / changed / cancelled with the booking as it is now and no guest data; failed
 * sends are retried; a disconnect sends connection.revoked and stops the updates. Real PostgreSQL,
 * written by the ordinary API login; the webhook is a local HTTP server.
 */
const url = process.env["TEST_DATABASE_URL"];
const hotelId = randomUUID();
const ownerId = randomUUID();
const signingKey = randomBytes(32);
const BOOKING_KEYS = [
  "bookingId",
  "reference",
  "version",
  "status",
  "promoCode",
  "promoCodeId",
  "checkIn",
  "checkOut",
  "roomCount",
  "currency",
  "totalAmount",
  "extrasAmount",
  "discountAmount",
  "confirmedAt",
  "cancelledAt",
];

type Received = { headers: IncomingHttpHeaders; body: string };
type SentEvent = {
  id: string;
  type: string;
  occurredAt: string;
  hotelId: string;
  booking?: { bookingId: string; version: number } & Record<string, unknown>;
};

describe.skipIf(!url)("signed booking updates for partner codes (VAY-2438)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let connections: PartnerConnectionsRepository;
  let server: Server;
  let clientId: string;
  let promoCodeId: string;
  const received: Received[] = [];
  let answer = 200;
  let clock = Date.now();
  const now = () => new Date(clock);
  const sweep = () => runPartnerBookingSweep({ pool, now });
  const deliver = (log?: { error: (details: Record<string, unknown>, message: string) => void }) =>
    deliverPartnerWebhooks({ pool, signingKey, now, ...(log ? { log } : {}) });
  const events = () => received.map((r) => JSON.parse(r.body) as SentEvent);

  async function insertBooking(lifecycle: string, withCode = true) {
    const bookingId = randomUUID();
    await admin.query(
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency,
          total_amount, room_count)
       VALUES ($1, $2, $3, $4, '2026-12-01', '2026-12-04', 'EUR', 420.00, 1)`,
      [bookingId, hotelId, `VAY-${bookingId.slice(0, 8).toUpperCase()}`, lifecycle],
    );
    if (lifecycle === "confirmed")
      await admin.query(
        `INSERT INTO booking.booking_status_events
           (guest_booking_id, event_type, from_status, to_status, actor_type, occurred_at)
         VALUES ($1, 'guest_booking.created', 'draft', 'confirmed', 'guest', now() - interval '1 hour')`,
        [bookingId],
      );
    if (withCode)
      await admin.query(
        `INSERT INTO booking.promo_applications
           (property_id, guest_booking_id, promo_code, application_status, discount_amount, currency,
            promo_definition_id)
         VALUES ($1, $2, 'MIA10', 'applied', 46.67, 'EUR', $3)`,
        [hotelId, bookingId, promoCodeId],
      );
    return bookingId;
  }

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body });
        response.statusCode = answer;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, 'Hotel Alpina')`,
      [hotelId],
    );
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
      ownerId,
      `${ownerId}@example.test`,
    ]);
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 3 });
    connections = createPgPartnerConnectionsRepository({ pool });
    clientId = (
      await registerPartnerApp(pool, {
        name: "Partner Webhooks",
        redirectUris: ["https://partner.example/callback"],
        scopes: ["promo_codes", "bookings"],
        webhookUrl: `http://127.0.0.1:${port}/vayada`,
        contactEmail: null,
        termsVersion: "partner-contract-2026-10-31",
      })
    ).clientId;
    const app = (await connections.findApp(clientId))!;
    await connections.approve({
      request: {
        app,
        redirectUri: "https://partner.example/callback",
        scopes: ["promo_codes", "bookings"],
        codeChallenge: pkceChallenge(randomBytes(32).toString("base64url")),
        state: null,
      },
      propertyId: hotelId,
      approvedByUserId: ownerId,
    });
    const connectionId = (await connections.listConnections(hotelId))[0]!.connectionId;
    const code = await createPgPartnerPromoCodesRepository({ pool }).create(
      { appId: app.appId, propertyId: hotelId, connectionId },
      {
        code: "MIA10",
        discountType: "percentage",
        discountValue: "10",
        minBookingValue: null,
        applicableRoomIds: null,
        validFrom: null,
        validUntil: null,
        stayDateFrom: null,
        stayDateUntil: null,
        isActive: true,
        maxUses: 2147483647,
        externalId: "cl-1",
      },
    );
    promoCodeId = code!.promoCodeId;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await fixture?.drop();
    await admin?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("sends a confirmed booking with the code once, signed, with extras and no guest data", async () => {
    const bookingId = await insertBooking("confirmed");
    await admin.query(
      `INSERT INTO booking.booking_addon_selections (property_id, guest_booking_id, total_amount, currency)
       VALUES ($1, $2, 30.00, 'EUR')`,
      [hotelId, bookingId],
    );
    await insertBooking("pending_payment"); // never confirmed: never reported

    expect(await sweep()).toEqual({ queued: 1 });
    expect(await sweep()).toEqual({ queued: 0 });
    expect(await deliver()).toEqual({ delivered: 1, retrying: 0, failed: [] });

    const [delivery] = received;
    const secret = deriveWebhookSigningSecret(signingKey, clientId, 1);
    const t = Number(/^t=(\d+),/.exec(String(delivery!.headers["vayada-signature"]))![1]);
    expect(delivery!.headers["vayada-signature"]).toBe(webhookSignature(secret, delivery!.body, t));
    expect(delivery!.headers["content-type"]).toBe("application/json");

    const event = JSON.parse(delivery!.body);
    expect(Object.keys(event).sort()).toEqual(["booking", "hotelId", "id", "occurredAt", "type"]);
    expect(event).toMatchObject({ type: "booking.confirmed", hotelId });
    expect(Object.keys(event.booking).sort()).toEqual([...BOOKING_KEYS].sort());
    expect(event.booking).toEqual({
      bookingId,
      reference: `VAY-${bookingId.slice(0, 8).toUpperCase()}`,
      version: 1,
      status: "confirmed",
      promoCode: "MIA10",
      promoCodeId,
      checkIn: "2026-12-01",
      checkOut: "2026-12-04",
      roomCount: 1,
      currency: "EUR",
      totalAmount: "420.00",
      extrasAmount: "30.00",
      discountAmount: "46.67",
      confirmedAt: expect.any(String),
      cancelledAt: null,
    });
    const row = await admin.query(
      "SELECT status, attempts_count FROM platform.outbox_events WHERE outbox_key = $1",
      [event.id],
    );
    expect(row.rows[0]).toEqual({ status: "published", attempts_count: 1 });
  });

  it("sends changes, a code taken off and a cancellation as the next versions", async () => {
    received.length = 0;
    const bookingId = await insertBooking("confirmed");
    await sweep();
    await admin.query("UPDATE booking.guest_bookings SET check_out = '2026-12-05' WHERE id = $1", [
      bookingId,
    ]);
    await sweep();
    await admin.query(
      "UPDATE booking.promo_applications SET application_status = 'reversed' WHERE guest_booking_id = $1",
      [bookingId],
    );
    await sweep();
    await admin.query(
      "UPDATE booking.guest_bookings SET lifecycle_status = 'canceled' WHERE id = $1",
      [bookingId],
    );
    await admin.query(
      `INSERT INTO booking.booking_status_events
         (guest_booking_id, event_type, from_status, to_status, actor_type)
       VALUES ($1, 'guest_booking.canceled', 'confirmed', 'canceled', 'guest')`,
      [bookingId],
    );
    await sweep();
    await deliver();
    const mine = events().filter((e) => e.booking?.bookingId === bookingId);
    expect(mine.map((e) => [e.type, e.booking!.version])).toEqual([
      ["booking.confirmed", 1],
      ["booking.changed", 2],
      ["booking.changed", 3],
      ["booking.cancelled", 4],
    ]);
    expect(mine[1]!.booking!.checkOut).toBe("2026-12-05");
    expect(mine[2]!.booking!).toMatchObject({
      promoCode: null,
      promoCodeId: null,
      discountAmount: "0.00",
    });
    expect(mine[3]!.booking!).toMatchObject({
      status: "cancelled",
      cancelledAt: expect.any(String),
    });
  });

  it("retries a failed send on the contract's schedule and marks it failed after the last try", async () => {
    received.length = 0;
    const bookingId = await insertBooking("confirmed");
    await sweep();
    answer = 500;
    expect(await deliver()).toEqual({ delivered: 0, retrying: 1, failed: [] });
    const outbox = async () =>
      (
        await admin.query(
          `SELECT status, attempts_count AS attempts, available_at AS "availableAt", outbox_metadata->>'lastOutcome' AS outcome
           FROM platform.outbox_events
           WHERE destination = 'partner_webhook' AND payload#>>'{booking,bookingId}' = $1`,
          [bookingId],
        )
      ).rows[0];
    const first = await outbox();
    expect(first).toMatchObject({ status: "pending", attempts: 1, outcome: "http_500" });
    expect(new Date(first.availableAt).getTime() - clock).toBeGreaterThanOrEqual(59_000);
    expect(await deliver()).toEqual({ delivered: 0, retrying: 0, failed: [] }); // not due yet

    clock += 61_000;
    answer = 200;
    expect(await deliver()).toEqual({ delivered: 1, retrying: 0, failed: [] });
    expect((await outbox()).status).toBe("published");

    // The last try: one attempt left, fails, and is marked failed where the team sees it.
    const other = await insertBooking("confirmed");
    await sweep();
    await admin.query(
      `UPDATE platform.outbox_events SET attempts_count = max_attempts - 1
       WHERE destination = 'partner_webhook' AND payload#>>'{booking,bookingId}' = $1`,
      [other],
    );
    answer = 503;
    const log = { error: vi.fn() };
    const result = await deliver(log);
    expect(result.failed).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ clientId, attempts: 17, outcome: "http_503" }),
      "Partner webhook event failed for good",
    );
    answer = 200;
  });

  it("sends connection.revoked when the hotel disconnects, and nothing after it", async () => {
    received.length = 0;
    const bookingId = await insertBooking("confirmed");
    const connection = (await connections.listConnections(hotelId))[0]!;
    await connections.disconnect({
      propertyId: hotelId,
      connectionId: connection.connectionId,
      userId: ownerId,
    });
    expect(await sweep()).toEqual({ queued: 0 });
    await deliver();
    expect(events().map((e) => e.type)).toEqual(["connection.revoked"]);
    expect(events()[0]).toEqual({
      id: expect.any(String),
      type: "connection.revoked",
      occurredAt: expect.any(String),
      hotelId,
    });
    expect(events().some((e) => e.booking?.bookingId === bookingId)).toBe(false);
  });
});
