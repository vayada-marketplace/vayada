import { randomUUID } from "node:crypto";
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

// What each preset role receives from the routes the PMS dashboard reads (VAY-2152), with identity,
// role presets, grants, entitlements and property scope resolved from real PostgreSQL.
const url = process.env.TEST_DATABASE_URL;
const propertyId = randomUUID();
const organizationId = randomUUID();
const workosOrgId = `wk-org-${organizationId}`;
const roles = [
  { label: "owner", roleKey: "hotel_owner", preset: "account_admin" },
  { label: "front desk", roleKey: "front_desk", preset: "front_desk" },
  { label: "housekeeping", roleKey: "housekeeping", preset: "housekeeping" },
  { label: "reservation manager", roleKey: "hotel_custom", preset: "reservation_manager" },
] as const;
const users = new Map(roles.map((role) => [role.label, randomUUID()]));
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

function moneyPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if ("amountDecimal" in value) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    moneyPaths(child, prefix ? `${prefix}.${key.replace(/^\d+$/, "[]")}` : key),
  );
}

describe.skipIf(!url)("PMS dashboard reads per preset role (VAY-2152)", () => {
  let admin: pg.Client;
  let app: ReturnType<typeof buildApp>;

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
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $1::text, 'VAY-2152')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship)
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
              ($1::uuid, 'pms', 'pms_property', $2::text, 'owner')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
       VALUES ($1, 'pms', 'property-management', 'active')`,
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
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key, access_origin, property_access_mode, role_definition_id)
         SELECT $1::uuid, $2::uuid, 'active', $3::text, 'agency', 'all', role.id
         FROM identity.organization_roles role
         WHERE role.organization_id = $1::uuid AND role.preset_key = $4::text`,
        [organizationId, userId, role.roleKey, role.preset],
      );
    }
    const sessions = new Map(
      roles.map((role) => [
        `token-${role.preset}`,
        {
          workosUserId: `wk-user-${users.get(role.label)}`,
          workosOrgId,
          sessionId: `session-${role.preset}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      ]),
    );
    app = buildApp({
      logger: false,
      pmsOperationsRepository,
      pmsFinanceCompatibilityRepository: financeRepository,
      auth: {
        verifier: createFakeVerifier(sessions),
        repository: createPgIdentityRepository({ connectionString: url! }),
        rolePermissionRepository: createPgRolePermissionRepository({ connectionString: url! }),
        entitlementRepository: createPgEntitlementRepository({ connectionString: url! }),
        propertyAccessRepository: createPgPropertyAccessRepository({ connectionString: url! }),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
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

  it.each([
    { label: "owner", reservations: 200, paymentSettings: 200, breakdown: true },
    { label: "front desk", reservations: 200, paymentSettings: 403, breakdown: false },
    { label: "housekeeping", reservations: 403, paymentSettings: 403, breakdown: false },
    { label: "reservation manager", reservations: 200, paymentSettings: 200, breakdown: true },
  ] as const)("$label gets the dashboard reads its preset allows", async (expected) => {
    const role = roles.find((candidate) => candidate.label === expected.label)!;
    const base = `/api/pms/properties/${propertyId}`;
    const read = (path: string) =>
      injectJson(app, {
        method: "GET",
        url: `${base}${path}`,
        headers: { authorization: `Bearer token-${role.preset}` },
      });

    const [list, stayRange, detail, paymentSettings, calendar] = await Promise.all([
      read("/reservations?limit=500&offset=0"),
      read("/reservations?stayFrom=2026-10-13&stayTo=2026-10-15"),
      read(`/reservations/${reservation.guestBookingId}`),
      read("/payment-settings"),
      read("/calendar?from=2026-10-13&to=2026-10-26"),
    ]);

    expect([list.statusCode, stayRange.statusCode, detail.statusCode]).toEqual([
      expected.reservations,
      expected.reservations,
      expected.reservations,
    ]);
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
});
