import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lockMemberPermissions } from "./memberPermissions.js";
import { requirePropertySetupLifecycleAccess } from "./propertySetupLifecycleAuthorization.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = randomUUID();
const propertyId = randomUUID();
const actorUserId = randomUUID();
const member = { organizationId, actorUserId };
const manage = "booking.settings.manage";

type MemberAccess = {
  roleKey: string;
  roleDefinitionId?: string;
  overrides?: unknown;
  pms?: boolean;
  booking?: boolean;
};

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL member permissions (VAY-2335)", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 3,
  });
  // "Create role" roles sit on hotel_custom, which has no booking grant rows.
  let editor: string;
  let reader: string;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await pool.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'Member Permissions', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Member Permissions', $1::text, 'active')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $1::text, 'Member Permissions')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin, property_access_mode)
       VALUES ($1::uuid, $2::uuid, 'active', 'hotel_custom', 'agency', 'all')`,
      [organizationId, actorUserId],
    );
    await pool.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await pool.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'booking', 'booking-engine', 'active',
               'booking', 'booking_hotel', $2::uuid::text)`,
      [organizationId, propertyId],
    );
    editor = await createRole("Booking editor", "hotel_custom", [
      "booking.settings.read",
      manage,
      "pms.room_status.read",
    ]);
    reader = await createRole("Booking reader", "hotel_manager", ["booking.settings.read"]);
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "organization_memberships",
        "organization_roles",
        "organization_resource_links",
        "product_entitlements",
      ])
        await client.query(`DELETE FROM identity.${table} WHERE organization_id = $1::uuid`, [
          organizationId,
        ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await client.query("COMMIT");
    } finally {
      client.release();
      await pool.end();
    }
  });

  it.each<[string, () => MemberAccess, boolean]>([
    [
      "only through a team-role",
      () => ({ roleKey: "hotel_custom", roleDefinitionId: editor }),
      true,
    ],
    [
      "only through an override",
      () => ({
        roleKey: "hotel_custom",
        overrides: { grant: ["booking.settings.read", manage], deny: [] },
      }),
      true,
    ],
    ["through the base role's grant rows", () => ({ roleKey: "hotel_manager" }), true],
    ["nowhere", () => ({ roleKey: "hotel_custom" }), false],
    [
      "removed by a team-role",
      () => ({ roleKey: "hotel_manager", roleDefinitionId: reader }),
      false,
    ],
    [
      "removed by an override",
      () => ({ roleKey: "hotel_manager", overrides: { grant: [], deny: [manage] } }),
      false,
    ],
    [
      "with Booking switched off",
      () => ({ roleKey: "hotel_custom", roleDefinitionId: editor, booking: false }),
      false,
    ],
  ])("resolves booking.settings.manage %s like the route", async (_, access, expected) => {
    await inTransaction(async (client) => {
      await setMember(client, access());
      const permissions = await lockMemberPermissions(client, member);
      expect(permissions).not.toBeNull();
      expect(permissions!.includes(manage)).toBe(expected);
    });
  });

  it("drops PMS keys when PMS is off and refuses an invalid team-role", async () => {
    await inTransaction(async (client) => {
      await setMember(client, { roleKey: "hotel_custom", roleDefinitionId: editor, pms: false });
      const permissions = await lockMemberPermissions(client, member);
      expect(permissions).toContain(manage);
      expect(permissions).not.toContain("pms.room_status.read");

      // The team-role's base role must match the membership's role key.
      await setMember(client, { roleKey: "hotel_manager", roleDefinitionId: editor });
      await expect(lockMemberPermissions(client, member)).resolves.toBeNull();
    });
  });

  it("gives the account admin preset exactly the owner's grant rows", async () => {
    await inTransaction(async (client) => {
      const preset = await client.query<{ id: string }>(
        `SELECT id FROM identity.organization_roles
         WHERE organization_id = $1::uuid AND preset_key = 'account_admin'`,
        [organizationId],
      );
      await setMember(client, { roleKey: "hotel_owner", roleDefinitionId: preset.rows[0]!.id });
      const grants = await client.query<{ permission: string }>(
        `SELECT permission_key AS permission FROM identity.role_permission_grants
         WHERE organization_kind = 'hotel_group' AND role_key = 'hotel_owner'`,
      );
      const permissions = await lockMemberPermissions(client, member);
      expect([...permissions!].sort()).toEqual(grants.rows.map((row) => row.permission).sort());
    });
  });

  it("lets the setup lifecycle read through a team-role", async () => {
    const access = {
      product: "booking",
      permission: "booking.settings.read",
      resourceType: "booking_hotel",
      entitlementKey: "booking-engine",
    } as const;
    const scope = { organizationId, propertyId, actorUserId };
    await inTransaction(async (client) => {
      await setMember(client, { roleKey: "hotel_custom", roleDefinitionId: editor });
      await expect(requirePropertySetupLifecycleAccess(client, scope, access)).resolves.toBe(
        undefined,
      );
      await setMember(client, { roleKey: "hotel_custom" });
      await expect(requirePropertySetupLifecycleAccess(client, scope, access)).rejects.toThrow(
        "Property setup lifecycle scope is unavailable",
      );
    });
  });

  it("locks the team-role it read until commit, unless read-only", async () => {
    const client = await pool.connect();
    const other = await pool.connect();
    await setMember(other, { roleKey: "hotel_custom", roleDefinitionId: editor });
    const editRole = () =>
      other.query("UPDATE identity.organization_roles SET description = $2 WHERE id = $1::uuid", [
        editor,
        randomUUID(),
      ]);
    try {
      await other.query("SET statement_timeout = '200ms'");
      await client.query("BEGIN");
      await lockMemberPermissions(client, member, { readOnly: true });
      await expect(editRole()).resolves.toMatchObject({ rowCount: 1 });
      await lockMemberPermissions(client, member);
      await expect(editRole()).rejects.toMatchObject({ code: "57014" });
      await client.query("ROLLBACK");
      await expect(editRole()).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await other.query("RESET statement_timeout");
      await setMember(other, { roleKey: "hotel_custom" });
      other.release();
      client.release();
    }
  });

  async function inTransaction(work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  async function setMember(client: pg.PoolClient, access: MemberAccess): Promise<void> {
    await client.query(
      `UPDATE identity.organization_memberships
       SET role_key = $3, role_definition_id = $4::uuid, permission_overrides = $5::jsonb,
           pms_access_enabled = $6, booking_access_enabled = $7
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [
        organizationId,
        actorUserId,
        access.roleKey,
        access.roleDefinitionId ?? null,
        access.overrides === undefined ? null : JSON.stringify(access.overrides),
        access.pms ?? true,
        access.booking ?? true,
      ],
    );
  }

  async function createRole(name: string, baseRoleKey: string, permissions: string[]) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO identity.organization_roles
         (organization_id, name, security_class, base_role_key, default_permissions)
       VALUES ($1::uuid, $2, 'staff', $3, $4::jsonb)
       RETURNING id`,
      [organizationId, name, baseRoleKey, JSON.stringify(permissions)],
    );
    return result.rows[0]!.id;
  }
});

function assertSafeTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (
    !/test/i.test(parsed.pathname) ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
  ) {
    throw new Error("Refusing to run member permission tests against a non-test database");
  }
}
