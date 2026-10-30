import pg, { type QueryResultRow } from "pg";
import { normalizeNationalityCode } from "@vayada/locale-constants";
import { readGuestDataSettings } from "../platform/guestDataSettings.js";

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
 * stays. An email alone never joins two people (families share one), and a booking without a last
 * name (channel placeholders) never joins anyone. Of several candidates, the one matching both email
 * and phone wins; otherwise a new profile is made. Settings › Guest data (0528) can switch the email
 * or the phone part off per account. A profile with a single stay follows that stay's
 * name, so a placeholder that later gets the real name can still join the guest's profile.
 *
 * Values: the first time a direct booking's values reach a profile (booking engine, New Booking), they
 * overwrite it; later changes to that booking, and channel bookings, only fill empty fields, so an old
 * booking or a relay address never undoes newer details or a staff edit. An empty value never clears
 * one. Nationality comes from PMS bookings and additional guests only: the booking engine asks its
 * booker for the country of residence. Email and phone wait until the property may see them
 * (commission plan, request not accepted yet), the same rule as the reservation pages.
 */
export const GUEST_PROFILE_LINK_BATCH_SIZE = 50;
export const GUEST_PROFILE_LINK_INTERVAL_MS = 30_000;
// One writer of guest profiles at a time (linker runs across next-api tasks, staff edits), so two
// bookings of a new guest can't make two profiles and writers never wait on each other's rows.
const LINK_LOCK_SQL =
  "SELECT pg_try_advisory_xact_lock(hashtext('booking.guest_profile_links')) AS locked";

/** Every staff write to guest profiles takes this first, before any row lock. */
export async function lockGuestProfiles(client: GuestProfileQueryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('booking.guest_profile_links'))");
}
// Bookings that end without the property ever seeing the guest's contact.
const CLOSED_STATUSES = ["declined", "canceled", "expired", "completed", "no_show"];

/** The account a property's guests belong to: its one active owner, else the property itself. */
export const GUEST_ACCOUNT_SQL = (propertyId: string) => `COALESCE((
    SELECT CASE WHEN count(DISTINCT owner.organization_id) = 1
      THEN min(owner.organization_id::text) END
    FROM identity.organization_resource_links owner
    WHERE owner.product = 'hotel_catalog'
      AND owner.resource_type = 'property'
      AND lower(owner.resource_id) = (${propertyId})::text
      AND owner.relationship = 'owner'
      AND owner.status = 'active'
  ), (${propertyId})::text)::uuid`;
export const CONTACT_VISIBLE_SQL = `(${PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL} OR ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL})`;
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
  /** This booking's values reached the profile before (it was linked). */
  applied: boolean;
  /** Its email and phone reached the profile before (linked, and not waiting for visibility). */
  contactApplied: boolean;
};

export type GuestProfileQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

type PendingRow = Omit<GuestProfileSource, "applied" | "contactApplied"> & {
  bookingGuestId: string;
  guestProfileId: string | null;
  contactDeferred: boolean;
  firstName: string;
  lastName: string;
  nameKey: string;
  bookingStatus: string;
  accountId: string;
};

/** What a profile holds after applying one booking's values (null profile: a new one). */
export function profileValuesFromBooking(
  profile: GuestProfileValues | null,
  source: GuestProfileSource,
): GuestProfileValues {
  const direct = source.bookingChannel === "direct";
  const pick = (current: string | null, incoming: string | null, overwrite: boolean) =>
    incoming === null ? current : overwrite || current === null ? incoming : current;
  const current = profile ?? { email: null, phone: null, countryCode: null };
  const contact = direct && !source.contactApplied;
  return {
    email: source.contactVisible
      ? pick(current.email, clean(source.email), contact)
      : current.email,
    phone: source.contactVisible
      ? pick(current.phone, clean(source.phone), contact)
      : current.phone,
    countryCode:
      source.sourceSystem === "pms" || source.guestRole === "additional_guest"
        ? pick(
            current.countryCode,
            normalizeNationalityCode(source.countryCode),
            direct && !source.applied,
          )
        : current.countryCode,
  };
}

