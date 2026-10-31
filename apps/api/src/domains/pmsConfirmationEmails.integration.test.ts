import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createPmsConfirmationEmails } from "./pmsConfirmationEmails.js";
import {
  enqueueBookingLifecycleEmailJob,
  loadBookingNotificationSnapshot,
} from "../jobs/bookingEmails.js";
import { runBookingEmailDeliveryJobs } from "../jobs/bookingEmailDelivery.js";

import { loadTargetBooking } from "../routes/bookingWebPublic.js";

const url = process.env.TEST_DATABASE_URL;
const property = randomUUID();
const booking = randomUUID();
const actor = randomUUID();
describe.skipIf(!url)("confirmation resend with target PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: url });
  const emails = createPmsConfirmationEmails(url ?? "");
  beforeAll(async () => {
    if (
      !url ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
      !new URL(url).pathname.includes("test")
    )
      throw new Error("Use an isolated local test database");
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id, public_id, display_name) VALUES ($1::uuid, $1::text, 'Test Hotel')`,
      [property],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_locations(property_id, timezone) VALUES ($1, 'Europe/Berlin')`,
      [property],
    );
    await pool.query(
      `INSERT INTO identity.users(id, email) VALUES ($1::uuid, $1::text || '@example.test')`,
      [actor],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id, property_id, public_reference, lifecycle_status, check_in, check_out, currency, total_amount, balance_amount, booking_metadata)
      VALUES ($1::uuid,$2,$1::text,'confirmed','2026-10-01','2026-10-04','EUR',300,100,'{"paymentMethod":"pay_at_property"}')`,
      [booking, property],
    );
    await pool.query(
      `INSERT INTO booking.booking_guests(guest_booking_id, guest_role, first_name, last_name, email) VALUES ($1,'booker','Ada','Lovelace','old@example.test')`,
      [booking],
    );
    await pool.query(
      `INSERT INTO booking.booking_addon_selections(property_id, guest_booking_id, addon_snapshot, quantity, total_amount, currency) VALUES ($1,$2,'{"name":"Breakfast"}',2,30,'EUR')`,
      [property, booking],
    );
  });
  // Audit records are append-only; this suite requires a disposable local test database.
  afterAll(async () => {
    await emails.close();
    await pool.end();
  });
  // First in the file: platform.jobs must hold only the first email when it is analyzed (VAY-2426).
  it("claims one email job per statement, so a batch sends both queued emails", async () => {
    const otherBooking = randomUUID();
    await pool.query(
      `INSERT INTO booking.guest_bookings(id, property_id, public_reference, lifecycle_status, check_in, check_out, currency, total_amount, balance_amount, booking_metadata)
      VALUES ($1::uuid,$2,$1::text,'confirmed','2026-10-01','2026-10-04','EUR',300,100,'{"paymentMethod":"pay_at_property"}')`,
      [otherBooking, property],
    );
    await pool.query(
      `INSERT INTO booking.booking_guests(guest_booking_id, guest_role, first_name, last_name, email) VALUES ($1,'booker','Grace','Hopper','grace@example.test')`,
      [otherBooking],
    );
    const snapshot = (await loadBookingNotificationSnapshot(pool, {
      propertyId: property,
      guestBookingId: otherBooking,
    }))!;
    const enqueue = (resendKey: string) =>
      enqueueBookingLifecycleEmailJob(pool, {
        kind: "booking_accepted",
        occurredAt: new Date().toISOString(),
        booking: snapshot,
        resendKey,
      });
    await enqueue(`vay2426-first-${otherBooking}`);
    // Analyzed while it holds one job, PostgreSQL plans a claim that joins its LIMIT 1 candidate
    // as a nested loop, and that claim took both jobs (VAY-2398).
    await pool.query("ANALYZE platform.jobs");
    await enqueue(`vay2426-second-${otherBooking}`);
    const send = vi.fn(async () => {});
    expect(await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 2 })).toEqual({
      processed: 2,
      failed: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("sends current details once, attributes staff history, and preserves booking data on failure", async () => {
    await pool.query(
      `UPDATE booking.booking_guests SET email='updated@example.test' WHERE guest_booking_id=$1`,
      [booking],
    );
    await pool.query(
      `UPDATE booking.guest_bookings SET check_out='2026-10-05', total_amount=400 WHERE id=$1`,
      [booking],
    );
    const before = (
      await pool.query(`SELECT to_jsonb(b) AS data FROM booking.guest_bookings b WHERE id=$1`, [
        booking,
      ])
    ).rows;
    const requests = await Promise.all([
      emails.request(property, booking, "one", actor),
      emails.request(property, booking, "two", actor),
    ]);
    expect(requests[0]).toEqual(requests[1]);
    const jobId = (requests[0] as { jobId: string }).jobId;
    const send = vi.fn(async () => {});
    expect(await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({
        to: "updated@example.test",
        text: expect.stringContaining("Mon, 5 Oct 2026"),
      }),
    ]);
    const payload = (await pool.query(`SELECT payload FROM platform.jobs WHERE id=$1`, [jobId]))
      .rows[0].payload;
    for (const value of ["400.00 EUR", "Pay at the hotel", "Breakfast × 2"])
      expect(payload.text).toContain(value);
    // The hotel's time zone comes with the booking, for payment deadlines (VAY-2195).
    expect(
      (
        await loadBookingNotificationSnapshot(pool, {
          propertyId: property,
          guestBookingId: booking,
        })
      )?.propertyTimeZone,
    ).toBe("Europe/Berlin");
    expect(await emails.request(property, booking, "one", actor)).toEqual({ jobId });
    expect(await emails.request(property, booking, "two", actor)).toEqual({ jobId });
    expect(await emails.status(property, booking, jobId)).toEqual({ status: "succeeded" });
    expect(await emails.status(actor, booking, jobId)).toBeNull();
    const audit = await pool.query(
      `SELECT actor_user_id::text AS actor, redacted_payload FROM platform.product_audit_events WHERE job_id=$1 AND action='booking.confirmation.resent'`,
      [jobId],
    );
    expect(audit.rows).toEqual([
      {
        actor,
        redacted_payload: expect.objectContaining({
          description: "Confirmation email resent by staff",
        }),
      },
    ]);
    const failed = (await emails.request(property, booking, "three", actor)) as { jobId: string };
    expect(await emails.request(property, booking, "two", actor)).toEqual({ jobId });
    await pool.query(`UPDATE platform.jobs SET max_attempts=1 WHERE id=$1`, [failed.jobId]);
    expect(
      await runBookingEmailDeliveryJobs(
        url!,
        {
          send: async () => {
            throw new Error("Provider failure");
          },
        },
        { pool, limit: 1 },
      ),
    ).toEqual({ processed: 0, failed: 1 });
    expect(await emails.status(property, booking, failed.jobId)).toEqual({
      status: "dead_lettered",
    });
    expect(
      (
        await pool.query(`SELECT to_jsonb(b) AS data FROM booking.guest_bookings b WHERE id=$1`, [
          booking,
        ])
      ).rows,
    ).toEqual(before);
    await enqueueBookingLifecycleEmailJob(pool, {
      kind: "booking_accepted",
      occurredAt: new Date().toISOString(),
      booking: (await loadBookingNotificationSnapshot(pool, {
        propertyId: property,
        guestBookingId: booking,
      }))!,
    });
    await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 });
    const accepted = (await emails.request(property, booking, "accepted", actor)) as {
      jobId: string;
    };
    const acceptedPayload = (
      await pool.query(`SELECT payload FROM platform.jobs WHERE id=$1`, [accepted.jobId])
    ).rows[0].payload;
    expect(acceptedPayload.template).toBe("booking_accepted");
    expect(acceptedPayload.text).toContain("We've accepted your booking request");
    await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 });
    await pool.query(`UPDATE booking.booking_guests SET email='' WHERE guest_booking_id=$1`, [
      booking,
    ]);
    expect(await emails.request(property, booking, "invalid-email", actor)).toHaveProperty("error");
    expect(await emails.request(actor, booking, "wrong-property", actor)).toHaveProperty("error");
  });
  it("blocks unverified guest lookup, resend and already queued monetary delivery", async () => {
    await pool.query(
      "UPDATE booking.booking_guests SET email='guest@example.test' WHERE guest_booking_id=$1",
      [booking],
    );
    const queued = await emails.request(property, booking, "before-unverified", actor);
    expect(queued).toHaveProperty("jobId");
    await expect(
      loadTargetBooking(pool, property, booking, "guest@example.test"),
    ).resolves.toHaveProperty("guestBookingId", booking);
    await pool.query(
      'UPDATE booking.guest_bookings SET booking_metadata=booking_metadata || \'{"airbnbMoneyStatus":"unverified"}\'::jsonb WHERE id=$1',
      [booking],
    );
    await expect(
      loadTargetBooking(pool, property, booking, "guest@example.test"),
    ).rejects.toMatchObject({ statusCode: 404 });
    const before = (
      await pool.query("SELECT count(*)::int n FROM platform.jobs WHERE resource_id=$1", [booking])
    ).rows[0].n;
    expect(await emails.request(property, booking, "before-unverified", actor)).toHaveProperty(
      "error",
    );
    expect(await emails.request(property, booking, "after-unverified", actor)).toHaveProperty(
      "error",
    );
    expect(
      (
        await pool.query("SELECT count(*)::int n FROM platform.jobs WHERE resource_id=$1", [
          booking,
        ])
      ).rows[0].n,
    ).toBe(before);
    await pool.query("UPDATE platform.jobs SET max_attempts=1 WHERE id=$1", [
      (queued as { jobId: string }).jobId,
    ]);
    const send = vi.fn(async () => {});
    expect(await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 })).toEqual({
      processed: 0,
      failed: 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(await emails.status(property, booking, (queued as { jobId: string }).jobId)).toEqual({
      status: "dead_lettered",
    });
  });
  it("holds a booking fence through send before an import can mark money unverified", async () => {
    await pool.query(
      "UPDATE booking.guest_bookings SET booking_metadata=booking_metadata-'airbnbMoneyStatus' WHERE id=$1",
      [booking],
    );
    const queued = await emails.request(property, booking, "fenced-delivery", actor);
    expect(queued).toHaveProperty("jobId");
    let entered!: () => void;
    let releaseSend!: () => void;
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const finishSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const delivery = runBookingEmailDeliveryJobs(
      url!,
      {
        send: async () => {
          entered();
          await finishSend;
        },
      },
      { pool, limit: 1 },
    );
    const writer = await pool.connect();
    let update: Promise<unknown> | undefined;
    try {
      await sending;
      const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      update = writer.query(
        'UPDATE booking.guest_bookings SET booking_metadata=booking_metadata || \'{"airbnbMoneyStatus":"unverified"}\'::jsonb WHERE id=$1',
        [booking],
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 blocked", [pid]))
          .rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT booking_metadata->>'airbnbMoneyStatus' status FROM booking.guest_bookings WHERE id=$1",
            [booking],
          )
        ).rows[0].status,
      ).toBeNull();
      releaseSend();
      expect(await delivery).toEqual({ processed: 1, failed: 0 });
      await update;
      expect(
        (
          await pool.query(
            "SELECT booking_metadata->>'airbnbMoneyStatus' status FROM booking.guest_bookings WHERE id=$1",
            [booking],
          )
        ).rows[0].status,
      ).toBe("unverified");
    } finally {
      releaseSend();
      await delivery;
      await update;
      writer.release();
    }
  });
  it("tells the guest where they stay, from the property's place and the booked rooms (VAY-2322)", async () => {
    const garden = randomUUID();
    const villa = randomUUID();
    await pool.query(
      `UPDATE hotel_catalog.property_locations SET street_address='Marienplatz 1', area='Altstadt',
         postal_code='80331', city='Munich', country_code='DE', latitude=48.137154, longitude=11.576124,
         arrival_directions='Ring the bell at the side door.'
       WHERE property_id=$1`,
      [property],
    );
    await pool.query(
      `INSERT INTO pms.room_types(id, property_id, name, base_rate_amount, currency, room_attributes)
       VALUES ($1, $3, 'Garden Room', 100, 'EUR', '{"locationSource":"property"}'),
              ($2, $3, 'Beach Villa', 200, 'EUR',
               '{"locationSource":"custom","locationAddress":"Fraunhoferstraße 5","latitude":48.13,"longitude":11.57}')`,
      [garden, villa, property],
    );
    const booked = async (metadata: Record<string, unknown>) => {
      await pool.query(
        `UPDATE booking.guest_bookings
         SET booking_metadata = (booking_metadata - 'airbnbMoneyStatus' - 'pricingSelections'
           - 'selectedOffer') || $2::jsonb
         WHERE id=$1`,
        [booking, JSON.stringify(metadata)],
      );
      return loadBookingNotificationSnapshot(pool, {
        propertyId: property,
        guestBookingId: booking,
      });
    };
    const names = (snapshot: Awaited<ReturnType<typeof booked>>) =>
      snapshot?.bookedRooms.map((room) => room.name);

    // Two rooms of one type, booked on the booking page: one place.
    const snapshot = await booked({
      pricingSelections: [{ roomTypeId: garden }, { roomTypeId: garden }],
    });
    expect(snapshot).toMatchObject({
      propertyLocation: {
        streetAddress: "Marienplatz 1",
        area: "Altstadt",
        postalCode: "80331",
        city: "Munich",
        countryCode: "DE",
        latitude: 48.137154,
        longitude: 11.576124,
        arrivalDirections: "Ring the bell at the side door.",
      },
      bookedRooms: [{ name: "Garden Room", attributes: { locationSource: "property" } }],
    });
    // The older checkout's offer: every room line, else its one room.
    expect(
      names(
        await booked({
          selectedOffer: {
            roomTypeId: villa,
            roomLines: [{ roomTypeId: villa }, { roomTypeId: garden }],
          },
        }),
      ),
    ).toEqual(["Beach Villa", "Garden Room"]);
    expect(names(await booked({ selectedOffer: { roomTypeId: villa } }))).toEqual(["Beach Villa"]);
    // The PMS's rooms win once it has them; a canceled one is gone.
    await pool.query(
      `INSERT INTO pms.operational_booking_assignments
         (property_id, guest_booking_id, room_type_id, position, assignment_status, source, stay_evidence_kind)
       VALUES ($1, $2, $3, 1, 'canceled', 'migration', 'summary_only'),
              ($1, $2, $4, 2, 'pending', 'migration', 'summary_only')`,
      [property, booking, villa, garden],
    );
    const assigned = await booked({ pricingSelections: [{ roomTypeId: villa }] });
    expect(names(assigned)).toEqual(["Garden Room"]);

    const job = await enqueueBookingLifecycleEmailJob(pool, {
      kind: "final_confirmation",
      resendKey: `booking.confirmation.stay:${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      booking: assigned!,
    });
    const { payload } = (
      await pool.query(`SELECT payload FROM platform.jobs WHERE id=$1`, [job.jobId])
    ).rows[0];
    expect(payload.text).toContain(
      [
        "Where you'll stay:",
        "Test Hotel · Garden Room",
        "Marienplatz 1, Altstadt, 80331 Munich, Germany",
        "Arrival directions: Ring the bell at the side door.",
        "Open in Google Maps: https://www.google.com/maps/dir/?api=1&destination=48.137154,11.576124",
      ].join("\n"),
    );
  });
});
