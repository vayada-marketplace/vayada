import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgGuestProfileLinkStore,
  startGuestProfileLinkWorker,
  type GuestProfileLinkStore,
} from "./bookingGuestProfileLinks.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PREFIX = "vay-2420-";

type Booking = {
  source?: "pms" | "booking";
  channel?: "direct" | "booking_com";
  status?: string;
  accepted?: boolean;
  createdAt?: string;
};
type Guest = {
  role?: "booker" | "additional_guest";
  first: string;
  last: string;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
};

// VAY-2420: next-api links booking guests to guest profiles as `vayada_next_api_runtime`, so the
// sweep runs through the test login shaped like that role. It links every pending row in the
// database (other suites' rows too); the assertions only look at this suite's properties.
describe.skipIf(!TEST_DATABASE_URL)("Guest profile links (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const accountId = randomUUID();
  const [propertyA, propertyB, propertyAlone] = [randomUUID(), randomUUID(), randomUUID()];
  const rowErrors: unknown[] = [];
  let fixture: HotelSetupOrdinaryLoginFixture;
  let store: GuestProfileLinkStore;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanup(admin);
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Guest profile hotels', $2, 'active')`,
      [accountId, `${PREFIX}${accountId}`],
    );
    for (const id of [propertyA, propertyB, propertyAlone])
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $2, 'Guest profiles')`,
        [id, `${PREFIX}${id}`],
      );
    for (const id of [propertyA, propertyB])
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [accountId, id],
      );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    store = createPgGuestProfileLinkStore({
      connectionString: fixture.connectionString,
      onRowError: (_id, error) => rowErrors.push(error),
    });
  });

  afterAll(async () => {
    try {
      await store?.close();
      if (fixture) {
        await waitForSessionsToEnd(admin, fixture.login);
        await fixture.drop();
      }
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanup(admin);
      }
    } finally {
      await admin.end();
    }
  });

  const sweep = async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startGuestProfileLinkWorker({
      store: { linkBatch: (limit) => store.linkBatch(limit), close: async () => undefined },
      enabled: false,
      batchSize: 50,
      logger,
    });
    await worker.runNow();
    expect(logger.error).not.toHaveBeenCalled();
  };

  const book = async (propertyId: string, booking: Booking, ...guests: Guest[]) => {
    const id = randomUUID();
    const source = booking.source ?? "pms";
    const channel = booking.channel ?? "direct";
    await admin.query(
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, source_system, source_booking_id, lifecycle_status,
          check_in, check_out, adults, currency, total_amount, balance_amount, booking_metadata,
          booking_channel, direct_booking_source, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $3, $5, '2027-08-15', '2027-08-19', 2, 'EUR', 600, 600,
         '{}'::jsonb, $6, $7, COALESCE($8::timestamptz, now()))`,
      [
        id,
        propertyId,
        `${PREFIX}${id}`,
        source,
        booking.status ?? "confirmed",
        channel,
        channel === "direct" ? (source === "booking" ? "booking_engine" : "walk_in") : null,
        booking.createdAt ?? null,
      ],
    );
    if (booking.accepted ?? true) await accept(id);
    const ids: string[] = [];
    for (const guest of guests) {
      const row = await admin.query<{ id: string }>(
        `INSERT INTO booking.booking_guests
           (guest_booking_id, guest_role, first_name, last_name, email, phone, country_code)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
        [
          id,
          guest.role ?? (ids.length ? "additional_guest" : "booker"),
          guest.first,
          guest.last,
          guest.email ?? null,
          guest.phone ?? null,
          guest.country ?? null,
        ],
      );
      ids.push(row.rows[0]!.id);
    }
    return { bookingId: id, guestIds: ids };
  };

  const accept = (bookingId: string) =>
    admin.query(
      `INSERT INTO booking.booking_status_events
         (guest_booking_id, event_type, from_status, to_status, actor_type)
       VALUES ($1::uuid, 'guest_booking.accepted', NULL, 'confirmed', 'property_user')`,
      [bookingId],
    );

  const link = async (bookingGuestId: string) =>
    (
      await admin.query<{
        profileId: string | null;
        link: string | null;
        deferred: boolean;
        synced: boolean;
        accountId: string | null;
        firstName: string | null;
        email: string | null;
        phone: string | null;
        countryCode: string | null;
      }>(
        `SELECT guest.guest_profile_id::text AS "profileId", guest.guest_profile_link AS link,
                guest.guest_profile_contact_deferred AS deferred,
                guest.guest_profile_synced_at = guest.updated_at AS synced,
                profile.account_id::text AS "accountId", profile.first_name AS "firstName",
                profile.email, profile.phone, profile.country_code AS "countryCode"
         FROM booking.booking_guests guest
         LEFT JOIN booking.guest_profiles profile ON profile.id = guest.guest_profile_id
         WHERE guest.id = $1::uuid`,
        [bookingGuestId],
      )
    ).rows[0]!;

  it("lets the API login write profiles and link booking guests", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT has_table_privilege($1, 'booking.guest_profiles', 'INSERT') AS "insert",
              has_table_privilege($1, 'booking.guest_profiles', 'UPDATE') AS "update",
              has_column_privilege($1, 'booking.booking_guests', 'guest_profile_id', 'UPDATE')
                AS "link"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({ insert: true, update: true, link: true });
  });

  it("joins stays of one person across the account's properties, by email or by phone", async () => {
    const first = await book(
      propertyA,
      { createdAt: "2026-01-01T00:00:00Z" },
      { first: "Timo", last: "Schreyer", email: "Timo@Example.test ", country: "DE" },
    );
    const second = await book(
      propertyB,
      { source: "booking", createdAt: "2026-02-01T00:00:00Z" },
      { first: " timo", last: "SCHREYER ", email: "timo@example.test", phone: "+49 151 2345-6789" },
    );
    const third = await book(
      propertyA,
      { createdAt: "2026-03-01T00:00:00Z" },
      { first: "Timo", last: "Schreyer", email: "other@example.test", phone: "0049151 23456789" },
    );
    await sweep();

    const [a, b, c] = await Promise.all(
      [first, second, third].map(({ guestIds }) => link(guestIds[0]!)),
    );
    expect(a).toMatchObject({ link: "created", accountId, firstName: "Timo", synced: true });
    expect(b).toMatchObject({ profileId: a.profileId, link: "matched_email" });
    expect(c).toMatchObject({ profileId: a.profileId, link: "matched_phone" });
    // The latest direct booking's values win; the booking engine's country (residence) is not used.
    expect(c).toMatchObject({
      email: "other@example.test",
      phone: "0049151 23456789",
      countryCode: "DE",
    });
  });

  it("keeps people apart who only share an email, and channel placeholders apart", async () => {
    const parent = await book(
      propertyA,
      {},
      { first: "Anna", last: "Berg", email: "family@example.test" },
      { first: "Lena", last: "Berg", email: "family@example.test" },
    );
    const placeholders = await Promise.all(
      [1, 2].map(() =>
        book(
          propertyA,
          { channel: "booking_com" },
          { first: "Guest", last: "", email: "relay@guest.booking.test" },
        ),
      ),
    );
    await sweep();

    const [anna, lena] = await Promise.all(parent.guestIds.map(link));
    expect(anna!.profileId).not.toBe(lena!.profileId);
    const [p1, p2] = await Promise.all(placeholders.map(({ guestIds }) => link(guestIds[0]!)));
    expect(p1).toMatchObject({ link: "created" });
    expect(p2).toMatchObject({ link: "created" });
    expect(p1!.profileId).not.toBe(p2!.profileId);
  });

  it("keeps a property without one owner in its own account", async () => {
    const elsewhere = await book(
      propertyAlone,
      {},
      { first: "Timo", last: "Schreyer", email: "timo@example.test" },
    );
    await sweep();
    expect(await link(elsewhere.guestIds[0]!)).toMatchObject({
      link: "created",
      accountId: propertyAlone,
    });
  });

  it("lets channel bookings only fill gaps, also when they change later", async () => {
    const desk = await book(
      propertyA,
      { createdAt: "2026-04-01T00:00:00Z" },
      { first: "Mia", last: "Kurz", email: "mia@example.test" },
    );
    const ota = await book(
      propertyB,
      { channel: "booking_com", createdAt: "2026-05-01T00:00:00Z" },
      { first: "Mia", last: "Kurz", email: "mia@example.test", phone: "+43 660 1234567" },
    );
    await sweep();
    expect(await link(ota.guestIds[0]!)).toMatchObject({
      link: "matched_email",
      email: "mia@example.test",
      phone: "+43 660 1234567",
    });

    // A channel modification with a relay address is re-applied but doesn't replace the email.
    await admin.query(
      `UPDATE booking.booking_guests SET email = 'k9@guest.booking.test', updated_at = now()
       WHERE id = $1::uuid`,
      [ota.guestIds[0]],
    );
    await sweep();
    expect(await link(ota.guestIds[0]!)).toMatchObject({
      synced: true,
      email: "mia@example.test",
    });
    expect((await link(desk.guestIds[0]!)).profileId).toBe(
      (await link(ota.guestIds[0]!)).profileId,
    );
  });

  it("links a request at once but copies its email and phone only after it is accepted", async () => {
    const request = await book(
      propertyA,
      { source: "booking", accepted: false },
      { first: "Noah", last: "Weiss", email: "noah@example.test", phone: "+41791234567" },
    );
    await sweep();
    expect(await link(request.guestIds[0]!)).toMatchObject({
      link: "created",
      deferred: true,
      email: null,
      phone: null,
    });

    await accept(request.bookingId);
    await sweep();
    expect(await link(request.guestIds[0]!)).toMatchObject({
      deferred: false,
      email: "noah@example.test",
      phone: "+41791234567",
    });
  });

  it("leaves drafts alone until they become bookings", async () => {
    const draft = await book(
      propertyA,
      { source: "booking", status: "draft" },
      { first: "Ella", last: "Fink", email: "ella@example.test" },
    );
    await sweep();
    expect(await link(draft.guestIds[0]!)).toMatchObject({ profileId: null, link: null });

    await admin.query(
      "UPDATE booking.guest_bookings SET lifecycle_status = 'confirmed' WHERE id = $1::uuid",
      [draft.bookingId],
    );
    await sweep();
    expect(await link(draft.guestIds[0]!)).toMatchObject({
      link: "created",
      email: "ella@example.test",
    });
  });

  it("linked every row of this suite without a row error", async () => {
    expect(rowErrors).toEqual([]);
    const unlinked = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM booking.booking_guests guest
       JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
       WHERE booking.public_reference LIKE $1 AND guest.guest_profile_id IS NULL`,
      [`${PREFIX}%`],
    );
    expect(unlinked.rows[0]!.count).toBe(0);
  });
});