export type GuestProfileLinkStore = {
  /** Links or re-applies up to `limit` booking guests. */
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
  // Rows that failed wait for the next restart, so they can't block the rows behind them.
  const parked = new Set<string>();

  return {
    async linkBatch(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Guest profile link limit must be a positive integer");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '60s'");
        const lock = await client.query<{ locked: boolean }>(LINK_LOCK_SQL);
        if (!lock.rows[0]?.locked) {
          await client.query("ROLLBACK");
          return { linked: 0, failed: 0 };
        }
        const pending = await client.query<PendingRow>(PENDING_ROWS_SQL, [limit, [...parked]]);
        let linked = 0;
        let failed = 0;
        // One savepoint per row: a batch stays under PostgreSQL's 64 cached subtransactions.
        for (const row of pending.rows) {
          await client.query("SAVEPOINT guest_profile_link");
          try {
            await linkRow(client, row);
            await client.query("RELEASE SAVEPOINT guest_profile_link");
            linked += 1;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT guest_profile_link");
            parked.add(row.bookingGuestId);
            config.onRowError?.(row.bookingGuestId, error);
            failed += 1;
          }
        }
        await moveRecordedIdDetails(client);
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

/**
 * Links one booking guest now and returns its profile, for staff edits that need it at once (null
 * for a draft). Runs in the caller's transaction, after lockGuestProfiles.
 */
export async function linkBookingGuestNow(
  client: GuestProfileQueryable,
  bookingGuestId: string,
): Promise<string | null> {
  await lockGuestProfiles(client);
  const row = (
    await client.query<PendingRow>(
      `${ROW_SQL} AND guest.id = $1::uuid FOR NO KEY UPDATE OF guest`,
      [bookingGuestId],
    )
  ).rows[0];
  if (!row) return null;
  return row.guestProfileId ?? (await linkRow(client, row));
}

/**
 * Links a reservation's guests the job hasn't reached yet, so a form shows what a save compares
 * with and a booking made moments ago can be edited at once. Runs in the caller's transaction.
 */
export async function linkReservationGuestsNow(
  client: GuestProfileQueryable,
  propertyId: string,
  guestBookingId: string,
): Promise<void> {
  const unlinked = await client.query<{ id: string }>(
    `SELECT guest.id::text AS id FROM booking.booking_guests guest
     JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
     WHERE booking.property_id = $1::uuid AND booking.id = $2::uuid
       AND guest.guest_profile_id IS NULL`,
    [propertyId, guestBookingId],
  );
  for (const { id } of unlinked.rows) await linkBookingGuestNow(client, id);
}

/**
 * Gives a wrongly matched booking guest its own new profile, made from that booking's copy, and
 * returns it (null when the guest isn't linked or its booking is a draft). Runs in the caller's
 * transaction, after lockGuestProfiles.
 */
export async function separateBookingGuest(
  client: GuestProfileQueryable,
  bookingGuestId: string,
): Promise<string | null> {
  await lockGuestProfiles(client);
  const row = (
    await client.query<PendingRow>(
      `${ROW_SQL} AND guest.id = $1::uuid FOR NO KEY UPDATE OF guest`,
      [bookingGuestId],
    )
  ).rows[0];
  if (!row?.guestProfileId) return null;
  const profileId = await createProfile(client, row);
  await client.query(
    `UPDATE booking.booking_guests
     SET guest_profile_id = $2::uuid, guest_profile_link = 'separated',
         guest_profile_synced_at = updated_at,
         guest_profile_contact_deferred = $3
     WHERE id = $1::uuid`,
    [bookingGuestId, profileId, contactDeferred(row)],
  );
  return profileId;
}

/**
 * ID details check-in recorded per stay before they lived on the profile (VAY-2373) move to the
 * profile of a linked guest, newest first. They only fill: a document type and number stay a pair.
 */
async function moveRecordedIdDetails(client: GuestProfileQueryable): Promise<void> {
  const recorded = await client.query<{
    bookingGuestId: string;
    guestProfileId: string;
    dateOfBirth: string | null;
    documentType: string | null;
    documentNumber: string | null;
  }>(
    `SELECT registration.booking_guest_id::text AS "bookingGuestId",
            guest.guest_profile_id::text AS "guestProfileId",
            to_char(registration.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth",
            registration.document_type AS "documentType",
            registration.document_number AS "documentNumber"
     FROM pms.guest_registrations registration
     JOIN booking.booking_guests guest ON guest.id = registration.booking_guest_id
     WHERE guest.guest_profile_id IS NOT NULL
       AND (registration.date_of_birth IS NOT NULL OR registration.document_type IS NOT NULL
         OR registration.document_number IS NOT NULL)
     ORDER BY registration.updated_at DESC
     LIMIT 50
     FOR UPDATE OF registration SKIP LOCKED`,
  );
  for (const row of recorded.rows) {
    await client.query(
      `UPDATE booking.guest_profiles
       SET date_of_birth = COALESCE(date_of_birth, $2::date),
           document_type = CASE WHEN document_type IS NULL AND document_number IS NULL
             THEN $3 ELSE document_type END,
           document_number = CASE WHEN document_type IS NULL AND document_number IS NULL
             THEN $4 ELSE document_number END,
           updated_at = now()
       WHERE id = $1::uuid`,
      [row.guestProfileId, row.dateOfBirth, row.documentType, row.documentNumber],
    );
    await client.query(
      `UPDATE pms.guest_registrations
       SET date_of_birth = NULL, document_type = NULL, document_number = NULL, updated_at = now()
       WHERE booking_guest_id = $1::uuid`,
      [row.bookingGuestId],
    );
  }
}

const ROW_SQL = `
  SELECT guest.id::text AS "bookingGuestId",
         guest.guest_profile_id::text AS "guestProfileId",
         guest.guest_profile_contact_deferred AS "contactDeferred",
         guest.guest_role AS "guestRole",
         guest.first_name AS "firstName",
         guest.last_name AS "lastName",
         ${NAME_KEY_SQL("guest.first_name", "guest.last_name")} AS "nameKey",
         guest.email,
         guest.phone,
         guest.country_code AS "countryCode",
         booking.lifecycle_status AS "bookingStatus",
         booking.source_system AS "sourceSystem",
         booking.booking_channel AS "bookingChannel",
         ${CONTACT_VISIBLE_SQL} AS "contactVisible",
         ${GUEST_ACCOUNT_SQL("booking.property_id")} AS "accountId"
  FROM booking.booking_guests guest
  JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
  WHERE booking.lifecycle_status NOT IN ('draft', 'expired')`;

// Booking guests not linked yet, changed since their values were last applied, or holding contact
// details that became visible (or never will: their booking closed). The first condition is the
// partial index idx_booking_guests_profile_pending, so a run doesn't read the whole table. Drafts
// wait (an expired draft is deleted with its guests) and expired bookings never became stays. Older
// bookings go first, so the latest booking's values are the ones a profile ends up with.
const PENDING_ROWS_SQL = `${ROW_SQL}
    AND (guest.guest_profile_id IS NULL
      OR guest.guest_profile_synced_at IS DISTINCT FROM guest.updated_at
      OR guest.guest_profile_contact_deferred)
    AND (guest.guest_profile_id IS NULL
      OR guest.guest_profile_synced_at IS DISTINCT FROM guest.updated_at
      OR ${CONTACT_VISIBLE_SQL}
      OR booking.lifecycle_status IN (${CLOSED_STATUSES.map((status) => `'${status}'`).join(", ")}))
    AND NOT (guest.id = ANY($2::uuid[]))
  ORDER BY booking.created_at, guest.created_at, guest.id
  LIMIT $1
  FOR NO KEY UPDATE OF guest SKIP LOCKED`;

const MATCH_SQL = `
  WITH incoming AS (
    SELECT ${NAME_KEY_SQL("$2::text", "$3::text")} AS name_key,
           ${EMAIL_KEY_SQL("$4::text")} AS email_key,
           ${PHONE_KEY_SQL("$5::text")} AS phone_key
  ), candidates AS (
    SELECT profile.id,
           profile.created_at,
           $7::boolean AND incoming.email_key IS NOT NULL AND (
             ${EMAIL_KEY_SQL("profile.email")} = incoming.email_key
             OR EXISTS (
               SELECT 1 FROM booking.booking_guests stay
               WHERE stay.guest_profile_id = profile.id
                 AND ${EMAIL_KEY_SQL("stay.email")} = incoming.email_key
             )
           ) AS by_email,
           $8::boolean AND incoming.phone_key IS NOT NULL AND (
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
      AND profile.id IS DISTINCT FROM $6::uuid
  )
  SELECT id::text AS id, by_email AS "byEmail", by_phone AS "byPhone"
  FROM candidates
  WHERE by_email OR by_phone
  ORDER BY created_at, id
  LIMIT 10`;

type Link = "matched_email" | "matched_phone" | "created";

/** The profile this booking guest belongs to, if exactly one fits (see the matching rule above). */
async function findMatch(
  client: GuestProfileQueryable,
  row: PendingRow,
  exceptProfileId: string | null,
): Promise<{ id: string; link: Link } | null> {
  // A booking without a last name is a channel placeholder ("Guest"): never matched.
  if (!row.lastName.trim()) return null;
  // Settings › Guest data may switch matching by email or by phone off for the account.
  const { matching } = await readGuestDataSettings(client, row.accountId);
  if (!matching.email && !matching.phone) return null;
  const candidates = (
    await client.query<{ id: string; byEmail: boolean; byPhone: boolean }>(MATCH_SQL, [
      row.accountId,
      row.firstName,
      row.lastName,
      row.email,
      row.phone,
      exceptProfileId,
      matching.email,
      matching.phone,
    ])
  ).rows;
  const both = candidates.filter((candidate) => candidate.byEmail && candidate.byPhone);
  const match = candidates.length === 1 ? candidates[0] : both.length === 1 ? both[0] : undefined;
  return match ? { id: match.id, link: match.byEmail ? "matched_email" : "matched_phone" } : null;
}

async function linkRow(client: GuestProfileQueryable, row: PendingRow): Promise<string> {
  let profileId = row.guestProfileId;
  let link: Link | null = null;
  if (profileId) {
    const current = (
      await client.query<{ nameKey: string; stays: number }>(
        `SELECT profile.name_key AS "nameKey",
                (SELECT count(*)::int FROM booking.booking_guests stay
                 WHERE stay.guest_profile_id = profile.id) AS stays
         FROM booking.guest_profiles profile WHERE profile.id = $1::uuid FOR UPDATE`,
        [profileId],
      )
    ).rows[0];
    // A profile with this stay only follows the stay's name, then may join the guest's profile.
    if (current && current.stays === 1 && current.nameKey !== row.nameKey) {
      await client.query(
        `UPDATE booking.guest_profiles SET first_name = $2, last_name = $3, updated_at = now()
         WHERE id = $1::uuid`,
        [profileId, row.firstName.trim(), row.lastName.trim()],
      );
      const match = await findMatch(client, row, profileId);
      if (match) {
        await client.query(
          `UPDATE booking.guest_notes SET guest_profile_id = $2::uuid
           WHERE guest_profile_id = $1::uuid`,
          [profileId, match.id],
        );
        await client.query(
          `UPDATE booking.booking_guests SET guest_profile_id = $2::uuid, guest_profile_link = $3
           WHERE id = $1::uuid`,
          [row.bookingGuestId, match.id, match.link],
        );
        await client.query("DELETE FROM booking.guest_profiles WHERE id = $1::uuid", [profileId]);
        profileId = match.id;
        link = match.link;
      }
    }
  } else {
    const match = await findMatch(client, row, null);
    profileId = match ? match.id : await createProfile(client, row);
    link = match ? match.link : "created";
  }
  if (link !== "created") {
    // A booking moved to another profile brings its values there for the first time.
    const fresh = link !== null;
    const current = (
      await client.query<GuestProfileValues>(
        `SELECT email, phone, country_code AS "countryCode"
         FROM booking.guest_profiles WHERE id = $1::uuid FOR UPDATE`,
        [profileId],
      )
    ).rows[0];
    if (!current) throw new Error("Guest profile disappeared while linking");
    const after = profileValuesFromBooking(current, {
      ...row,
      applied: !fresh,
      contactApplied: !fresh && !row.contactDeferred,
    });
    if (
      after.email !== current.email ||
      after.phone !== current.phone ||
      after.countryCode !== current.countryCode
    ) {
      await client.query(
        `UPDATE booking.guest_profiles
         SET email = $2, phone = $3, country_code = $4, updated_at = now()
         WHERE id = $1::uuid`,
        [profileId, after.email, after.phone, after.countryCode],
      );
    }
  }
  // updated_at stays as it is: the copy wasn't changed, only linked.
  await client.query(
    `UPDATE booking.booking_guests
     SET guest_profile_id = $2::uuid,
         guest_profile_link = COALESCE($3, guest_profile_link),
         guest_profile_synced_at = updated_at,
         guest_profile_contact_deferred = $4
     WHERE id = $1::uuid`,
    [row.bookingGuestId, profileId, link, contactDeferred(row)],
  );
  return profileId;
}

async function createProfile(client: GuestProfileQueryable, row: PendingRow): Promise<string> {
  const values = profileValuesFromBooking(null, { ...row, applied: false, contactApplied: false });
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
  return created.rows[0]!.id;
}

// Email or phone the property may not see yet: applied once it may. A booking that closed without
// that never will be.
function contactDeferred(row: PendingRow): boolean {
  return (
    !row.contactVisible &&
    !CLOSED_STATUSES.includes(row.bookingStatus) &&
    (clean(row.email) !== null || clean(row.phone) !== null)
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
      // A batch with nothing linked ends the run; its failed rows are parked for the next one.
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
