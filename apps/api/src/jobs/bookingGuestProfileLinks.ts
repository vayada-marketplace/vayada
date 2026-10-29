import pg from "pg";
import { normalizeNationalityCode } from "@vayada/locale-constants";

import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL,
} from "../domains/bookingGuestContactAccess.js";

/**
 * VAY-2420: links every booking guest to one guest profile per person and account (migration 0527)
 * and copies the booking's values onto it. It runs in the background, so no booking path changes:
 * existing bookings, a booking that leaves draft, a channel modification or a request the property
 * accepts are all picked up on the next run.
 *
 * Matching: same account and same name, plus the same email or phone as the profile or one of its
 * stays. An email alone never joins two people (families share one), a booking without a last name
 * (channel placeholders) never joins anyone, and more than one candidate makes a new profile.
 *
 * Values: direct bookings (booking engine, New Booking) overwrite with what they hold; channel
 * bookings only fill empty fields, so relay addresses never replace what the desk collected. An empty
 * value never clears one. Nationality comes from PMS bookings and additional guests only: the booking
 * engine asks its booker for the country of residence. Email and phone wait until the property may see
 * them (commission plan, request not accepted yet), the same rule as the reservation pages.
 */
export const GUEST_PROFILE_LINK_BATCH_SIZE = 100;
export const GUEST_PROFILE_LINK_INTERVAL_MS = 30_000;
// One run at a time across next-api tasks, so two bookings of a new guest can't make two profiles.
const SWEEP_LOCK_KEY = "booking.guest_profile_links";

const CONTACT_VISIBLE_SQL = `(${PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL} OR ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL})`;
const NAME_KEY_SQL = (first: string, last: string) =>
  `lower(regexp_replace(btrim(${first} || ' ' || ${last}), '\\s+', ' ', 'g'))`;
const EMAIL_KEY_SQL = (value: string) =>
  `CASE WHEN btrim(${value}) LIKE '%_@_%' THEN lower(btrim(${value})) END`;
// "+" and digits once spaces, dots, dashes and brackets are gone ("00" counts as "+"); anything else
// gives no key, so local numbers never match across countries.
const PHONE_KEY_SQL = (value: string) => {
  const digits = `regexp_replace(regexp_replace(${value}, '[\\s().-]', '', 'g'), '^00', '+')`;
  return `CASE WHEN ${digits} ~ '^\\+[1-9][0-9]{6,14}$' THEN ${digits} END`;
};

export type GuestProfileValues = {
  email: string | null;
  phone: string | null;
  countryCode: string | null;
};

export type GuestProfileSource = {
  guestRole: string;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  sourceSystem: string;
  bookingChannel: string;
  contactVisible: boolean;
};

type PendingRow = GuestProfileSource & {
  bookingGuestId: string;
  guestProfileId: string | null;
  firstName: string;
  lastName: string;
  accountId: string;
};

/** What a profile holds after applying one booking's values (null profile: a new one). */
export function profileValuesFromBooking(
  profile: GuestProfileValues | null,
  source: GuestProfileSource,
): GuestProfileValues {
  const direct = source.bookingChannel === "direct";
  const pick = (current: string | null, incoming: string | null) =>
    incoming === null ? current : direct || current === null ? incoming : current;
  const current = profile ?? { email: null, phone: null, countryCode: null };
  return {
    email: source.contactVisible ? pick(current.email, clean(source.email)) : current.email,
    phone: source.contactVisible ? pick(current.phone, clean(source.phone)) : current.phone,
    countryCode:
      source.sourceSystem === "pms" || source.guestRole === "additional_guest"
        ? pick(current.countryCode, normalizeNationalityCode(source.countryCode))
        : current.countryCode,
  };
}

export type GuestProfileLinkStore = {
  /** Links or re-applies up to `limit` booking guests; failed rows are retried on the next run. */
  linkBatch(limit: number): Promise<{ linked: number; failed: number }>;
  close(): Promise<void>;
};

