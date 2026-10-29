import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgGuestProfileLinkStore,
  type GuestProfileLinkStore,
} from "./jobs/bookingGuestProfileLinks.js";
import { createTargetBookingGuestPiiPort } from "./platform/bookingGuestPii.js";
import {
  createPgPmsGuestProfileRepository,
  type PmsGuestProfileRepository,
  type PmsGuestProfileScope,
} from "./routes/pmsGuestProfiles.js";
import {
  createPgPmsGuestRegistrationRepository,
  type PmsGuestRegistrationRepository,
} from "./routes/pmsGuestRegistrations.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PREFIX = "vay-2420-api-";

// VAY-2420: next-api serves guest profiles as `vayada_next_api_runtime`, so every repository here
// runs through the test login shaped like that role.
describe.skipIf(!TEST_DATABASE_URL)("PMS guest profiles (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const accountId = randomUUID();
  const actorUserId = randomUUID();
  const [propertyA, propertyB] = [randomUUID(), randomUUID()];
  let fixture: HotelSetupOrdinaryLoginFixture;
  let links: GuestProfileLinkStore;
  let profiles: PmsGuestProfileRepository;
  let registrations: PmsGuestRegistrationRepository;
  let port: ReturnType<typeof createTargetBookingGuestPiiPort>;

  const both: PmsGuestProfileScope = {
    propertyId: propertyA,
    propertyIds: [propertyA, propertyB],
    canReadContact: true,
  };
  const onlyA: PmsGuestProfileScope = { ...both, propertyIds: [propertyA] };
  const audit = () => ({
    actorUserId,
    organizationId: accountId,
    requestId: randomUUID(),
    correlationId: null,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanup(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2420', 'active')`,
      [actorUserId, `${PREFIX}${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Guest profile API hotels', $2, 'active')`,
      [accountId, `${PREFIX}${accountId}`],
    );
    for (const id of [propertyA, propertyB]) {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $2, 'Guest profile API')`,
        [id, `${PREFIX}${id}`],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
        [accountId, id],
      );
    }
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    const connectionString = fixture.connectionString;
    links = createPgGuestProfileLinkStore({ connectionString });
    profiles = createPgPmsGuestProfileRepository({ connectionString });
    registrations = createPgPmsGuestRegistrationRepository({ connectionString });
    port = createTargetBookingGuestPiiPort({ connectionString });
  });

  afterAll(async () => {
    try {
      await Promise.all([links?.close(), profiles?.close?.(), registrations?.close?.()]);
      await port?.close?.();
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
    while ((await links.linkBatch(100)).linked === 100);
  };

  const book = async (
    propertyId: string,
    stay: { checkIn: string; checkOut: string; source?: "pms" | "booking" },
    ...guests: { first: string; last: string; email?: string; phone?: string }[]
  ) => {
    const id = randomUUID();
    const source = stay.source ?? "pms";
    await admin.query(
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, source_system, source_booking_id, lifecycle_status,
          check_in, check_out, adults, currency, total_amount, balance_amount, booking_metadata,
          booking_channel, direct_booking_source)
       VALUES ($1::uuid, $2::uuid, $3, $4, $3, 'confirmed', $5::date, $6::date, 2, 'EUR', 600, 600,
         '{}'::jsonb, 'direct', $7)`,
      [
        id,
        propertyId,
        `${PREFIX}${id}`,
        source,
        stay.checkIn,
        stay.checkOut,
        source === "booking" ? "booking_engine" : "walk_in",
      ],
    );
    await admin.query(
      `INSERT INTO booking.booking_status_events
         (guest_booking_id, event_type, from_status, to_status, actor_type)
       VALUES ($1::uuid, 'guest_booking.accepted', NULL, 'confirmed', 'property_user')`,
      [id],
    );
    const ids: string[] = [];
    for (const guest of guests)
      ids.push(
        (
          await admin.query<{ id: string }>(
            `INSERT INTO booking.booking_guests
               (guest_booking_id, guest_role, first_name, last_name, email, phone)
             VALUES ($1::uuid, $2, $3, $4, $5, $6) RETURNING id::text`,
            [
              id,
              ids.length ? "additional_guest" : "booker",
              guest.first,
              guest.last,
              guest.email ?? null,
              guest.phone ?? null,
            ],
          )
        ).rows[0]!.id,
      );
    return { bookingId: id, guestIds: ids };
  };

  const copy = async (bookingGuestId: string) =>
    (
      await admin.query<{ email: string | null; phone: string | null; profileId: string | null }>(
        `SELECT email, phone, guest_profile_id::text AS "profileId"
         FROM booking.booking_guests WHERE id = $1::uuid`,
        [bookingGuestId],
      )
    ).rows[0]!;

  it("finds and opens a guest with the stays the reader may see, and edits it", async () => {
    const timo = { first: "Timo", last: "Schreyer", email: "timo@example.test" };
    const past = await book(propertyA, { checkIn: "2025-05-01", checkOut: "2025-05-03" }, timo);
    const lastYear = await book(propertyA, { checkIn: "2025-09-01", checkOut: "2025-09-04" }, timo);
    const upcoming = await book(
      propertyB,
      { checkIn: "2030-08-15", checkOut: "2030-08-19" },
      { ...timo, phone: "+49 151 2345678" },
    );
    await sweep();
    const profileId = (await copy(past.guestIds[0]!)).profileId!;
    expect((await copy(upcoming.guestIds[0]!)).profileId).toBe(profileId);

    expect(await profiles.search(both, { search: "SCHREY", limit: 10 })).toEqual([
      {
        guestProfileId: profileId,
        firstName: "Timo",
        lastName: "Schreyer",
        email: "timo@example.test",
        phone: "+49 151 2345678",
        reservations: 3,
        lastCheckIn: "2030-08-15",
      },
    ]);
    // Contact stays hidden and isn't searchable without guest contact access.
    const noContact = { ...both, canReadContact: false };
    expect(await profiles.search(noContact, { search: "timo@", limit: 10 })).toEqual([]);
    expect((await profiles.search(noContact, { search: "timo", limit: 10 }))[0]).toMatchObject({
      email: null,
      phone: null,
    });

    const fromA = await profiles.get(onlyA, profileId);
    expect(fromA).toMatchObject({ reservations: 2, nextArrival: null });
    expect(fromA!.stays.map((stay) => stay.checkIn)).toEqual(["2025-09-01", "2025-05-01"]);
    const all = await profiles.get(both, profileId);
    expect(all).toMatchObject({ reservations: 3, nextArrival: "2030-08-15" });
    expect(all!.stays[0]).toMatchObject({
      propertyId: propertyB,
      role: "booker",
      link: "matched_email",
    });
    expect(
      await profiles.get({ ...both, propertyId: propertyB, propertyIds: [propertyB] }, profileId),
    ).not.toBeNull();

    // An explicit staff edit clears the phone; the edited stay and upcoming stays get the values,
    // other past stays keep what was booked.
    const edited = await profiles.edit(
      both,
      profileId,
      { email: "timo.new@example.test", phone: null },
      lastYear.guestIds[0]!,
      audit(),
    );
    expect(edited).toMatchObject({ fields: { email: "timo.new@example.test", phone: null } });
    expect(await copy(lastYear.guestIds[0]!)).toMatchObject({ email: "timo.new@example.test" });
    expect(await copy(upcoming.guestIds[0]!)).toMatchObject({
      email: "timo.new@example.test",
      phone: null,
    });
    expect(await copy(past.guestIds[0]!)).toMatchObject({ email: "timo@example.test" });
    expect(await profiles.edit(both, profileId, { firstName: "Tim" }, randomUUID(), audit())).toBe(
      "stay_not_found",
    );

    // The linker doesn't undo a staff edit when it sees the copies again.
    await sweep();
    expect((await profiles.get(both, profileId))!.fields).toMatchObject({
      email: "timo.new@example.test",
      phone: null,
    });
    const events = await admin.query<{ payload: unknown }>(
      `SELECT redacted_payload AS payload FROM platform.product_audit_events
       WHERE action = 'pms.guest_profile.edited' AND target_resource_id = $1`,
      [profileId],
    );
    expect(events.rows.map((row) => row.payload)).toEqual([
      { changedFields: ["email", "phone"], bookingGuestId: lastYear.guestIds[0] },
    ]);
  });

  it("keeps a guest with stays only elsewhere out of reach", async () => {
    const elsewhere = await book(
      propertyB,
      { checkIn: "2030-01-01", checkOut: "2030-01-02" },
      { first: "Ella", last: "Fink", email: "ella@example.test" },
    );
    await sweep();
    const profileId = (await copy(elsewhere.guestIds[0]!)).profileId!;
    expect(await profiles.get(onlyA, profileId)).toBeNull();
    expect(await profiles.addNote(onlyA, profileId, "Hidden", audit())).toBeNull();
    expect(await profiles.search(onlyA, { search: "fink", limit: 10 })).toEqual([]);
  });

  it("shows guest notes on every reservation of the guest", async () => {
    const mia = { first: "Mia", last: "Kurz", email: "mia@example.test" };
    const first = await book(propertyA, { checkIn: "2030-03-01", checkOut: "2030-03-02" }, mia);
    const second = await book(propertyB, { checkIn: "2030-04-01", checkOut: "2030-04-02" }, mia);
    await sweep();
    const profileId = (await copy(first.guestIds[0]!)).profileId!;
    const note = await profiles.addNote(both, profileId, "Feather allergy", audit());
    expect(note).toMatchObject({ body: "Feather allergy", propertyId: propertyA });

    const atB = await profiles.reservationProfiles(
      { ...both, propertyId: propertyB },
      second.bookingId,
    );
    expect(atB).toEqual([
      {
        bookingGuestId: second.guestIds[0],
        role: "booker",
        guestProfileId: profileId,
        reservations: 2,
        notes: [note],
      },
    ]);
    // A note written at a property the reader can't open stays hidden from them.
    expect(
      (await profiles.reservationProfiles(
        { ...both, propertyId: propertyB, propertyIds: [propertyB] },
        second.bookingId,
      ))![0]!.notes,
    ).toEqual([]);
    expect(await profiles.reservationProfiles(both, second.bookingId)).toBeNull();

    expect(await profiles.deleteNote(both, profileId, note!.noteId, audit())).toBe(true);
    expect((await profiles.get(both, profileId))!.notes).toEqual([]);
  });

  it("separates a wrongly matched stay and merges two guests back", async () => {
    const father = { first: "Jan", last: "Vogel", email: "vogel@example.test" };
    const one = await book(propertyA, { checkIn: "2030-05-01", checkOut: "2030-05-02" }, father);
    const two = await book(propertyB, { checkIn: "2030-06-01", checkOut: "2030-06-02" }, father);
    await sweep();
    const profileId = (await copy(one.guestIds[0]!)).profileId!;
    expect((await copy(two.guestIds[0]!)).profileId).toBe(profileId);
    await profiles.addNote(both, profileId, "Prefers a quiet room", audit());

    const separated = await profiles.separate(both, profileId, two.guestIds[0]!, audit());
    if (typeof separated === "string") throw new Error(separated);
    expect((await copy(two.guestIds[0]!)).profileId).toBe(separated.guestProfileId);
    expect((await profiles.get(both, separated.guestProfileId))!.fields).toMatchObject({
      firstName: "Jan",
      email: "vogel@example.test",
    });
    expect(await profiles.separate(both, profileId, one.guestIds[0]!, audit())).toBe("only_stay");

    await profiles.edit(both, separated.guestProfileId, { phone: "+491511111111" }, null, audit());
    const merged = await profiles.merge(both, profileId, separated.guestProfileId, audit());
    if (typeof merged === "string") throw new Error(merged);
    expect(merged).toMatchObject({ reservations: 2, fields: { phone: "+491511111111" } });
    expect(merged.notes.map((note) => note.body)).toEqual(["Prefers a quiet room"]);
    expect(merged.stays.map((stay) => stay.link).sort()).toEqual(["created", "merged"]);
    expect(await profiles.get(both, separated.guestProfileId)).toBeNull();
  });

  it("keeps ID details on the guest, so a returning guest arrives with them filled in", async () => {
    const noah = { first: "Noah", last: "Weiss", email: "noah@example.test" };
    const first = await book(propertyA, { checkIn: "2030-07-01", checkOut: "2030-07-03" }, noah);
    const again = await book(propertyA, { checkIn: "2030-09-01", checkOut: "2030-09-03" }, noah);
    await sweep();
    const saved = await registrations.save({
      propertyId: propertyA,
      guestBookingId: first.bookingId,
      guestId: first.guestIds[0]!,
      fields: {
        assignmentId: null,
        dateOfBirth: "1990-02-03",
        documentType: "passport",
        documentNumber: "X1234567",
        gender: "male",
        staffNotes: null,
      },
      audit: { ...audit(), organizationId: accountId },
    });
    expect(saved).toMatchObject({
      ok: true,
      registration: { dateOfBirth: "1990-02-03", documentNumber: "X1234567", gender: "male" },
    });
    const kept = await admin.query(
      `SELECT date_of_birth, document_type, document_number, gender
       FROM pms.guest_registrations WHERE booking_guest_id = $1::uuid`,
      [first.guestIds[0]],
    );
    expect(kept.rows[0]).toEqual({
      date_of_birth: null,
      document_type: null,
      document_number: null,
      gender: "male",
    });
    expect((await registrations.list(propertyA, again.bookingId))![0]).toMatchObject({
      dateOfBirth: "1990-02-03",
      documentType: "passport",
      documentNumber: "X1234567",
      gender: null,
    });

    // ID details recorded before guest profiles move to the profile on the next run.
    const older = await book(
      propertyA,
      { checkIn: "2030-10-01", checkOut: "2030-10-02" },
      { first: "Lea", last: "Roth", email: "lea@example.test" },
    );
    await sweep();
    await admin.query(
      `INSERT INTO pms.guest_registrations
         (booking_guest_id, property_id, guest_booking_id, document_type, document_number)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'national_id', 'ID-77')`,
      [older.guestIds[0], propertyA, older.bookingId],
    );
    await sweep();
    expect((await registrations.list(propertyA, older.bookingId))![0]).toMatchObject({
      documentType: "national_id",
      documentNumber: "ID-77",
    });
    const moved = await admin.query(
      "SELECT document_number FROM pms.guest_registrations WHERE booking_guest_id = $1::uuid",
      [older.guestIds[0]],
    );
    expect(moved.rows[0]).toEqual({ document_number: null });
    const lea = await copy(older.guestIds[0]!);
    expect((await profiles.get(both, lea.profileId!))!.fields).toMatchObject({
      documentType: "national_id",
      documentNumber: "ID-77",
    });
  });

  it("applies the reservation page's guest edits to the guest at once", async () => {
    const party = await book(
      propertyA,
      { checkIn: "2030-11-01", checkOut: "2030-11-03", source: "booking" },
      { first: "Anna", last: "Berg", email: "anna@example.test" },
      { first: "Lena", last: "Berg", email: "lena@example.test" },
    );
    const meta = (name: string) => ({
      propertyId: propertyA,
      guestBookingId: party.bookingId,
      commandId: `${name}-${randomUUID()}`,
      idempotencyKey: `${name}-${randomUUID()}`,
      audit: {
        actorUserId,
        actorOrganizationId: accountId,
        requestId: randomUUID(),
        source: "pms_operations" as const,
        reason: "VAY-2420 test",
      },
    });
    // The booker isn't linked yet: the edit links it. The booking engine asks for residence, but a
    // staff-chosen nationality is the guest's.
    const nationality = await port.correctPrimaryGuestNationalityForPmsOperations({
      ...meta("nationality"),
      countryCode: "AT",
    });
    expect(nationality.ok).toBe(true);
    const anna = await copy(party.guestIds[0]!);
    expect((await profiles.get(both, anna.profileId!))!.fields.countryCode).toBe("AT");

    // Emptying a field on the reservation page clears it on the guest too.
    await sweep();
    const lena = await copy(party.guestIds[1]!);
    expect((await profiles.get(both, lena.profileId!))!.fields.email).toBe("lena@example.test");
    const cleared = await port.updateAdditionalGuestForPmsOperations({
      ...meta("update"),
      guestId: party.guestIds[1]!,
      guest: { email: null },
    });
    expect(cleared.ok).toBe(true);
    expect((await profiles.get(both, lena.profileId!))!.fields.email).toBeNull();
  });
});

