import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createFakeVerifier, createPgIdentityRepository } from "@vayada/backend-auth";
import {
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import { injectJson } from "@vayada/backend-test";
import type { FinancePropertyReadRepository } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  PmsOperationalReservation,
  PmsOperationsReadRepository,
} from "./domains/pmsOperationsReadModel.js";

// What each role receives from the routes the PMS dashboard reads (VAY-2152) and from the settings
// writes (VAY-2154), with identity, team roles, grants, entitlements and property scope resolved from
// real PostgreSQL.
const url = process.env.TEST_DATABASE_URL;
const readyMadeRoles = new URL(
  "../../../packages/backend-migration/fixtures/ready-made-team-roles.sql",
  import.meta.url,
);
const propertyId = randomUUID();
const organizationId = randomUUID();
const workosOrgId = `wk-org-${organizationId}`;
// `teamRole` is the organization role's name; null is a member from before team roles (VAY-2168).
const roles = [
  { label: "owner", roleKey: "hotel_owner", teamRole: "Account admin" },
  { label: "front desk", roleKey: "front_desk", teamRole: "Front desk" },
  { label: "legacy front desk", roleKey: "front_desk", teamRole: null },
  { label: "housekeeping", roleKey: "housekeeping", teamRole: "Housekeeping" },
  { label: "reservation manager", roleKey: "hotel_custom", teamRole: "Reservation manager" },
  { label: "agency manager", roleKey: "hotel_manager", teamRole: "Agency manager" },
  { label: "settings viewer", roleKey: "hotel_custom", teamRole: "Settings viewer" },
] as const;
type RoleLabel = (typeof roles)[number]["label"];
const users = new Map(roles.map((role) => [role.label, randomUUID()]));
const token = (label: RoleLabel) => `token-${label.replaceAll(" ", "-")}`;
const money = (amountDecimal: string) => ({ amountDecimal, currency: "EUR" });
const reservation: PmsOperationalReservation = {
  guestBookingId: randomUUID(),
  bookingReference: "B-2152",
  status: "confirmed",
  source: "direct_booking",
  stay: { checkIn: "2026-10-13", checkOut: "2026-10-15", adults: 2, children: 0 },
  primaryGuest: {
    displayName: "Synthetic Guest",
    email: "guest@example.test",
    phone: null,
    countryCode: "DE",
    specialRequests: null,
  },
  addOns: [],
  assignments: [
    {
      assignmentId: randomUUID(),
      roomTypeId: randomUUID(),
      ratePlanId: null,
      roomId: null,
      roomNumber: null,
      position: 1,
      assignmentStatus: "pending",
      channel: "direct",
      assignedAt: null,
      nightly: [{ serviceDate: "2026-10-13", applied: money("100.00"), evidenceQuality: "exact" }],
    },
  ],
  checkin: { completedAt: null, pendingFlags: [] },
  checkout: { completedAt: null, pendingFlags: [] },
  privateNoteCount: 0,
  additionalGuestCount: 0,
  pricing: { totalAmount: money("200.00"), balanceAmount: money("0.00"), amountStatus: "recorded" },
  payment: {
    method: "card",
    status: "captured",
    breakdown: {
      grossAmount: money("200.00"),
      stripeFee: money("3.10"),
      vayadaCommission: money("10.00"),
      netPayout: money("186.90"),
    },
  },
};
const pmsOperationsRepository: PmsOperationsReadRepository = {
  async listRoomsByPropertyId() {
    return { items: [] };
  },
  async listRoomTypesByPropertyId() {
    return { items: [] };
  },
  async findRoomTypeById() {
    return null;
  },
  async listCalendarDaysByPropertyId() {
    return { items: [] };
  },
  async listRoomBlocksByPropertyId() {
    return { items: [] };
  },
  async listReservationsByPropertyId() {
    return { items: [reservation], total: 1 };
  },
  async findReservationByGuestBookingId() {
    return reservation;
  },
};
const financeRepository = {
  async getPaymentSettings() {
    return null;
  },
  async getCancellationPolicy() {
    return null;
  },
} as unknown as FinancePropertyReadRepository;