export function createPgGuestProfileLinkStore(config: {
  connectionString: string;
  max?: number;
  onRowError?: (bookingGuestId: string, error: unknown) => void;
}): GuestProfileLinkStore {
  if (!config.connectionString.trim()) {
    throw new Error("Guest profile link connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async linkBatch(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Guest profile link limit must be a positive integer");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
          [SWEEP_LOCK_KEY],
        );
        if (!lock.rows[0]?.locked) {
          await client.query("ROLLBACK");
          return { linked: 0, failed: 0 };
        }
        const pending = await client.query<PendingRow>(PENDING_ROWS_SQL, [limit]);
        let linked = 0;
        let failed = 0;
        for (const row of pending.rows) {
          await client.query("SAVEPOINT guest_profile_link");
          try {
            await linkRow(client, row);
            await client.query("RELEASE SAVEPOINT guest_profile_link");
            linked += 1;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT guest_profile_link");
            config.onRowError?.(row.bookingGuestId, error);
            failed += 1;
          }
        }
        await client.query("COMMIT");
        return { linked, failed };
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

// Booking guests not linked yet, changed since their values were last applied, or holding contact
// details that became visible. Drafts wait: an expired draft is deleted with its guests. Older
// bookings go first, so the latest booking's values are the ones a profile ends up with.
const PENDING_ROWS_SQL = `
  SELECT guest.id::text AS "bookingGuestId",
         guest.guest_profile_id::text AS "guestProfileId",
         guest.guest_role AS "guestRole",
         guest.first_name AS "firstName",
         guest.last_name AS "lastName",
         guest.email,
         guest.phone,
         guest.country_code AS "countryCode",
         booking.source_system AS "sourceSystem",
         booking.booking_channel AS "bookingChannel",
         ${CONTACT_VISIBLE_SQL} AS "contactVisible",
         COALESCE((
           SELECT CASE WHEN count(*) = 1 THEN min(owner.organization_id::text) END
           FROM identity.organization_resource_links owner
           WHERE owner.product = 'hotel_catalog'
             AND owner.resource_type = 'property'
             AND lower(owner.resource_id) = booking.property_id::text
             AND owner.relationship = 'owner'
             AND owner.status = 'active'
         ), booking.property_id::text) AS "accountId"
  FROM booking.booking_guests guest
  JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
  WHERE booking.lifecycle_status NOT IN ('draft', 'expired')
    AND (
      guest.guest_profile_id IS NULL
      OR guest.guest_profile_synced_at IS DISTINCT FROM guest.updated_at
      OR (guest.guest_profile_contact_deferred AND ${CONTACT_VISIBLE_SQL})
    )
  ORDER BY booking.created_at, guest.created_at, guest.id
  LIMIT $1
  FOR UPDATE OF guest SKIP LOCKED`;

const MATCH_SQL = `
  WITH incoming AS (
    SELECT ${NAME_KEY_SQL("$2::text", "$3::text")} AS name_key,
           ${EMAIL_KEY_SQL("$4::text")} AS email_key,
           ${PHONE_KEY_SQL("$5::text")} AS phone_key
  ), candidates AS (
    SELECT profile.id,
           profile.created_at,
           incoming.email_key IS NOT NULL AND (
             ${EMAIL_KEY_SQL("profile.email")} = incoming.email_key
             OR EXISTS (
               SELECT 1 FROM booking.booking_guests stay
               WHERE stay.guest_profile_id = profile.id
                 AND ${EMAIL_KEY_SQL("stay.email")} = incoming.email_key
             )
           ) AS by_email,
           incoming.phone_key IS NOT NULL AND (
             ${PHONE_KEY_SQL("profile.phone")} = incoming.phone_key
             OR EXISTS (
               SELECT 1 FROM booking.booking_guests stay
               WHERE stay.guest_profile_id = profile.id
                 AND ${PHONE_KEY_SQL("stay.phone")} = incoming.phone_key
             )
           ) AS by_phone
    FROM booking.guest_profiles profile, incoming
    WHERE profile.account_id = $1::uuid
      AND profile.name_key = incoming.name_key
  )
  SELECT id::text AS id, by_email AS "byEmail"
  FROM candidates
  WHERE by_email OR by_phone
  ORDER BY created_at, id
  LIMIT 2`;

async function linkRow(client: pg.PoolClient, row: PendingRow): Promise<void> {
  let profileId = row.guestProfileId;
  let link: "matched_email" | "matched_phone" | "created" | null = null;
  if (!profileId) {
    // A booking without a last name is a channel placeholder ("Guest"): never matched.
    const matches = row.lastName.trim()
      ? (
          await client.query<{ id: string; byEmail: boolean }>(MATCH_SQL, [
            row.accountId,
            row.firstName,
            row.lastName,
            row.email,
            row.phone,
          ])
        ).rows
      : [];
    if (matches.length === 1) {
      profileId = matches[0]!.id;
      link = matches[0]!.byEmail ? "matched_email" : "matched_phone";
    } else {
      const values = profileValuesFromBooking(null, row);
      const created = await client.query<{ id: string }>(
        `INSERT INTO booking.guest_profiles
           (account_id, first_name, last_name, email, phone, country_code)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)
         RETURNING id::text`,
        [
          row.accountId,
          row.firstName.trim(),
          row.lastName.trim(),
          values.email,
          values.phone,
          values.countryCode,
        ],
      );
      profileId = created.rows[0]!.id;
      link = "created";
    }
  }
  if (link !== "created") {
    const current = await client.query<GuestProfileValues>(
      `SELECT email, phone, country_code AS "countryCode"
       FROM booking.guest_profiles WHERE id = $1::uuid FOR UPDATE`,
      [profileId],
    );
    const before = current.rows[0]!;
    const after = profileValuesFromBooking(before, row);
    if (
      after.email !== before.email ||
      after.phone !== before.phone ||
      after.countryCode !== before.countryCode
    ) {
      await client.query(
        `UPDATE booking.guest_profiles
         SET email = $2, phone = $3, country_code = $4, updated_at = now()
         WHERE id = $1::uuid`,
        [profileId, after.email, after.phone, after.countryCode],
      );
    }
  }
  const contactDeferred =
    !row.contactVisible && (clean(row.email) !== null || clean(row.phone) !== null);
  // updated_at stays as it is: the copy wasn't changed, only linked.
  await client.query(
    `UPDATE booking.booking_guests
     SET guest_profile_id = $2::uuid,
         guest_profile_link = COALESCE(guest_profile_link, $3),
         guest_profile_synced_at = updated_at,
         guest_profile_contact_deferred = $4
     WHERE id = $1::uuid`,
    [row.bookingGuestId, profileId, link, contactDeferred],
  );
}

export function startGuestProfileLinkWorker(options: {
  store: GuestProfileLinkStore;
  enabled: boolean;
  intervalMs?: number;
  batchSize?: number;
  logger: {
    info(context: { linked: number; failed: number }, message: string): void;
    error(context: { err: unknown }, message: string): void;
  };
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? GUEST_PROFILE_LINK_BATCH_SIZE;
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const drain = async () => {
    let linked = 0;
    let failed = 0;
    for (;;) {
      const batch = await options.store.linkBatch(batchSize);
      linked += batch.linked;
      failed += batch.failed;
      // A batch with nothing linked stops the run, so rows that keep failing can't loop forever.
      if (closing || batch.linked === 0 || batch.linked + batch.failed < batchSize) break;
    }
    if (linked > 0 || failed > 0)
      options.logger.info({ linked, failed }, "Linked booking guests to guest profiles");
  };
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    activeRun ??= drain()
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "Guest profile linking failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled
    ? setInterval(() => void runNow(), options.intervalMs ?? GUEST_PROFILE_LINK_INTERVAL_MS)
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

function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
