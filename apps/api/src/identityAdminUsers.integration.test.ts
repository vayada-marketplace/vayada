import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgIdentityAdminUsersReadRepository } from "./routes/identityAdminUsers.js";

const URL = process.env["TEST_DATABASE_URL"];

// VAY-2272: the Vayada Admin user list labels accounts by what they are now, and the Hotels page lists
// only the accounts platform property provisioning accepts.
describe.skipIf(!URL)("identity admin user list (PostgreSQL)", () => {
  const tag = `admin-users-${randomUUID().slice(0, 8)}`;
  const accounts = {
    platformMember: { status: "active", created: null },
    hotelSignup: { status: "active", created: "hotel" },
    importedOwner: { status: "active", created: null },
    hotelWithProperty: { status: "active", created: "hotel" },
    hotelTwoOrganizations: { status: "active", created: "hotel" },
    hotelPending: { status: "pending", created: "hotel" },
    invitedStaff: { status: "active", created: null },
    formerCreatorStaff: { status: "active", created: "creator" },
    creatorOnly: { status: "active", created: "creator" },
    createdHotelWithoutOrganization: { status: "active", created: "hotel" },
    legacyAdmin: { status: "active", created: "admin" },
    noMembership: { status: "active", created: null },
    deleted: { status: "deleted", created: "creator" },
  } as const;
  type Account = keyof typeof accounts;
  const ids = Object.fromEntries(Object.keys(accounts).map((key) => [key, randomUUID()])) as Record<
    Account,
    string
  >;
  const organizations = {
    platform: randomUUID(),
    fresh: randomUUID(),
    imported: randomUUID(),
    owning: randomUUID(),
    other: randomUUID(),
    pending: randomUUID(),
  };
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    // Replica mode: checks apply, membership guard triggers do not (these rows only feed reads).
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [key, id] of Object.entries(organizations))
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1, $2, $3, $4)`,
        [
          id,
          key === "platform" ? "platform" : "hotel_group",
          `Admin users ${key}`,
          `${tag}-${key}`,
        ],
      );
    for (const [key, account] of Object.entries(accounts))
      await client.query(
        `INSERT INTO identity.users (id, email, name, status) VALUES ($1, $2, $3, $4)`,
        [ids[key as Account], `${tag}-${key}@example.test`, key, account.status],
      );
    const member = (organization: string, account: Account, role: string) =>
      client.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, role_key, access_origin)
         VALUES ($1, $2, $3, 'agency')`,
        [organization, ids[account], role],
      );
    await member(organizations.platform, "platformMember", "platform_admin");
    await member(organizations.fresh, "hotelSignup", "hotel_owner");
    await member(organizations.imported, "importedOwner", "hotel_owner");
    await member(organizations.owning, "hotelWithProperty", "hotel_owner");
    await member(organizations.fresh, "hotelTwoOrganizations", "hotel_owner");
    await member(organizations.other, "hotelTwoOrganizations", "hotel_owner");
    await member(organizations.pending, "hotelPending", "hotel_owner");
    await member(organizations.owning, "invitedStaff", "front_desk");
    await member(organizations.owning, "formerCreatorStaff", "front_desk");
    // The owning organization already has its hotel.
    await client.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizations.owning, randomUUID()],
    );
    for (const [key, account] of Object.entries(accounts))
      if (account.created)
        await client.query(
          `INSERT INTO identity.auth_reconciliation_events (event_type, provider, user_id, payload)
           VALUES ('identity.user.created', 'workos', $1,
                   jsonb_build_object('payload', jsonb_build_object('legacyUserType', $2::text)))`,
          [ids[key as Account], account.created],
        );
    await client.query("COMMIT");
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const userIds = Object.values(ids);
      const organizationIds = Object.values(organizations);
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM identity.auth_reconciliation_events WHERE user_id = ANY($1::uuid[])`,
        [userIds],
      );
      await client.query(
        `DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])`,
        [organizationIds],
      );
      await client.query(
        `DELETE FROM identity.organization_memberships WHERE user_id = ANY($1::uuid[])`,
        [userIds],
      );
      await client.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [userIds]);
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        organizationIds,
      ]);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
  });

  it("labels each account by what it is now and lists only provisionable hotel accounts", async () => {
    const repository = createPgIdentityAdminUsersReadRepository({ connectionString: URL! });
    try {
      const list = async (input: { type?: "hotel" | "staff" | "admin"; provisionable?: boolean }) =>
        (await repository.listUsers({ ...input, search: tag, limit: 50, offset: 0 })).users
          .map((user) => `${user.name}:${user.type}`)
          .sort();

      expect(await list({})).toEqual([
        "createdHotelWithoutOrganization:hotel",
        "creatorOnly:creator",
        "formerCreatorStaff:staff",
        "hotelPending:hotel",
        "hotelSignup:hotel",
        "hotelTwoOrganizations:hotel",
        "hotelWithProperty:hotel",
        "importedOwner:hotel",
        "invitedStaff:staff",
        "legacyAdmin:admin",
        "noMembership:staff",
        "platformMember:admin",
      ]);
      expect(await list({ type: "staff" })).toEqual([
        "formerCreatorStaff:staff",
        "invitedStaff:staff",
        "noMembership:staff",
      ]);
      // Only an active account in exactly one active hotel group whose organization has no hotel.
      expect(await list({ type: "hotel", provisionable: true })).toEqual([
        "hotelSignup:hotel",
        "importedOwner:hotel",
      ]);
      expect(await list({ provisionable: true })).toEqual([
        "hotelSignup:hotel",
        "importedOwner:hotel",
      ]);
      const total = await repository.listUsers({
        search: tag,
        provisionable: true,
        limit: 1,
        offset: 0,
      });
      expect(total.total).toBe(2);
      expect((await repository.findUserById(ids.invitedStaff))?.type).toBe("staff");
      expect(await repository.findUserById(ids.deleted)).toBeNull();
    } finally {
      await repository.close?.();
    }
  });
});

function assertSafeTestDatabase(connectionString: string): void {
  const url = new globalThis.URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run identity admin user integration tests on a non-test DB");
  }
}