// Every port behind a settings write is a stub that records the call; a refused write reaches none.
const reached: string[] = [];
function port<T>(name: string): T {
  return new Proxy(
    {},
    {
      get: (_target, method) =>
        typeof method !== "string" || method === "then"
          ? undefined
          : method === "close"
            ? async () => undefined
            : async () => {
                reached.push(`${name}.${method}`);
                throw new Error(`${name}.${method} is a test stub`);
              },
    },
  ) as T;
}
const command = () => ({ commandId: randomUUID(), idempotencyKey: randomUUID() });
// The writes behind the PMS Settings pages (VAY-2154).
const settingsWrites = [
  {
    name: "same-day booking",
    method: "PUT",
    url: `/api/pms/properties/${propertyId}/same-day-booking`,
    body: () => ({ ...command(), enabled: true, cutoffLocalTime: null }),
  },
  {
    name: "check-in settings",
    method: "PUT",
    url: `/api/pms/properties/${propertyId}/check-in-settings`,
    body: () => ({}),
  },
  {
    name: "check-in checklist",
    method: "PUT",
    url: `/api/pms/properties/${propertyId}/check-in-checklist`,
    body: () => ({ ...command(), steps: [] }),
  },
  {
    name: "check-out inspection",
    method: "PUT",
    url: `/api/pms/properties/${propertyId}/check-out-inspection`,
    body: () => ({ ...command(), steps: [] }),
  },
  {
    name: "calendar auto-rearrange",
    method: "PATCH",
    url: `/api/pms/properties/${propertyId}/calendar-settings`,
    body: () => ({ autoRearrangeEnabled: true }),
  },
  {
    name: "arrival times",
    method: "PUT",
    url: `/api/booking/properties/${propertyId}/booking-guest-policy`,
    body: () => ({ expectedRevision: 0, choices: {}, confirmPolicyBundle: true }),
  },
  {
    name: "OTA commission",
    method: "PUT",
    url: `/api/finance/properties/${propertyId}/financials/ota-commission-settings/booking_com`,
    body: () => ({ ...command(), expectedRevision: 0, percentageRate: "15" }),
  },
  {
    name: "Feature Hub financials",
    method: "PATCH",
    url: `/api/pms/properties/${propertyId}/module-activations/financials`,
    body: () => ({ moduleId: "financials", isActive: true }),
  },
  {
    name: "country and time zone",
    method: "PUT",
    url: `/api/hotel-setup/properties/${propertyId}/profile`,
    body: () => ({ expectedProfileRevision: 1, patch: { location: { countryCode: "DE" } } }),
  },
] as const;

function moneyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if ("amountDecimal" in value) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    moneyPaths(child, prefix ? `${prefix}.${key.replace(/^\d+$/, "[]")}` : key),
  );
}

