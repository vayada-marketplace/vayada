import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";
import {
  createPgPmsGuestRegistrationRepository,
  type PmsGuestRegistrationFields,
  type PmsGuestRegistrationRepository,
} from "./routes/pmsGuestRegistrations.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PUBLIC_ID_PREFIX = "vay-2373-";

// VAY-2373: next-api reads and writes guest registrations as `vayada_next_api_runtime`, so this suite
// runs the repository through the test login that mirrors that role's product-DML posture (0516).
describe.skipIf(!TEST_DATABASE_URL)("PMS guest registrations (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: PmsGuestRegistrationRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanupFixtures(admin);
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2373', 'active')`,
      [actorUserId, `vay-2373-${actorUserId}@example.test`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgPmsGuestRegistrationRepository({
      connectionString: fixture.connectionString,
    });
  });

  afterAll(async () => {
    try {
      await repository?.close?.();
      if (fixture) {
        await waitForSessionsToEnd(admin, fixture.login);
        await fixture.drop();
      }
      if (TEST_DATABASE_URL) {
        assertSafeTestDatabase(TEST_DATABASE_URL);
        await cleanupFixtures(admin);
        await admin.query("DELETE FROM identity.users WHERE id=$1::uuid", [actorUserId]);
      }
    } finally {
      await admin.end();
    }
  });

  const audit = () => ({
    actorUserId,
    organizationId,
    requestId: randomUUID(),
    correlationId: null,
  });
  const empty: PmsGuestRegistrationFields = {
    assignmentId: null,
    dateOfBirth: null,
    documentType: null,
    documentNumber: null,
    gender: null,
    staffNotes: null,
  };

  it("has ordinary DML on the registrations table and only INSERT on the audit sink", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'pms.guest_registrations', 'SELECT') AS "select",
         has_table_privilege($1, 'pms.guest_registrations', 'INSERT') AS "insert",
         has_table_privilege($1, 'pms.guest_registrations', 'UPDATE') AS "update",
         has_table_privilege($1, 'platform.product_audit_events', 'INSERT') AS "auditInsert",
         has_table_privilege($1, 'platform.product_audit_events', 'UPDATE') AS "auditUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({
      select: true,
      insert: true,
      update: true,
      auditInsert: true,
      auditUpdate: false,
    });
  });

  it("lists the booker first, saves whole registrations and audits only which fields changed", async () => {
    const stay = await seedStay(admin);
    const listed = await repository.list(stay.propertyId, stay.bookingId);
    expect(
      listed?.map(({ guestId, role, filledFields }) => ({ guestId, role, filledFields })),
    ).toEqual([
      { guestId: stay.bookerId, role: "booker", filledFields: [] },
      { guestId: stay.guestId, role: "additional_guest", filledFields: [] },
    ]);

    const fields: PmsGuestRegistrationFields = {
      assignmentId: stay.assignmentIds[0]!,
      dateOfBirth: "1986-12-09",
      documentType: "passport",
      documentNumber: "C01X00T47",
      gender: null,
      staffNotes: "Feather allergy",
    };
    const first = await repository.save({
      propertyId: stay.propertyId,
      guestBookingId: stay.bookingId,
      guestId: stay.guestId,
      fields,
      audit: audit(),
    });
    expect(first).toMatchObject({
      ok: true,
      registration: { ...fields, role: "additional_guest" },
    });

    const second = await repository.save({
      propertyId: stay.propertyId,
      guestBookingId: stay.bookingId,
      guestId: stay.guestId,
      fields: {
        ...fields,
        assignmentId: stay.assignmentIds[1]!,
        gender: "female",
        staffNotes: null,
      },
      audit: audit(),
    });
    expect(second).toMatchObject({
      ok: true,
      registration: { gender: "female", staffNotes: null },
    });

    const after = await repository.list(stay.propertyId, stay.bookingId);
    expect(after?.[1]).toMatchObject({
      guestId: stay.guestId,
      assignmentId: stay.assignmentIds[1],
      dateOfBirth: "1986-12-09",
      filledFields: ["assignmentId", "dateOfBirth", "documentType", "documentNumber", "gender"],
    });

    const audits = await admin.query(
      `SELECT action, actor_user_id::text AS "actorUserId", target_resource_id AS "guestId",
              redacted_payload AS payload, private_payload AS private
       FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY recorded_at, id`,
      [stay.propertyId],
    );
    expect(audits.rows).toEqual([
      {
        action: "pms.guest_registration.saved",
        actorUserId,
        guestId: stay.guestId,
        payload: {
          guestBookingId: stay.bookingId,
          changedFields: [
            "assignmentId",
            "dateOfBirth",
            "documentType",
            "documentNumber",
            "staffNotes",
          ],
        },
        private: {},
      },
      {
        action: "pms.guest_registration.saved",
        actorUserId,
        guestId: stay.guestId,
        payload: {
          guestBookingId: stay.bookingId,
          changedFields: ["assignmentId", "gender", "staffNotes"],
        },
        private: {},
      },
    ]);
    expect(JSON.stringify(audits.rows)).not.toContain("C01X00T47");
  });

  it("refuses a guest or a room of another booking and doesn't read other properties", async () => {
    const stay = await seedStay(admin);
    const other = await seedStay(admin);
    const save = (guestId: string, assignmentId: string | null) =>
      repository.save({
        propertyId: stay.propertyId,
        guestBookingId: stay.bookingId,
        guestId,
        fields: { ...empty, assignmentId },
        audit: audit(),
      });

    expect(await save(other.guestId, null)).toEqual({ ok: false, code: "guest_not_found" });
    expect(await save(stay.guestId, other.assignmentIds[0]!)).toEqual({
      ok: false,
      code: "assignment_not_found",
    });
    expect(await repository.list(stay.propertyId, other.bookingId)).toBeNull();
    const rows = await admin.query(
      "SELECT 1 FROM pms.guest_registrations WHERE property_id=$1::uuid",
      [stay.propertyId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("goes with its guest and forgets a room the booking no longer has", async () => {
    const stay = await seedStay(admin);
    for (const guestId of [stay.bookerId, stay.guestId])
      await repository.save({
        propertyId: stay.propertyId,
        guestBookingId: stay.bookingId,
        guestId,
        fields: { ...empty, assignmentId: stay.assignmentIds[1]!, documentType: "national_id" },
        audit: audit(),
      });

    await admin.query("DELETE FROM pms.operational_booking_assignments WHERE id=$1::uuid", [
      stay.assignmentIds[1],
    ]);
    await admin.query("DELETE FROM booking.booking_guests WHERE id=$1::uuid", [stay.guestId]);

    const left = await repository.list(stay.propertyId, stay.bookingId);
    expect(left).toEqual([
      expect.objectContaining({
        guestId: stay.bookerId,
        assignmentId: null,
        documentType: "national_id",
      }),
    ]);
  });
});

async function seedStay(admin: pg.Pool) {
  const propertyId = randomUUID();
  const bookingId = randomUUID();
  const roomTypeId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'Guest Registrations')`,
    [propertyId, `${PUBLIC_ID_PREFIX}${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
     VALUES ($1::uuid, $2::uuid, 'Double', 100, 'EUR')`,
    [roomTypeId, propertyId],
  );
  await admin.query(
    `INSERT INTO booking.guest_bookings
       (id, property_id, public_reference, source_system, source_booking_id, lifecycle_status,
        check_in, check_out, adults, currency, total_amount, balance_amount, booking_metadata)
     VALUES ($1::uuid, $2::uuid, $3, 'booking', $3, 'confirmed', '2027-08-15', '2027-08-19', 4, 'EUR',
       600, 600, '{}'::jsonb)`,
    [bookingId, propertyId, `${PUBLIC_ID_PREFIX}${bookingId}`],
  );
  const guests = await admin.query<{ id: string }>(
    `INSERT INTO booking.booking_guests (guest_booking_id, guest_role, first_name, last_name, email)
     VALUES ($1::uuid, 'additional_guest', 'Grace', 'Hopper', NULL),
            ($1::uuid, 'booker', 'Ada', 'Lovelace', 'ada@example.test')
     RETURNING id::text`,
    [bookingId],
  );
  const assignments = await admin.query<{ id: string }>(
    `INSERT INTO pms.operational_booking_assignments
       (property_id, guest_booking_id, room_type_id, position, assignment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'pending'), ($1::uuid, $2::uuid, $3::uuid, 2, 'pending')
     RETURNING id::text`,
    [propertyId, bookingId, roomTypeId],
  );
  return {
    propertyId,
    bookingId,
    guestId: guests.rows[0]!.id,
    bookerId: guests.rows[1]!.id,
    assignmentIds: assignments.rows.map((row) => row.id),
  };
}

async function cleanupFixtures(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fixtures = await client.query<{ id: string }>(
      "SELECT id FROM hotel_catalog.properties WHERE public_id LIKE $1",
      [`${PUBLIC_ID_PREFIX}%`],
    );
    const ids = fixtures.rows.map(({ id }) => id);
    // Replica mode skips FK cascades too, so every referencing row is deleted explicitly.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM booking.booking_guests WHERE guest_booking_id IN
         (SELECT id FROM booking.guest_bookings WHERE property_id=ANY($1::uuid[]))`,
      [ids],
    );
    for (const table of [
      "platform.product_audit_events",
      "pms.guest_registrations",
      "pms.operational_booking_assignments",
      "booking.guest_bookings",
      "pms.room_types",
    ])
      await client.query(`DELETE FROM ${table} WHERE property_id=ANY($1::uuid[])`, [ids]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// pg-pool resolves end() before its clients close; wait so dropping the login kills nothing live.
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
