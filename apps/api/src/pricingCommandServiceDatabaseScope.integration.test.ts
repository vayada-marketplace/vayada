import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import {
  assertPricingCommandPoolScope,
  assertPricingCommandTransactionScope,
} from "./pricingCommandServiceConfig.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("pricing command database scope", () => {
  it("uses the authenticated native login's exact public property assignment", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const role = `vayada_next_pricing_public_${suffix}`;
    const password = randomUUID().replaceAll("-", "");
    const propertyId = randomUUID();
    const organizationId = randomUUID();
    let runtime: pg.Pool | undefined;
    try {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA booking TO ${role}`);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1::uuid,'hotel_group','Scope test',$1::text)",
        [organizationId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Scope test')",
        [propertyId],
      );
      await admin.query(
        `INSERT INTO platform.pricing_runtime_property_scopes
        (database_login,operation_class,property_id,organization_id)
        VALUES($1,'public',$2,$3)`,
        [role, propertyId, organizationId],
      );
      const login = new URL(url);
      login.username = role;
      login.password = password;
      runtime = new pg.Pool({ connectionString: login.toString(), max: 1 });

      await expect(
        assertPricingCommandPoolScope(runtime, { propertyId, operationClass: "public" }),
      ).resolves.toEqual({ propertyId, organizationId });
      await expect(
        assertPricingCommandPoolScope(runtime, {
          propertyId: randomUUID(),
          operationClass: "public",
        }),
      ).rejects.toThrow("scope preflight failed");
      await expect(
        assertPricingCommandPoolScope(runtime, { propertyId, operationClass: "owner_read" }),
      ).rejects.toThrow("scope preflight failed");

      const client = await runtime.connect();
      try {
        await client.query("BEGIN");
        await expect(
          assertPricingCommandTransactionScope(client, {
            propertyId,
            operationClass: "public",
          }),
        ).resolves.toEqual({ propertyId, organizationId });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }

      await admin.query(
        "DELETE FROM platform.pricing_runtime_property_scopes WHERE database_login=$1",
        [role],
      );
      await expect(
        assertPricingCommandPoolScope(runtime, { propertyId, operationClass: "public" }),
      ).rejects.toThrow("scope preflight failed");
    } finally {
      await runtime?.end();
      await admin.query(
        "DELETE FROM platform.pricing_runtime_property_scopes WHERE database_login=$1",
        [role],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      await admin.end();
    }
  });
});