async function cleanup(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = async (sql: string) =>
      (await client.query<{ id: string }>(sql, [`${PREFIX}%`])).rows.map(({ id }) => id);
    const properties = await ids("SELECT id FROM hotel_catalog.properties WHERE public_id LIKE $1");
    const organizations = await ids("SELECT id FROM identity.organizations WHERE slug LIKE $1");
    const users = await ids("SELECT id FROM identity.users WHERE email LIKE $1");
    const bookings = await ids(
      "SELECT id FROM booking.guest_bookings WHERE public_reference LIKE $1",
    );
    const profiles = (
      await client.query<{ id: string }>(
        `SELECT DISTINCT guest_profile_id AS id FROM booking.booking_guests
         WHERE guest_booking_id = ANY($1::uuid[]) AND guest_profile_id IS NOT NULL`,
        [bookings],
      )
    ).rows.map(({ id }) => id);
    // Replica mode skips FK cascades and the audit log's append-only trigger, so every
    // referencing row is deleted explicitly.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM platform.product_audit_events
       WHERE property_id = ANY($1::uuid[]) OR organization_id = ANY($2::uuid[])
         OR actor_user_id = ANY($3::uuid[])`,
      [properties, organizations, users],
    );
    for (const table of ["booking.booking_status_events", "booking.booking_guests"])
      await client.query(`DELETE FROM ${table} WHERE guest_booking_id = ANY($1::uuid[])`, [
        bookings,
      ]);
    for (const table of [
      "pms.guest_registrations",
      "booking.guest_notes",
      "booking.guest_bookings",
    ])
      await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [properties]);
    await client.query("DELETE FROM booking.guest_profiles WHERE id = ANY($1::uuid[])", [profiles]);
    await client.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])",
      [organizations],
    );
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
      properties,
    ]);
    await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
      organizations,
    ]);
    await client.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [users]);
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
