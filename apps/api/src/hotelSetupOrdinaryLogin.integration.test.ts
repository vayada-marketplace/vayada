import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createHotelSetupOrdinaryLoginFixture,
  listExecutableDefinerFunctions,
} from "./hotelSetupOrdinaryLogin.fixture.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ordinary API login posture for hotel setup (VAY-2056)", () => {
  it("matches the product-DML posture and writes a new hotel under the native-era RLS and triggers", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const [org, property] = [randomUUID(), randomUUID()];
    try {
      const can = async (sql: string, values: unknown[]) =>
        (await pool.query<{ ok: boolean }>(`SELECT (${sql}) AS ok`, values)).rows[0]!.ok;

      // Posture: no SECURITY DEFINER routine is executable, exactly as the platform preflight requires.
      expect(await listExecutableDefinerFunctions(pool)).toEqual([]);
      for (const signature of [
        "platform.hotel_setup_update_property_profile(uuid,uuid,uuid,bigint,jsonb,text,text,text)",
        "platform.hotel_setup_creation_assigned_organization()",
        "platform.hotel_setup_property_operation_allowed(uuid,text)",
      ])
        expect(await can("has_function_privilege(current_user,$1,'EXECUTE')", [signature])).toBe(
          false,
        );
      // Protected credential evidence stays unreadable; narrowings hold.
      for (const [relation, privilege, expected] of [
        ["platform.hotel_setup_property_scopes", "SELECT", false],
        ["platform.hotel_setup_creation_scopes", "SELECT", false],
        ["platform.hotel_setup_linked_properties", "SELECT", false],
        ["hotel_catalog.properties", "INSERT", true],
        ["hotel_catalog.properties", "DELETE", false],
        ["platform.product_audit_events", "INSERT", true],
        ["platform.product_audit_events", "UPDATE", false],
        ["platform.idempotency_keys", "UPDATE", true],
        ["identity.organizations", "UPDATE", false],
      ] as const)
        expect(
          await can("has_table_privilege(current_user,$1,$2)", [relation, privilege]),
          `${privilege} ${relation}`,
        ).toBe(expected);
      for (const [relation, column, privilege, expected] of [
        ["identity.organizations", "created_at", "UPDATE", true],
        ["identity.organizations", "status", "UPDATE", false],
        ["identity.product_entitlements", "metadata", "UPDATE", true],
        ["identity.product_entitlements", "organization_id", "UPDATE", false],
        ["identity.organization_resource_links", "status", "UPDATE", true],
        ["identity.organization_resource_links", "organization_id", "UPDATE", false],
      ] as const)
        expect(
          await can("has_column_privilege(current_user,$1,$2,$3)", [relation, column, privilege]),
          `${privilege} ${relation}.${column}`,
        ).toBe(expected);

      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Ordinary fixture',$2)",
        [org, `ordinary-${org}`],
      );

      // A new hotel written by the ordinary login: every native-era guard exempts it and the
      // owner-link trigger records the protected linkage as the function owner.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM identity.organizations WHERE id=$1 FOR UPDATE", [org]);
        await client.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,property_type,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Ordinary hotel','hotel',$2)",
          [property, org],
        );
        await client.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
          [org, property],
        );
        await client.query(
          "INSERT INTO hotel_catalog.property_locations(property_id,country_code,city,timezone,address_public,geo_public,map_display_mode) VALUES($1,'LK','Galle','Asia/Colombo',FALSE,FALSE,'hidden')",
          [property],
        );
        await client.query(
          "INSERT INTO hotel_catalog.property_contact_channels(property_id,channel_type,value,purpose,is_public,source_system) VALUES($1,'email','front@example.test','guest',TRUE,'platform')",
          [property],
        );
        await client.query(
          "UPDATE hotel_catalog.properties SET display_name='Renamed',profile_revision=profile_revision+1 WHERE id=$1",
          [property],
        );
        // Real identity writes outside the matrix still fail.
        await client.query("SAVEPOINT denied");
        await expect(
          client.query("UPDATE identity.organizations SET name='x' WHERE id=$1", [org]),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT denied");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      expect(
        (
          await admin.query(
            "SELECT display_name,profile_revision FROM hotel_catalog.properties WHERE id=$1",
            [property],
          )
        ).rows,
      ).toEqual([{ display_name: "Renamed", profile_revision: "2" }]);
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*) AS n FROM platform.hotel_setup_linked_properties WHERE property_id=$1",
              [property],
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    } finally {
      await pool.end();
      await admin.query(
        "DELETE FROM hotel_catalog.property_contact_channels WHERE property_id=$1",
        [property],
      );
      await admin.query("DELETE FROM hotel_catalog.property_locations WHERE property_id=$1", [
        property,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [org],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [property]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [org]);
      await fixture.drop();
      await admin.end();
    }
  });
});
