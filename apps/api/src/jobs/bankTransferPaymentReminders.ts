import type pg from "pg";
import { enqueueBookingTransitionNotifications } from "./bookingEmails.js";

/** VAY-2348 D4: the guest is reminded this long before a booking-page bank transfer's deadline. */
export const BANK_TRANSFER_REMINDER_HOURS = 24;
const REMINDER_JOB_TYPE = "email.booking-payment-reminder";

/**
 * Reminds each booking-page bank transfer guest once, a day before the 48-hour deadline, while
 * the booking still waits for the money; the bank details are added when the email is sent. Runs
 * after the booking lifecycle sweep. Safe to run twice or on two servers at once: a booking
 * whose reminder job exists is skipped, its row is locked while it is checked again, and the
 * email job key is unique per booking.
 */
export async function runBankTransferPaymentReminders(
  pool: Pick<pg.Pool, "query" | "connect">,
  options: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const candidates = (
    await pool.query<{ guestBookingId: string; propertyId: string; deadline: string }>(
      `SELECT booking.id::text AS "guestBookingId", booking.property_id::text AS "propertyId",
         booking.deadline
       FROM (
         SELECT b.id, b.property_id, b.booking_metadata->>'pendingExpiresAt' AS deadline,
           CASE WHEN b.booking_metadata->>'pendingExpiresAt' ~ '^\\d{4}-\\d{2}-\\d{2}([T ]|$)'
             THEN (b.booking_metadata->>'pendingExpiresAt')::timestamptz END AS deadline_at
         FROM booking.guest_bookings b
         WHERE b.lifecycle_status = 'pending_payment' AND b.payment_status = 'unpaid'
           AND b.booking_metadata->>'targetSource' = 'pricing_quote_draft'
           AND b.booking_metadata->>'paymentMethod' = 'bank_transfer'
       ) booking
       WHERE booking.deadline_at > $1::timestamptz
         AND booking.deadline_at <= $1::timestamptz + make_interval(hours => $2::int)
         AND NOT EXISTS (
           SELECT 1 FROM platform.jobs job
           WHERE job.resource_product = 'booking' AND job.resource_type = 'guest_booking'
             AND job.resource_id = booking.id::text AND job.queue_name = 'platform.email'
             AND job.job_type = $3
         )
       ORDER BY booking.deadline_at
       LIMIT $4`,
      [now.toISOString(), BANK_TRANSFER_REMINDER_HOURS, REMINDER_JOB_TYPE, options.limit ?? 100],
    )
  ).rows;
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
      // Still waiting for this payment, and not being confirmed or expired right now.
      const locked = await client.query(
        `SELECT 1 FROM booking.guest_bookings
         WHERE id = $1::uuid AND property_id = $2::uuid AND lifecycle_status = 'pending_payment'
           AND payment_status = 'unpaid' AND booking_metadata->>'pendingExpiresAt' = $3
         FOR NO KEY UPDATE SKIP LOCKED`,
        [candidate.guestBookingId, candidate.propertyId, candidate.deadline],
      );
      if (locked.rows.length) {
        const queued = await enqueueBookingTransitionNotifications(client, {
          propertyId: candidate.propertyId,
          guestBookingId: candidate.guestBookingId,
          occurredAt: now.toISOString(),
          correlationId: `booking.payment-reminder:${now.toISOString()}`,
          actor: { type: "system" },
          source: "apps/api-bank-transfer-reminder",
          transition: {
            eventType: "guest_booking.payment_reminder",
            fromStatus: "pending_payment",
            toStatus: "pending_payment",
          },
          paymentDeadlineAt: candidate.deadline,
        });
        sent += queued.filter((job) => job.status === "queued").length;
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      failed += 1;
    } finally {
      client.release();
    }
  }
  return { scanned: candidates.length, sent, failed };
}
