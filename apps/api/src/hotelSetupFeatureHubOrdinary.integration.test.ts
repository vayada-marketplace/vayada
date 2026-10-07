import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createOrdinaryHotelSetupFeatureHubCommands } from "./hotelSetupFeatureHubOrdinary.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ordinary Feature Hub Financials (VAY-2056)", () => {
  it("toggles only a completed default for the current Owner and never revives a foreign suspension", async () => {
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
    const hub = createOrdinaryHotelSetupFeatureHubCommands(pool);
    const suffix = randomUUID().replaceAll("-", "");
    const [org, owner, property, pendingProperty] = [1, 2, 3, 4].map(() => randomUUID());
    const context = (sessionId: string | null = "verified-session") =>
      ({
        actor: { internalUserId: owner, providerIdentity: { sessionId } },
        selectedOrganization: { organizationId: org },
        audit: { requestId: suffix, correlationId: null, receivedAt: new Date().toISOString() },
      }) as unknown as RequestContext;
    const toggle = (isActive: boolean, propertyId = property, ctx = context()) =>
      hub.updateFinancials(ctx, propertyId, isActive);
    const row = async (propertyId = property) =>
      (
        await admin.query(
          `SELECT status, COALESCE(metadata->'featureHubOwnerDisabled','null'::jsonb) AS "ownerOff"
           FROM identity.product_entitlements WHERE entitlement_key='module:financials' AND resource_id=$1`,
          [propertyId],
        )
      ).rows[0];
    const audits = async () =>
      (
        await admin.query(
          `SELECT action, audit_metadata->>'actorOrganizationId' AS org, audit_metadata ? 'hotelSetupTransaction' AS tx
           FROM platform.product_audit_events WHERE property_id=$1 AND action LIKE 'financials_module_%'
           ORDER BY occurred_at`,
          [property],
        )
      ).rows;
    const unavailable = { code: "23514" };
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Hub fixture',$2)",
        [org, `h${suffix}`],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        owner,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
         VALUES ('hotel_group','hotel_owner','pms.finance.manage') ON CONFLICT DO NOTHING`,
      );
      await admin.query(
        "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status) VALUES($1,'pms','property-management','active')",
        [org],
      );
      for (const [id, state] of [
        [
          property,
          '{"newHotelFinancialsDefault":"ready","newHotelFinancialsActivationTransaction":"1"}',
        ],
        [pendingProperty, '{"newHotelFinancialsDefault":"pending"}'],
      ] as const) {
        await admin.query(
          "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Hub fixture',$2)",
          [id, org],
        );
        await admin.query(
          "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active'),($1,'pms','pms_property',$2,'owner','active')",
          [org, id],
        );
        await admin.query(
          "INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1,'LKR')",
          [id],
        );
        await admin.query(
          `INSERT INTO identity.product_entitlements
           (organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id,metadata)
           VALUES ($1,'pms','module:financials',$3,'pms','pms_property',$2,$4::jsonb)`,
          [org, id, id === property ? "active" : "suspended", state],
        );
      }

      // Off, on, off: the Owner's own switch-off can always be reverted.
      expect(await toggle(false)).toMatchObject({ moduleId: "financials", isActive: false });
      expect(await row()).toEqual({ status: "suspended", ownerOff: true });
      expect(await toggle(true)).toMatchObject({ isActive: true });
      expect(await row()).toEqual({ status: "active", ownerOff: false });
      expect(await toggle(false)).toMatchObject({ isActive: false });
      expect(await audits()).toEqual([
        { action: "financials_module_deactivated", org, tx: true },
        { action: "financials_module_activated", org, tx: true },
        { action: "financials_module_deactivated", org, tx: true },
      ]);

      // A suspension the Owner did not make is never re-activated by the Owner.
      await admin.query(
        `UPDATE identity.product_entitlements SET metadata=metadata || '{"featureHubOwnerDisabled":false}'
         WHERE entitlement_key='module:financials' AND resource_id=$1`,
        [property],
      );
      await expect(toggle(true)).rejects.toMatchObject(unavailable);
      expect(await row()).toEqual({ status: "suspended", ownerOff: false });
      await admin.query(
        `UPDATE identity.product_entitlements SET metadata=metadata || '{"featureHubOwnerDisabled":true}'
         WHERE entitlement_key='module:financials' AND resource_id=$1`,
        [property],
      );

      // A default that never completed cannot be activated.
      await expect(toggle(true, pendingProperty)).rejects.toMatchObject(unavailable);
      expect(await row(pendingProperty)).toEqual({ status: "suspended", ownerOff: null });

      // Activation needs a supported currency, no other suspended PMS entitlement and an active base.
      for (const [block, unblock] of [
        [
          "UPDATE pms.property_pricing_settings SET currency='JPY' WHERE property_id=$1",
          "UPDATE pms.property_pricing_settings SET currency='LKR' WHERE property_id=$1",
        ],
        [
          "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id) SELECT organization_id,'pms','account_access','suspended','pms','pms_property',$1 FROM identity.product_entitlements WHERE resource_id=$1 AND entitlement_key='module:financials'",
          "DELETE FROM identity.product_entitlements WHERE entitlement_key='account_access' AND resource_id=$1",
        ],
      ] as const) {
        await admin.query(block, [property]);
        await expect(toggle(true)).rejects.toBeDefined();
        expect((await row()).status).toBe("suspended");
        await admin.query(unblock, [property]);
      }

      // Missing session, revoked finance permission, PMS access off, suspended PMS link and a
      // suspended organization all deny before any write.
      await expect(toggle(true, property, context(null))).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      for (const [revoke, restore, id] of [
        [
          `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["pms.finance.manage"]}' WHERE user_id=$1`,
          "UPDATE identity.organization_memberships SET permission_overrides=NULL WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.organization_memberships SET pms_access_enabled=FALSE WHERE user_id=$1",
          "UPDATE identity.organization_memberships SET pms_access_enabled=TRUE WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE product='pms' AND resource_id=$1::text",
          "UPDATE identity.organization_resource_links SET status='active' WHERE product='pms' AND resource_id=$1::text",
          property,
        ],
        [
          "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
          "UPDATE identity.organizations SET status='active' WHERE id=$1",
          org,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        await expect(toggle(true)).rejects.toBeInstanceOf(AuthorizationError);
        await admin.query(restore, [id]);
      }
      expect(await toggle(true)).toMatchObject({ isActive: true });
      expect(await audits()).toHaveLength(4);
    } finally {
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
