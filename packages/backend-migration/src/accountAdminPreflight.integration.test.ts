import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAccountAdminPreflight } from "./accountAdminPreflight.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("account-admin preflight (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(databaseUrl!);
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });
  it("reports missing, multiple, legacy, inactive-user and restricted owners without changing them", async () => {
    const person = randomUUID();
    const suspendedPerson = randomUUID();
    const ids: string[] = Array.from({ length: 6 }, () => randomUUID());
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO identity.users (id, email, status) VALUES ($1, $1::uuid::text || '@example.invalid', 'active'), ($2, $2::uuid::text || '@example.invalid', 'suspended')",
        [person, suspendedPerson],
      );
      for (const [index, id] of ids.entries()) {
        await client.query(
          "INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1, 'hotel_group', 'Preflight synthetic', $1::uuid::text, 'active')",
          [id],
        );
        if (index === 1) continue;
        await client.query(
          `INSERT INTO identity.organization_memberships
          (id, organization_id, user_id, role_key, status, property_access_mode, access_origin, pms_access_enabled, booking_access_enabled)
          VALUES ($1, $2, $3, $4, 'active', 'all', 'agency', $5, true)`,
          [
            randomUUID(),
            id,
            index === 4 ? suspendedPerson : person,
            index === 3 ? "operator" : "hotel_owner",
            index !== 5,
          ],
        );
        if (index === 2)
          await client.query(
            `INSERT INTO identity.organization_memberships
          (id, organization_id, user_id, role_key, status, property_access_mode, access_origin)
          VALUES ($1, $2, $3, 'hotel_owner', 'suspended', 'all', 'agency')`,
            [randomUUID(), id, suspendedPerson],
          );
      }
      const before = (
        await client.query(
          "SELECT * FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[]) ORDER BY id",
          [ids],
        )
      ).rows;
      const report = await runAccountAdminPreflight(client);
      const exceptions = report.exceptions.filter((row) => ids.includes(row.organizationId));
      expect(exceptions).toHaveLength(5);
      expect(exceptions.find((row) => row.organizationId === ids[0])).toBeUndefined();
      expect(exceptions.find((row) => row.organizationId === ids[1])?.ownerCount).toBe(0);
      expect(exceptions.find((row) => row.organizationId === ids[2])?.ownerCount).toBe(2);
      expect(exceptions.find((row) => row.organizationId === ids[3])?.legacyOwnerCount).toBe(1);
      expect(
        exceptions.find((row) => row.organizationId === ids[4])?.activeCanonicalOwnerCount,
      ).toBe(0);
      expect(exceptions.find((row) => row.organizationId === ids[5])?.restrictedOwnerCount).toBe(1);
      expect(
        (
          await client.query(
            "SELECT * FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[]) ORDER BY id",
            [ids],
          )
        ).rows,
      ).toEqual(before);
      expect(JSON.stringify(report)).not.toContain("@example.invalid");
    } finally {
      await client.query("ROLLBACK");
    }
  });
  it("runs in a read-only transaction", async () => {
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      expect((await runAccountAdminPreflight(client)).contractVersion).toBe(
        "account-admin-preflight.v1",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