async function cleanup(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const properties = (
      await client.query<{ id: string }>(
        "SELECT id FROM hotel_catalog.properties WHERE public_id LIKE $1",
        [`${PREFIX}%`],
      )
    ).rows.map(({ id }) => id);
    const profiles = await client.query<{ id: string }>(
      `SELECT DISTINCT guest.guest_profile_id AS id
       FROM booking.booking_guests guest
       JOIN booking.guest_bookings booking ON booking.id = guest.guest_booking_id
       WHERE booking.property_id = ANY($1::uuid[]) AND guest.guest_profile_id IS NOT NULL`,
      [properties],
    );
    await client.query("DELETE FROM booking.guest_bookings WHERE property_id = ANY($1::uuid[])", [
      properties,
    ]);
    await client.query(
      `DELETE FROM booking.guest_profiles profile WHERE profile.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM booking.booking_guests guest WHERE guest.guest_profile_id = profile.id)`,
      [profiles.rows.map(({ id }) => id)],
    );
    await client.query(
      "DELETE FROM identity.organization_resource_links WHERE resource_id = ANY($1::text[])",
      [properties],
    );
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
      properties,
    ]);
    await client.query("DELETE FROM identity.organizations WHERE slug LIKE $1", [`${PREFIX}%`]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForSessionsToEnd(admin: pg.Pool, login: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query<{ sessions: number }>(
      "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename=$1",
      [login],
    );
    if ((result.rows[0]?.sessions ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test login sessions still open after 5s; not dropping the login");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