describe.skipIf(!url)("PMS dashboard reads and settings writes per role (VAY-2152)", () => {
  let admin: pg.Client;
  let app: ReturnType<typeof buildApp>;
  let settingsApp: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2152 account', $1::text, $2)`,
      [organizationId, workosOrgId],
    );
    // New accounts no longer get the ready-made staff roles (VAY-2276); older accounts still may.
    await admin.query(await readFile(readyMadeRoles, "utf8"), [[organizationId]]);
    // A "Create role" role that may look at settings but not change them (VAY-2154).
    await admin.query(
      `INSERT INTO identity.organization_roles
         (organization_id, name, security_class, base_role_key, default_permissions)
       VALUES ($1, 'Settings viewer', 'staff', 'hotel_custom',
         '["pms.dashboard.read","pms.settings.read","booking.settings.read"]'::jsonb)`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, 'VAY-2152')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship)
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
              ($1::uuid, 'pms', 'pms_property', $2::text, 'owner'),
              ($1::uuid, 'booking', 'booking_hotel', $2::text, 'owner')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
       VALUES ($1, 'pms', 'property-management', 'active'),
              ($1, 'pms', 'module:financials', 'active'),
              ($1, 'booking', 'booking-engine', 'active')`,
      [organizationId],
    );
    for (const role of roles) {
      const userId = users.get(role.label)!;
      await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        userId,
        `${userId}@example.test`,
      ]);
      await admin.query(
        `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
         VALUES ($1, 'workos', $2)`,
        [userId, `wk-user-${userId}`],
      );
      const membership = await admin.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key, access_origin, property_access_mode, role_definition_id)
         SELECT $1::uuid, $2::uuid, 'active', $3::text, 'agency', 'all', role.id
         FROM (SELECT NULL::uuid AS id WHERE $4::text IS NULL
               UNION ALL
               SELECT id FROM identity.organization_roles
               WHERE organization_id = $1::uuid AND name = $4::text) role`,
        [organizationId, userId, role.roleKey, role.teamRole],
      );
      expect(membership.rowCount, role.label).toBe(1);
    }
    const sessions = new Map(
      roles.map((role) => [
        token(role.label),
        {
          workosUserId: `wk-user-${users.get(role.label)}`,
          workosOrgId,
          sessionId: `session-${token(role.label)}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      ]),
    );
    const auth = {
      verifier: createFakeVerifier(sessions),
      repository: createPgIdentityRepository({ connectionString: url! }),
      rolePermissionRepository: createPgRolePermissionRepository({ connectionString: url! }),
      entitlementRepository: createPgEntitlementRepository({ connectionString: url! }),
      propertyAccessRepository: createPgPropertyAccessRepository({ connectionString: url! }),
    };
    app = buildApp({
      logger: false,
      pmsOperationsRepository,
      pmsFinanceCompatibilityRepository: financeRepository,
      auth,
    });
    settingsApp = buildApp({
      logger: false,
      pmsOperationsRepository,
      pmsOperationsCommandRepository: port("pmsOperationsCommandRepository"),
      sameDayBookingSettings: port("sameDayBookingSettings"),
      pmsRoomAssignmentSettings: port("pmsRoomAssignmentSettings"),
      pmsCheckinSettingsRepository: port("pmsCheckinSettingsRepository"),
      bookingGuestPolicy: {
        application: port("bookingGuestPolicy"),
        propertyAccessRepository: auth.propertyAccessRepository,
      },
      financeOtaCommissionSettingsRepository: port("financeOtaCommissionSettingsRepository"),
      pmsModuleActivationRepository: port("pmsModuleActivationRepository"),
      sharedHotelSetupStatusRepository: port("sharedHotelSetupStatusRepository"),
      hotelSetupTrackCommandRepository: port("hotelSetupTrackCommandRepository"),
      hotelSetupProfileCommand: port("hotelSetupProfileCommand"),
      auth,
    });
  });

  afterAll(async () => {
    await app?.close();
    await settingsApp?.close();
    if (!admin) return;
    await admin.query(`
      BEGIN;
      SET LOCAL session_replication_role = replica;
      DELETE FROM platform.product_audit_events WHERE organization_id = '${organizationId}';
      DELETE FROM identity.organization_memberships WHERE organization_id = '${organizationId}';
      DELETE FROM identity.organization_roles WHERE organization_id = '${organizationId}';
      DELETE FROM identity.product_entitlements WHERE organization_id = '${organizationId}';
      DELETE FROM identity.organization_resource_links WHERE organization_id = '${organizationId}';
      DELETE FROM identity.organizations WHERE id = '${organizationId}';
      DELETE FROM platform.finance_export_worker_properties WHERE property_id = '${propertyId}';
      DELETE FROM hotel_catalog.properties WHERE id = '${propertyId}';
      DELETE FROM identity.external_identities WHERE user_id IN (${[...users.values()].map((id) => `'${id}'`).join(", ")});
      DELETE FROM identity.users WHERE id IN (${[...users.values()].map((id) => `'${id}'`).join(", ")});
      COMMIT;`);
    await admin.end();
  });

  // Room types: 0203's Front desk role lacked pms.rooms_rates.read. No account has that role any
  // more (0508), and the PMS bookings list and dashboard load without room types (VAY-2168).
  it.each([
    { label: "owner", reservations: 200, roomTypes: 200, paymentSettings: 200, breakdown: true },
    {
      label: "front desk",
      reservations: 200,
      roomTypes: 403,
      paymentSettings: 403,
      breakdown: false,
    },
    {
      label: "legacy front desk",
      reservations: 200,
      roomTypes: 200,
      paymentSettings: 403,
      breakdown: false,
    },
    {
      label: "housekeeping",
      reservations: 403,
      roomTypes: 403,
      paymentSettings: 403,
      breakdown: false,
    },
    {
      label: "reservation manager",
      reservations: 200,
      roomTypes: 200,
      paymentSettings: 200,
      breakdown: true,
    },
  ] as const)("$label gets the dashboard reads its role allows", async (expected) => {
    const base = `/api/pms/properties/${propertyId}`;
    const read = (path: string) =>
      injectJson(app, {
        method: "GET",
        url: `${base}${path}`,
        headers: { authorization: `Bearer ${token(expected.label)}` },
      });

    const [list, stayRange, detail, roomTypes, paymentSettings, calendar] = await Promise.all([
      read("/reservations?limit=500&offset=0"),
      read("/reservations?stayFrom=2026-10-13&stayTo=2026-10-15"),
      read(`/reservations/${reservation.guestBookingId}`),
      read("/room-types"),
      read("/payment-settings"),
      read("/calendar?from=2026-10-13&to=2026-10-26"),
    ]);

    expect([list.statusCode, stayRange.statusCode, detail.statusCode]).toEqual([
      expected.reservations,
      expected.reservations,
      expected.reservations,
    ]);
    expect(roomTypes.statusCode).toBe(expected.roomTypes);
    expect(paymentSettings.statusCode).toBe(expected.paymentSettings);
    expect(calendar.statusCode).toBe(200);
    if (expected.reservations !== 200) {
      expect(JSON.stringify([list.body, stayRange.body, detail.body])).not.toContain(
        "amountDecimal",
      );
      return;
    }
    const items = [
      (list.body as { items: unknown[] }).items[0],
      (stayRange.body as { items: unknown[] }).items[0],
      (detail.body as { item: unknown }).item,
    ];
    for (const item of items) {
      expect(moneyPaths(item)).toEqual([
        "assignments.[].nightly.[].applied",
        "pricing.totalAmount",
        "pricing.balanceAmount",
        ...(expected.breakdown
          ? [
              "payment.breakdown.grossAmount",
              "payment.breakdown.stripeFee",
              "payment.breakdown.vayadaCommission",
              "payment.breakdown.netPayout",
            ]
          : []),
      ]);
    }
  });

  // A refused write answers 403 before any port; an allowed one gets past authorization (VAY-2154).
  it.each([
    { label: "owner", allowed: settingsWrites.map((write) => write.name) },
    {
      label: "agency manager",
      allowed: ["same-day booking", "check-in settings", "arrival times"],
    },
    { label: "settings viewer", allowed: [] },
    { label: "front desk", allowed: [] },
  ] as const)("$label can save only the settings its role manages", async ({ label, allowed }) => {
    const authorized: string[] = [];
    for (const write of settingsWrites) {
      reached.length = 0;
      const response = await settingsApp.inject({
        method: write.method,
        url: write.url,
        payload: write.body(),
        headers: { authorization: `Bearer ${token(label)}`, "idempotency-key": randomUUID() },
      });
      expect(response.statusCode, write.name).not.toBe(401);
      if (response.statusCode === 403) expect(reached, write.name).toEqual([]);
      else authorized.push(write.name);
    }
    expect(authorized).toEqual(allowed);
  });
});
