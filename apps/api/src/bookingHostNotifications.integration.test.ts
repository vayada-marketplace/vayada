import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPgBookingHostNotificationsRepository,
  type BookingHostNotificationsRepository,
  type HostNotificationViewer,
} from "./domains/bookingHostNotifications.js";
import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "./hotelSetupOrdinaryLogin.fixture.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PREFIX = "vay-2349-";

// VAY-2349: Booking Admin's bell, read and marked by next-api as `vayada_next_api_runtime`, so this suite runs
// the repository through the test login that mirrors that role's product-DML posture (migration 0514).
describe.skipIf(!TEST_DATABASE_URL)("Booking Admin notifications (runtime login)", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const organizationId = randomUUID();
  const [viewerId, colleagueId, managerId, elsewhereId] = Array.from({ length: 4 }, randomUUID);
  const propertyId = randomUUID();
  const otherPropertyId = randomUUID();
  const viewer: HostNotificationViewer = {
    userId: viewerId,
    organizationId,
    canReadPromos: true,
    canReadGuestContact: true,
    retrySyncDomains: ["ari", "booking"],
  };
  let fixture: HotelSetupOrdinaryLoginFixture;
  let repository: BookingHostNotificationsRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanup(admin);
    await admin.query(
      "INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','VAY-2349',$2,'active')",
      [organizationId, `${PREFIX}${organizationId}`],
    );
    for (const [id, name] of [
      [viewerId, "Mia Owner"],
      [colleagueId, "Anna Keller"],
      [managerId, null],
      [elsewhereId, "Tom Elsewhere"],
    ])
      await admin.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,$3)", [
        id,
        `${PREFIX}${id}@example.test`,
        name,
      ]);
    for (const id of [propertyId, otherPropertyId]) {
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Hotel Alpenrose')",
        [id, `${PREFIX}${id}`],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES($1,'Europe/Berlin')",
        [id],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id,product,resource_type,resource_id,relationship,status)
         VALUES ($1,'hotel_catalog','property',$2,'owner','active')`,
        [organizationId, id],
      );
    }
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, TEST_DATABASE_URL!);
    repository = createPgBookingHostNotificationsRepository(
      new pg.Pool({ connectionString: fixture.connectionString, max: 2 }),
    );
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
        await cleanup(admin);
      }
    } finally {
      await admin.end();
    }
  });

  it("lets the runtime login keep and prune read marks, and only read the sources", async () => {
    const privileges = await admin.query<Record<string, boolean>>(
      `SELECT
         has_table_privilege($1, 'booking.host_notification_reads', 'SELECT') AS "readsSelect",
         has_table_privilege($1, 'booking.host_notification_reads', 'INSERT') AS "readsInsert",
         has_table_privilege($1, 'booking.host_notification_reads', 'DELETE') AS "readsDelete",
         has_table_privilege($1, 'booking.booking_status_events', 'SELECT') AS "eventsSelect",
         has_table_privilege($1, 'pms.channel_sync_status', 'SELECT') AS "syncSelect",
         has_table_privilege($1, 'pms.channel_sync_status', 'UPDATE') AS "syncUpdate"`,
      [fixture.login],
    );
    expect(privileges.rows[0]).toEqual({
      readsSelect: true,
      readsInsert: true,
      readsDelete: true,
      eventsSelect: true,
      syncSelect: true,
      syncUpdate: false,
    });
  });

  it("builds the property's feed, keeps read marks per person and prunes old ones", async () => {
    // A booking-page booking made yesterday.
    const created = await seedBooking({ firstName: "Sarah", lastName: "Miller", total: 600 });
    const createdEvent = await seedEvent(created, "guest_booking.created", {
      toStatus: "confirmed",
      ago: "1 day",
    });
    // A bank transfer that missed its deadline: "Payment not received" (its creation is listed too).
    const missed = await seedBooking({
      firstName: "Lukas",
      lastName: "Brandt",
      total: 480,
      status: "expired",
      cancellationReason: "pending_booking_expired",
      metadata: { paymentMethod: "bank_transfer" },
    });
    const missedCreated = await seedEvent(missed, "guest_booking.created", {
      toStatus: "pending_payment",
      ago: "3 days",
    });
    const missedEvent = await seedEvent(missed, "guest_booking.expired", {
      toStatus: "expired",
      actorType: "system",
      ago: "2 days",
    });
    // Date changes: the viewer's own is left out, a colleague's shows with the totals.
    const moved = await seedBooking({ firstName: "Emma", lastName: "Rossi", total: 360 });
    await seedEvent(moved, "guest_booking.host_dates_updated", {
      actorType: "property_user",
      actorUserId: viewerId,
      ago: "1 hour",
    });
    const movedEvent = await seedEvent(moved, "guest_booking.host_dates_updated", {
      actorType: "property_user",
      actorUserId: colleagueId,
      ago: "5 hours",
      payload: { oldTotal: "240.00", newTotal: "360.00" },
    });
    // Left out: a PMS-made booking, an event older than 30 days, payments, another property's booking.
    const pmsMade = await seedBooking({ sourceSystem: "pms" });
    await seedEvent(pmsMade, "guest_booking.created", { toStatus: "confirmed", ago: "1 day" });
    await seedEvent(created, "guest_booking.request_updated", { ago: "40 days" });
    await seedEvent(created, "guest_booking.payment_received", { ago: "2 hours" });
    const elsewhere = await seedBooking({ property: otherPropertyId });
    await seedEvent(elsewhere, "guest_booking.created", { toStatus: "confirmed", ago: "1 day" });
    // Left out too: a card checkout that was never paid, from its start to its expiry.
    const abandonedCard = await seedBooking({
      status: "expired",
      cancellationReason: "pending_booking_expired",
      metadata: { paymentMethod: "card" },
    });
    await seedEvent(abandonedCard, "guest_booking.created", {
      toStatus: "pending_payment",
      ago: "3 hours",
    });
    await seedEvent(abandonedCard, "guest_booking.expired", {
      toStatus: "expired",
      actorType: "system",
      ago: "150 minutes",
    });
    // A bank transfer booking still waiting for its payment.
    const waiting = await seedBooking({
      firstName: "Mia",
      lastName: "Wolf",
      total: 300,
      status: "pending_payment",
      metadata: { paymentMethod: "bank_transfer" },
    });
    const waitingEvent = await seedEvent(waiting, "guest_booking.created", {
      toStatus: "pending_payment",
      ago: "30 minutes",
    });

    // The channel manager's availability sync failed; its booking sync is fine.
    const connectionId = randomUUID();
    await admin.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair')",
      [propertyId, `channex-${propertyId}`],
    );
    await admin.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($1,$2,'channex','connected',$3)",
      [connectionId, propertyId, `channex-${propertyId}`],
    );
    await admin.query(
      `INSERT INTO pms.channel_sync_status(property_id,connection_id,sync_domain,status,last_attempt_at,last_success_at)
       VALUES ($1,$2,'ari','failed',now() - interval '10 minutes',now() - interval '1 hour'),
              ($1,$2,'booking','ok',now() - interval '1 minute',now() - interval '1 minute')`,
      [propertyId, connectionId],
    );

    // Promo codes: one ends in 3 days, one used up its limit; one ends in 20 days, one is retired.
    const ending = await seedPromo("SUMMER25", { endsInDays: 3, uses: 14, maxUses: 100 });
    const usedUp = await seedPromo("WELCOME10", { uses: 50, maxUses: 50 });
    await seedPromo("LATER20", { endsInDays: 20, uses: 1, maxUses: 100 });
    await seedPromo("OLD5", { endsInDays: 2, uses: 1, maxUses: 100, retired: true });
    const endsOn = (
      await admin.query<{ day: string }>(
        "SELECT ((now() AT TIME ZONE 'Europe/Berlin')::date + 3)::text AS day",
      )
    ).rows[0]!.day;

    // Team: a front desk member assigned to this property and a manager with all properties joined; the
    // viewer's own membership and a member of another property are left out.
    const roleId = randomUUID();
    await admin.query(
      `INSERT INTO identity.organization_roles
         (id,organization_id,name,base_role_key,security_class,default_permissions)
       VALUES($1,$2,'Front desk','front_desk','staff','[]'::jsonb)`,
      [roleId, organizationId],
    );
    const colleagueMembership = await seedMembership(colleagueId, "front_desk", {
      roleId,
      assigned: propertyId,
      ago: "4 days",
    });
    const managerMembership = await seedMembership(managerId, "hotel_manager", { ago: "6 days" });
    await seedMembership(viewerId, "hotel_manager", { ago: "1 day" });
    await seedMembership(elsewhereId, "front_desk", { assigned: otherPropertyId, ago: "1 day" });

    const feed = (await repository.read(propertyId, viewer))!;
    expect(feed.timeZone).toBe("Europe/Berlin");
    const byKey = new Map(feed.items.map((item) => [item.key, item]));
    expect([...byKey.keys()].sort()).toEqual(
      [
        `booking-event:${createdEvent}`,
        `booking-event:${missedCreated}`,
        `booking-event:${missedEvent}`,
        `booking-event:${movedEvent}`,
        `booking-event:${waitingEvent}`,
        `promo-ending:${ending}:${endsOn}`,
        `promo-limit:${usedUp}:50`,
        `team-joined:${colleagueMembership}`,
        `team-joined:${managerMembership}`,
      ].sort(),
    );
    const times = feed.items.map((item) => item.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(byKey.get(`booking-event:${createdEvent}`)).toMatchObject({
      kind: "booking_new",
      booking: {
        guestName: "Sarah Miller",
        totalAmount: "600.00",
        currency: "EUR",
        checkIn: "2027-02-13",
        awaiting: null,
      },
    });
    // What a booking waits for is read from it now: this one has expired since.
    expect(byKey.get(`booking-event:${missedCreated}`)!.booking!.awaiting).toBeNull();
    expect(byKey.get(`booking-event:${waitingEvent}`)!.booking!.awaiting).toBe("payment");
    expect(byKey.get(`booking-event:${missedEvent}`)).toMatchObject({
      kind: "payment_not_received",
      category: "needs_action",
      // Commission plan, never accepted: the guest's email stays hidden.
      booking: { guestName: "Lukas Brandt", guestEmail: null, totalAmount: "480.00" },
    });
    expect(byKey.get(`booking-event:${movedEvent}`)!.booking!.change).toEqual({
      kind: "dates",
      previousTotal: "240.00",
      newTotal: "360.00",
    });
    expect(byKey.get(`promo-ending:${ending}:${endsOn}`)!.promo).toEqual({
      id: ending,
      code: "SUMMER25",
      validUntil: endsOn,
      uses: 14,
      maxUses: 100,
    });
    expect(byKey.get(`team-joined:${colleagueMembership}`)!.member).toEqual({
      name: "Anna Keller",
      role: "Front desk",
    });
    // No name: none shows (never the colleague's email); no role definition: the base role.
    expect(byKey.get(`team-joined:${managerMembership}`)!.member).toEqual({
      name: null,
      role: "hotel_manager",
    });
    expect(feed.syncAlert).toMatchObject({ read: false, domains: ["ari"], canRetry: true });
    expect(feed.unread).toEqual({ all: 10, bookings: 4, needsAction: 4, updates: 2 });
    expect(feed.badge).toBe("red");

    // Without promo permission the codes stay out.
    const noPromos = (await repository.read(propertyId, { ...viewer, canReadPromos: false }))!;
    expect(noPromos.items.some((item) => item.promo)).toBe(false);

    // Marks are the person's own: reading one, then all, leaves the colleague's view unread.
    await repository.markRead(propertyId, viewerId, [
      `booking-event:${missedEvent}`,
      `booking-event:${missedEvent}`,
    ]);
    const afterOne = (await repository.read(propertyId, viewer))!;
    expect(afterOne.unread.needsAction).toBe(3);
    expect(afterOne.badge).toBe("red"); // the sync failure is still unread
    // "Mark all read" marks what the person saw: a booking that came in since stays unread.
    const late = await seedBooking({ firstName: "Late", lastName: "Guest" });
    const lateEvent = await seedEvent(late, "guest_booking.created", { ago: "0 seconds" });
    await repository.markAllRead(propertyId, viewer, {
      before: new Date(afterOne.generatedAt),
      syncAlertKey: afterOne.syncAlert!.key,
    });
    const afterAll = (await repository.read(propertyId, viewer))!;
    expect(afterAll.unread).toEqual({ all: 1, bookings: 1, needsAction: 0, updates: 0 });
    await repository.markRead(propertyId, viewerId, [`booking-event:${lateEvent}`]);
    expect((await repository.read(propertyId, viewer))!.unread.all).toBe(0);
    expect(afterAll.syncAlert!.read).toBe(true);
    expect(afterAll.badge).toBe("blue");
    const colleague = (await repository.read(propertyId, { ...viewer, userId: colleagueId }))!;
    expect(colleague.unread.all).toBeGreaterThan(0);

    // A new failure episode after a success is unread again.
    await admin.query(
      "UPDATE pms.channel_sync_status SET last_success_at = now() - interval '30 minutes' WHERE connection_id=$1 AND sync_domain='ari'",
      [connectionId],
    );
    expect((await repository.read(propertyId, viewer))!.syncAlert!.read).toBe(false);

    // Marks older than 60 days are deleted on the next mark.
    await admin.query(
      `INSERT INTO booking.host_notification_reads(user_id,property_id,notification_key,read_at)
       VALUES($1,$2,'booking-event:old',now() - interval '61 days')`,
      [viewerId, otherPropertyId],
    );
    await repository.markRead(propertyId, viewerId, [`booking-event:${createdEvent}`]);
    const marks = await admin.query<{ key: string }>(
      "SELECT notification_key AS key FROM booking.host_notification_reads WHERE user_id=$1",
      [viewerId],
    );
    expect(marks.rows.map((row) => row.key)).not.toContain("booking-event:old");
    expect(marks.rows.length).toBe(11);

    expect(await repository.read(randomUUID(), viewer)).toBeNull();
  });

  // ---------------------------------------------------------------- fixtures

  async function seedBooking(seed: {
    property?: string;
    sourceSystem?: "booking" | "pms";
    firstName?: string;
    lastName?: string;
    total?: number;
    status?: string;
    cancellationReason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO booking.guest_bookings
         (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,cancellation_reason,
          check_in,check_out,adults,currency,total_amount,balance_amount,booking_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'2027-02-13','2027-02-18',2,'EUR',$8,$8,$9::jsonb)`,
      [
        id,
        seed.property ?? propertyId,
        `${PREFIX}${id}`,
        seed.sourceSystem ?? "booking",
        seed.sourceSystem === "pms" ? id : null,
        seed.status ?? "confirmed",
        seed.cancellationReason ?? null,
        seed.total ?? 100,
        JSON.stringify(seed.metadata ?? {}),
      ],
    );
    await admin.query(
      `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email)
       VALUES($1,'booker',$2,$3,'guest@example.test')`,
      [id, seed.firstName ?? "Guest", seed.lastName ?? "Test"],
    );
    return id;
  }

  async function seedEvent(
    bookingId: string,
    type: string,
    options: {
      toStatus?: string;
      actorType?: string;
      actorUserId?: string;
      ago: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO booking.booking_status_events
         (guest_booking_id,event_type,to_status,actor_type,actor_user_id,event_payload,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,now() - $7::interval) RETURNING id::text`,
      [
        bookingId,
        type,
        options.toStatus ?? "confirmed",
        options.actorType ?? "guest",
        options.actorUserId ?? null,
        JSON.stringify(options.payload ?? {}),
        options.ago,
      ],
    );
    return result.rows[0]!.id;
  }

  async function seedPromo(
    code: string,
    options: { endsInDays?: number; uses: number; maxUses: number; retired?: boolean },
  ): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO booking.promo_definitions
         (property_id,code,discount_type,discount_value,valid_until,current_uses,max_uses,status)
       VALUES ($1,$2,'percentage',10,
         CASE WHEN $3::int IS NULL THEN NULL ELSE (now() AT TIME ZONE 'Europe/Berlin')::date + $3::int END,
         $4,$5,$6)
       RETURNING id::text`,
      [
        propertyId,
        code,
        options.endsInDays ?? null,
        options.uses,
        options.maxUses,
        options.retired ? "retired" : "active",
      ],
    );
    return result.rows[0]!.id;
  }

  async function seedMembership(
    userId: string,
    roleKey: string,
    options: { roleId?: string; assigned?: string; ago: string },
  ): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO identity.organization_memberships
         (organization_id,user_id,role_key,status,access_origin,property_access_mode,role_definition_id,invited_at)
       VALUES ($1,$2,$3,'active','agency',$4,$5,now() - $6::interval)
       RETURNING id::text`,
      [
        organizationId,
        userId,
        roleKey,
        options.assigned ? "assigned" : "all",
        options.roleId ?? null,
        options.ago,
      ],
    );
    const membershipId = result.rows[0]!.id;
    if (options.assigned)
      await admin.query(
        "INSERT INTO identity.membership_property_assignments(membership_id,property_id) VALUES($1,$2)",
        [membershipId, options.assigned],
      );
    return membershipId;
  }
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
    ).rows.map((row) => row.id);
    const organizations = (
      await client.query<{ id: string }>(
        "SELECT id FROM identity.organizations WHERE slug LIKE $1",
        [`${PREFIX}%`],
      )
    ).rows.map((row) => row.id);
    // Replica mode skips FK cascades too, so every referencing row is deleted explicitly.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM booking.booking_status_events WHERE guest_booking_id IN (
         SELECT id FROM booking.guest_bookings WHERE property_id = ANY($1::uuid[]))`,
      [properties],
    );
    await client.query(
      `DELETE FROM booking.booking_guests WHERE guest_booking_id IN (
         SELECT id FROM booking.guest_bookings WHERE property_id = ANY($1::uuid[]))`,
      [properties],
    );
    for (const table of [
      "booking.host_notification_reads",
      "booking.guest_bookings",
      "booking.promo_definitions",
      "pms.channel_sync_status",
      "pms.channel_connections",
      "pms.channel_binding_claims",
      "hotel_catalog.property_locations",
    ])
      await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [properties]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
      properties,
    ]);
    await client.query(
      `DELETE FROM identity.membership_property_assignments WHERE membership_id IN (
         SELECT id FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[]))`,
      [organizations],
    );
    for (const table of [
      "identity.organization_memberships",
      "identity.organization_roles",
      "identity.organization_resource_links",
    ])
      await client.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [
        organizations,
      ]);
    await client.query(
      "DELETE FROM booking.host_notification_reads WHERE user_id IN (SELECT id FROM identity.users WHERE email LIKE $1)",
      [`${PREFIX}%`],
    );
    await client.query("DELETE FROM identity.users WHERE email LIKE $1", [`${PREFIX}%`]);
    await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
      organizations,
    ]);
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
