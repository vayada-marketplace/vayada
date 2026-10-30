import { randomUUID } from "node:crypto";

import pg from "pg";

import { GUEST_ACCOUNT_SQL, lockGuestProfiles } from "./bookingGuestProfileLinks.js";

/**
 * VAY-2420: Settings › Guest data's "Delete identity documents" (migration 0528). When an account
 * keeps ID documents for 7, 30 or 90 days after check-out, document type and number are removed from
 * a guest profile once that many days have passed since the guest's last stay ended and the guest has
 * no current or upcoming stay. A check-in registration that still holds them (its guest not linked
 * yet) loses them on the same rule for its own stay. Date of birth, contact, nationality, notes and
 * stays are kept. Each removal is audited with the field names, never the values. Accounts that keep
 * documents (the default) are never touched.
 */
export const GUEST_IDENTITY_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_GUEST_IDENTITY_RETENTION_BATCH_SIZE = 200;

// Bookings that are or were a stay; cancelled, declined, expired and draft ones don't hold documents back.
const STAY_STATUSES = ["pending_payment", "confirmed", "completed", "no_show"];
const RETENTION_DAYS_SQL = `CASE WHEN settings.settings->>'identityRetentionDays' IN ('7', '30', '90')
  THEN (settings.settings->>'identityRetentionDays')::int END`;

export type GuestIdentityRetentionStore = {
  /** Removes expired ID documents (up to `limit` profiles and registrations each); returns counts. */
  removeExpiredBatch(
    today: string,
    limit: number,
  ): Promise<{ profiles: number; registrations: number }>;
  close(): Promise<void>;
};

export function createPgGuestIdentityRetentionStore(config: {
  connectionString: string;
  max?: number;
}): GuestIdentityRetentionStore {
  if (!config.connectionString.trim())
    throw new Error("Guest identity retention connectionString must not be empty");
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async removeExpiredBatch(today, limit) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The same lock as every other guest profile writer (linker, staff edits).
        await client.query("SET LOCAL lock_timeout = '10s'");
        await lockGuestProfiles(client);
        const profiles = await client.query<{ cleared: number }>(
          `WITH expired AS (
             SELECT profile.id, days.retention_days,
                    (SELECT booking.property_id FROM booking.booking_guests stay
                     JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
                     WHERE stay.guest_profile_id = profile.id
                     ORDER BY booking.check_out DESC, booking.id LIMIT 1) AS property_id
             FROM booking.guest_profiles profile
             JOIN booking.guest_data_settings settings ON settings.account_id = profile.account_id
             CROSS JOIN LATERAL (SELECT ${RETENTION_DAYS_SQL} AS retention_days) days
             WHERE days.retention_days IS NOT NULL
               AND (profile.document_type IS NOT NULL OR profile.document_number IS NOT NULL)
               AND NOT EXISTS (
                 SELECT 1 FROM booking.booking_guests stay
                 JOIN booking.guest_bookings booking ON booking.id = stay.guest_booking_id
                 WHERE stay.guest_profile_id = profile.id
                   AND booking.lifecycle_status = ANY($3::text[])
                   AND booking.check_out + days.retention_days > $1::date
               )
             ORDER BY profile.id
             LIMIT $2
             FOR UPDATE OF profile SKIP LOCKED
           ), cleared AS (
             UPDATE booking.guest_profiles profile
             SET document_type = NULL, document_number = NULL, updated_at = now()
             FROM expired WHERE profile.id = expired.id
             RETURNING profile.id, expired.property_id, expired.retention_days
           ), audited AS (
             INSERT INTO platform.product_audit_events (
               audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
               target_resource_product, target_resource_type, target_resource_id,
               redacted_payload, audit_metadata, privacy_scope
             )
             SELECT $4 || cleared.id::text, 'pms', 'pms.guest_profile.identity_removed', now(),
               'property', cleared.property_id, 'system', 'booking', 'guest_profile',
               cleared.id::text,
               jsonb_build_object('fields', jsonb_build_array('documentType', 'documentNumber'),
                 'retentionDays', cleared.retention_days),
               jsonb_build_object('source', 'apps/api-guest-identity-retention'), 'confidential'
             FROM cleared WHERE cleared.property_id IS NOT NULL
           )
           SELECT count(*)::int AS cleared FROM cleared`,
          [today, limit, STAY_STATUSES, `guest-identity-retention:${randomUUID()}:`],
        );
        const registrations = await client.query<{ cleared: number }>(
          `WITH expired AS (
             SELECT registration.booking_guest_id
             FROM pms.guest_registrations registration
             JOIN booking.guest_bookings booking ON booking.id = registration.guest_booking_id
             JOIN booking.guest_data_settings settings
               ON settings.account_id = ${GUEST_ACCOUNT_SQL("registration.property_id")}
             CROSS JOIN LATERAL (SELECT ${RETENTION_DAYS_SQL} AS retention_days) days
             WHERE days.retention_days IS NOT NULL
               AND (registration.document_type IS NOT NULL OR registration.document_number IS NOT NULL)
               AND booking.check_out + days.retention_days <= $1::date
             ORDER BY registration.booking_guest_id
             LIMIT $2
             FOR UPDATE OF registration SKIP LOCKED
           ), cleared AS (
             UPDATE pms.guest_registrations registration
             SET document_type = NULL, document_number = NULL, updated_at = now()
             FROM expired WHERE registration.booking_guest_id = expired.booking_guest_id
             RETURNING registration.booking_guest_id
           )
           SELECT count(*)::int AS cleared FROM cleared`,
          [today, limit],
        );
        await client.query("COMMIT");
        return {
          profiles: profiles.rows[0]?.cleared ?? 0,
          registrations: registrations.rows[0]?.cleared ?? 0,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

type RetentionLogger = {
  info(context: { profiles: number; registrations: number }, message: string): void;
  error(context: { err: unknown }, message: string): void;
};

export function startGuestIdentityRetentionWorker(options: {
  store: GuestIdentityRetentionStore;
  enabled: boolean;
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  logger: RetentionLogger;
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? DEFAULT_GUEST_IDENTITY_RETENTION_BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const drain = async () => {
    const today = now().toISOString().slice(0, 10);
    const total = { profiles: 0, registrations: 0 };
    for (;;) {
      const removed = await options.store.removeExpiredBatch(today, batchSize);
      total.profiles += removed.profiles;
      total.registrations += removed.registrations;
      if (closing || (removed.profiles < batchSize && removed.registrations < batchSize)) break;
    }
    if (total.profiles || total.registrations)
      options.logger.info(total, "Removed expired guest ID documents");
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= drain()
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "Guest identity retention failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled
    ? setInterval(() => void runNow(), options.intervalMs ?? GUEST_IDENTITY_RETENTION_INTERVAL_MS)
    : undefined;
  timer?.unref();
  if (options.enabled) void runNow();

  return {
    runNow,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await activeRun;
      await options.store.close();
    },
  };
}
