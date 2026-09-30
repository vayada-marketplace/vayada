import { randomUUID } from "node:crypto";

import pg from "pg";
import { describe, expect, it } from "vitest";

import { withHotelSetupCommandScope } from "./hotelSetupCommandScope.js";

const url = process.env["TEST_DATABASE_URL"];

describe.skipIf(!url)("hotel setup property Financials scope", () => {
  it("isolates two hotels in one organization and revokes an already connected login", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");

    const admin = new pg.Client({ connectionString: url });
    const inspector = new pg.Client({ connectionString: url });
    const suffix = randomUUID().replaceAll("-", "");
    const ownedRelation = `hotel_setup_scope_owned_${suffix}`;
    const roles = [0, 1, 2, 3, 4].map(
      (index) => `vayada_next_hotel_setup_property_${index}_${suffix}`,
    );
    const passwords = [0, 1, 2, 3, 4].map(() => randomUUID());
    const organizations = [randomUUID(), randomUUID()];
    const organizationId = organizations[0]!;
    const properties = [randomUUID(), randomUUID()];
    const logins: pg.Client[] = [];
    const scopePool = (login: pg.Client) => ({
      async connect() {
        return {
          async query<T>(sql: string, values?: readonly unknown[]) {
            const result = await login.query(sql, values ? [...values] : []);
            return { rows: result.rows as T[] };
          },
          release() {},
        };
      },
    });
    let transferOpen = false;
    let inspectorConnected = false;
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Property scope test', $3),
                ($2, 'hotel_group', 'Property scope receiver', $4)`,
        [
          organizationId,
          organizations[1],
          `property-scope-${suffix}`,
          `property-receiver-${suffix}`,
        ],
      );
      for (let index = 0; index < 5; index++) {
        const role = roles[index]!;
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${passwords[index]}' NOINHERIT
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        await admin.query(
          `GRANT USAGE ON SCHEMA platform, identity, hotel_catalog, pms, finance TO ${role}`,
        );
        // Deliberately broad ACLs prove RLS, rather than missing grants, deny cross-hotel writes.
        for (const relation of [
          "hotel_catalog.properties",
          "identity.organization_resource_links",
          "identity.product_entitlements",
          "pms.property_pricing_settings",
          "finance.expense_categories",
        ]) {
          await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${relation} TO ${role}`);
        }
        await admin.query(`GRANT SELECT ON pms.room_types, pms.rate_plans TO ${role}`);
        await admin.query(
          `GRANT vayada_next_hotel_setup_property_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
        );
        if (index < 2) {
          const ownerResourceId =
            index === 0 ? properties[index]!.toUpperCase() : properties[index]!;
          await admin.query(
            `INSERT INTO hotel_catalog.properties
             (id, public_id, display_name, creation_organization_id)
           VALUES ($1, $2, 'Property scope hotel', $3)`,
            [properties[index], `property-scope-${index}-${suffix}`, organizationId],
          );
          await admin.query(
            `INSERT INTO identity.organization_resource_links
             (organization_id, product, resource_type, resource_id, relationship, status)
           VALUES ($1, 'hotel_catalog', 'property', $2, 'owner', 'active'),
                  ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
            [organizationId, ownerResourceId],
          );
          await admin.query(
            `INSERT INTO platform.hotel_setup_property_scopes
             (database_login, property_id, organization_id) VALUES ($1, $2, $3)`,
            [role, properties[index], organizationId],
          );
          await admin.query(
            `INSERT INTO identity.product_entitlements
             (organization_id, product, entitlement_key, status,
              resource_product, resource_type, resource_id, metadata)
           VALUES ($1, 'pms', 'module:financials', 'suspended',
                   'pms', 'pms_property', $2, '{"newHotelFinancialsDefault":"pending"}')`,
            [organizationId, properties[index]],
          );
        }
        if (index >= 3) {
          await admin.query(
            `INSERT INTO platform.hotel_setup_property_scopes
             (database_login, property_id, organization_id, operation_class)
             VALUES ($1, $2, $3, $4)`,
            [role, properties[0], organizationId, index === 3 ? "currency_ready" : "feature_hub"],
          );
        }
        const loginUrl = new URL(url);
        loginUrl.username = role;
        loginUrl.password = passwords[index]!;
        const login = new pg.Client({ connectionString: loginUrl.toString() });
        await login.connect();
        logins.push(login);
      }
      for (const [loginIndex, propertyIndex, operation, allowed] of [
        [0, 0, "currency", true],
        [0, 0, "currency_ready", false],
        [3, 0, "currency_ready", true],
        [3, 0, "feature_hub", false],
        [3, 1, "currency_ready", false],
        [4, 0, "feature_hub", true],
        [4, 0, "currency", false],
      ] as const) {
        const result = await logins[loginIndex]!.query<{ allowed: boolean }>(
          `SELECT platform.hotel_setup_property_operation_allowed($1::uuid, $2::text)
             AS allowed`,
          [properties[propertyIndex], operation],
        );
        expect(result.rows[0]?.allowed).toBe(allowed);
        const preflight = withHotelSetupCommandScope(
          scopePool(logins[loginIndex]!),
          {
            propertyId: properties[propertyIndex]!,
            organizationId,
            operation,
          },
          async () => undefined,
        );
        if (allowed) await expect(preflight).resolves.toBeUndefined();
        else await expect(preflight).rejects.toThrow("scope preflight failed");
      }
      const lockInspector = new pg.Client({ connectionString: url });
      await lockInspector.connect();
      let releaseWrite!: () => void;
      let scopeChecked!: () => void;
      const writeCanFinish = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const preflightFinished = new Promise<void>((resolve) => {
        scopeChecked = resolve;
      });
      const scopedWrite = withHotelSetupCommandScope(
        scopePool(logins[3]!),
        {
          propertyId: properties[0]!,
          organizationId,
          operation: "currency_ready",
        },
        async (client) => {
          scopeChecked();
          await writeCanFinish;
          await client.query("SELECT 1");
        },
      );
      await preflightFinished;
      await admin.query("BEGIN");
      try {
        const adminPid = (await admin.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const revoke = admin.query(
          "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
          [roles[3]],
        );
        void revoke.catch(() => {});
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await lockInspector.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [adminPid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        releaseWrite();
        await scopedWrite;
        await revoke;
      } finally {
        releaseWrite();
        await admin.query("ROLLBACK");
        await lockInspector.end();
      }
      await admin.query(`CREATE TABLE public.${ownedRelation} (id integer)`);
      await admin.query(`ALTER TABLE public.${ownedRelation} OWNER TO ${roles[3]}`);
      await expect(
        withHotelSetupCommandScope(
          scopePool(logins[3]!),
          {
            propertyId: properties[0]!,
            organizationId,
            operation: "currency_ready",
          },
          async () => undefined,
        ),
      ).rejects.toThrow("scope preflight failed");
      await admin.query(`DROP TABLE public.${ownedRelation}`);
      expect(
        (
          await logins[4]!.query("SELECT id FROM hotel_catalog.properties WHERE id=$1", [
            properties[0],
          ])
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[4]!.query(
          "INSERT INTO pms.property_pricing_settings (property_id, currency) VALUES ($1, 'USD')",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        logins[4]!.query(
          "INSERT INTO finance.expense_categories (property_id, name, color) VALUES ($1, 'Other', '#6366F1')",
          [properties[0]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[3]!.query(
            "INSERT INTO finance.expense_categories (property_id, name, color) VALUES ($1, 'Other', '#6366F1')",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1, 'pms', 'pms_property', $2, 'owner', 'active')`,
        [organizations[1], properties[0]!.toUpperCase()],
      );
      expect(
        (
          await logins[0]!.query(
            "SELECT organization_id FROM identity.organization_resource_links WHERE resource_id=$1",
            [properties[0]!.toUpperCase()],
          )
        ).rows,
      ).toEqual([{ organization_id: organizationId }, { organization_id: organizationId }]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links
         WHERE organization_id=$1 AND resource_id=$2`,
        [organizations[1], properties[0]!.toUpperCase()],
      );

      expect(
        (
          await logins[0]!.query(
            "SELECT resource_id FROM identity.product_entitlements WHERE entitlement_key='module:financials'",
          )
        ).rows,
      ).toEqual([{ resource_id: properties[0] }]);
      await expect(
        logins[0]!.query("SET ROLE vayada_next_hotel_setup_property_scope"),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            `INSERT INTO pms.property_pricing_settings (property_id, currency)
         VALUES ($1, 'USD') RETURNING property_id`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[0]!.query(
          `INSERT INTO pms.property_pricing_settings (property_id, currency)
         VALUES ($1, 'EUR')`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            `INSERT INTO finance.expense_categories
           (property_id, system_key, name, color, sort_order)
         VALUES ($1, 'staff', 'Staff', '#6366F1', 10) RETURNING id`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        logins[0]!.query(
          `INSERT INTO finance.expense_categories
           (property_id, system_key, name, color, sort_order)
         VALUES ($1, 'staff', 'Staff', '#6366F1', 10)`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[1]!.query(
            "UPDATE finance.expense_categories SET name='Forged' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);

      expect(
        (
          await logins[0]!.query(
            "UPDATE finance.expense_categories SET name='Forged' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[1]!.query(
            "UPDATE pms.property_pricing_settings SET currency='EUR' WHERE property_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1", [
            properties[0],
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await logins[0]!.query(
            `UPDATE identity.product_entitlements SET status='active',
         metadata='{"newHotelFinancialsDefault":"ready"}'
         WHERE resource_id=$1`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);
      await expect(
        logins[0]!.query(
          `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status)
         VALUES ($1, 'pms', 'property-management', 'active')`,
          [organizationId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (
          await logins[0]!.query(
            "UPDATE identity.organization_resource_links SET status='suspended' WHERE resource_id=$1",
            [properties[0]],
          )
        ).rowCount,
      ).toBe(0);

      await admin.query(`REVOKE vayada_next_hotel_setup_property_scope FROM ${roles[1]}`);
      expect(
        (
          await logins[1]!.query("SELECT id FROM hotel_catalog.properties WHERE id=$1", [
            properties[1],
          ])
        ).rows,
      ).toEqual([]);
      await expect(
        logins[1]!.query(
          `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
          [properties[1]],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Transfer locks the assignment, so a concurrent old-login write waits
      // and is rejected after the new owner and login become effective.
      await admin.query("BEGIN");
      transferOpen = true;
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[0]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[3]],
      );
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [roles[4]],
      );
      await admin.query(
        `UPDATE identity.organization_resource_links SET organization_id=$1
         WHERE organization_id=$2 AND resource_id=$3`,
        [organizations[1], organizationId, properties[0]!.toUpperCase()],
      );
      await admin.query(
        `UPDATE identity.product_entitlements SET organization_id=$1
         WHERE organization_id=$2 AND resource_id=$3`,
        [organizations[1], organizationId, properties[0]],
      );
      await admin.query(
        `INSERT INTO platform.hotel_setup_property_scopes
           (database_login, property_id, organization_id) VALUES ($1, $2, $3)`,
        [roles[2], properties[0], organizations[1]],
      );
      await inspector.connect();
      inspectorConnected = true;
      const oldLoginPid = (
        await logins[0]!.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await logins[0]!.query("SET statement_timeout = '10s'");
      const oldWrite = logins[0]!.query(
        `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
        [properties[0]],
      );
      void oldWrite.catch(() => {});
      let waitingOnTransferLock = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await inspector.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [oldLoginPid],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          waitingOnTransferLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waitingOnTransferLock).toBe(true);
      await admin.query("COMMIT");
      transferOpen = false;
      await expect(oldWrite).rejects.toMatchObject({ code: "42501" });
      await expect(
        withHotelSetupCommandScope(
          scopePool(logins[3]!),
          {
            propertyId: properties[0]!,
            organizationId,
            operation: "currency_ready",
          },
          async () => undefined,
        ),
      ).rejects.toThrow("scope preflight failed");
      expect(
        (
          await logins[3]!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_property_operation_allowed($1, 'currency_ready') AS allowed",
            [properties[0]],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (
          await logins[4]!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_property_operation_allowed($1, 'feature_hub') AS allowed",
            [properties[0]],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (
          await logins[0]!.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await logins[2]!.query(
            "SELECT resource_id FROM identity.product_entitlements WHERE resource_id=$1",
            [properties[0]],
          )
        ).rows,
      ).toEqual([{ resource_id: properties[0] }]);
      expect(
        (
          await logins[2]!.query(
            `INSERT INTO finance.expense_categories
           (property_id, name, color) VALUES ($1, 'Utilities', '#06B6D4')`,
            [properties[0]],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      if (transferOpen) await admin.query("ROLLBACK");
      if (inspectorConnected) await inspector.end();
      await Promise.all(logins.map((login) => login.end()));
      await admin.query(`DROP TABLE IF EXISTS public.${ownedRelation}`);
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id=ANY($1::uuid[])",
        [organizations],
      );
      await admin.query(
        "DELETE FROM finance.expense_categories WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      await admin.query(
        "DELETE FROM pms.property_pricing_settings WHERE property_id=ANY($1::uuid[])",
        [properties],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=ANY($1::uuid[])",
        [organizations],
      );
      await admin.query(
        "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=ANY($1::name[])",
        [roles],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id=ANY($1::uuid[])", [
        organizations,
      ]);
      for (const role of roles) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
