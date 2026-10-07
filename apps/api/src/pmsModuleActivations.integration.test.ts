import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { hasActiveEntitlement } from "@vayada/backend-authorization";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";
import { createPgBookingWebAffiliateHotelResolver } from "./routes/bookingWebAffiliate.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("Feature Hub data preservation", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const propertyId = randomUUID();
  const organizationId = randomUUID();
  const slug = `vay851-${propertyId}`;
  const context = {
    actor: { internalUserId: randomUUID() },
    selectedOrganization: { organizationId },
  } as RequestContext;
  const repository = createPgPmsModuleActivationRepository({
    connectionString: databaseUrl ?? "postgresql://test-disabled",
    pool: client,
  });
  const resolver = createPgBookingWebAffiliateHotelResolver({
    connectionString: databaseUrl ?? "postgresql://test-disabled",
    pool: client,
  });
  beforeAll(async () => {
    if (!/(test|verify)/i.test(new URL(databaseUrl!).pathname))
      throw new Error("Refusing non-test database");
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1, 'hotel_group', 'Toggle test', $2, 'active')`,
      [organizationId, slug],
    );
    await client.query("INSERT INTO identity.users (id, email) VALUES ($1, $2)", [
      context.actor.internalUserId,
      `toggle-${propertyId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, $2, 'Toggle test')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status) VALUES ($1, $2, 'canonical', 'active')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (property_id, public_id, display_name, canonical_slug, default_locale, supported_locales, profile_status) VALUES ($1, $2, 'Toggle test', $2, 'en', ARRAY['en'], 'complete')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES ($1, 'pms', 'pms_property', $2, 'owner', 'active'), ($1, 'booking', 'booking_hotel', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at)
       VALUES ($1, 'pms', 'module:affiliates', 'active', 'pms', 'pms_property', $2, now())`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO marketplace.property_affiliates (property_id, affiliate_id, referral_code, display_name, contact_email, lifecycle_status, application_source) VALUES ($1, 'existing-partner', 'retained-code', 'Existing Partner', 'partner@example.test', 'approved', 'public_registration')`,
      [propertyId],
    );
  });
  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });
  it("reads existing activation and public affiliate capability without changing partner history", async () => {
    const snapshot = () =>
      client.query(`SELECT * FROM marketplace.property_affiliates WHERE property_id = $1`, [
        propertyId,
      ]);
    const before = (await snapshot()).rows;
    expect((await repository.list(context, propertyId))[0].isActive).toBe(true);
    expect(await resolver.findProfileBySlug(slug)).toMatchObject({
      hotel: { capabilities: { referralCodes: true } },
    });
    expect((await snapshot()).rows).toEqual(before);
  });

  it("writes Financials activation and rollback with atomic audit evidence", async () => {
    const activated = await repository.updateFinancials(context, propertyId, true);
    expect(activated).toMatchObject({ moduleId: "financials", isActive: true });
    expect(
      (await repository.list(context, propertyId)).find((row) => row.moduleId === "financials"),
    ).toMatchObject({ isActive: true });

    const badActor = {
      ...context,
      actor: { internalUserId: randomUUID() },
    } as RequestContext;
    await client.query("SAVEPOINT before_bad_actor");
    await expect(repository.updateFinancials(badActor, propertyId, false)).rejects.toThrow();
    await client.query("ROLLBACK TO SAVEPOINT before_bad_actor");
    expect(
      (await repository.list(context, propertyId)).find((row) => row.moduleId === "financials"),
    ).toMatchObject({ isActive: true });

    const deactivated = await repository.updateFinancials(context, propertyId, false);
    expect(deactivated).toMatchObject({ moduleId: "financials", isActive: false });
    const audit = await client.query(
      `SELECT action, redacted_payload, audit_metadata
         FROM platform.product_audit_events
        WHERE product = 'pms'
          AND property_id = $1
          AND action LIKE 'financials_module_%'
        ORDER BY action`,
      [propertyId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual([
      "financials_module_activated",
      "financials_module_deactivated",
    ]);
    expect(audit.rows.every((row) => row.redacted_payload.moduleId === "financials")).toBe(true);
    expect(
      audit.rows.every(
        (row) =>
          row.audit_metadata.organizationId === organizationId &&
          typeof row.audit_metadata.entitlementId === "string",
      ),
    ).toBe(true);
    const count = await client.query(
      `SELECT count(*)::integer AS count FROM identity.product_entitlements
        WHERE organization_id = $1 AND resource_id = $2 AND entitlement_key = 'module:financials'`,
      [organizationId, propertyId],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("rolls back a global grant for one property without changing the global row", async () => {
    await client.query("SAVEPOINT before_global_grant_rollback");
    try {
      await client.query(
        `DELETE FROM identity.product_entitlements
          WHERE organization_id = $1 AND resource_id = $2
            AND entitlement_key = 'module:financials'`,
        [organizationId, propertyId],
      );
      await client.query(
        `INSERT INTO identity.product_entitlements
          (organization_id, product, entitlement_key, status)
         VALUES ($1, 'pms', 'module:financials', 'active')`,
        [organizationId],
      );
      await client.query(
        `INSERT INTO identity.product_entitlements
          (organization_id, product, entitlement_key, status,
           resource_product, resource_type, resource_id, starts_at)
         VALUES ($1, 'pms', 'module:financials', 'active',
                 'pms', 'pms_property', $2, now() + interval '1 day')`,
        [organizationId, propertyId],
      );
      expect(await repository.updateFinancials(context, propertyId, false)).toMatchObject({
        moduleId: "financials",
        isActive: false,
      });
      const rows = await client.query(
        `SELECT status, resource_id AS "resourceId", starts_at AS "startsAt", expires_at AS "expiresAt"
           FROM identity.product_entitlements
          WHERE organization_id = $1 AND entitlement_key = 'module:financials'
          ORDER BY resource_id NULLS FIRST`,
        [organizationId],
      );
      expect(rows.rows).toEqual([
        { status: "active", resourceId: null, startsAt: null, expiresAt: null },
        { status: "suspended", resourceId: propertyId, startsAt: null, expiresAt: null },
      ]);
      const loaded = await client.query(
        `SELECT
           CASE WHEN expires_at IS NOT NULL AND expires_at <= now()
             THEN 'expired' ELSE status END AS status,
           resource_id AS "resourceId"
         FROM identity.product_entitlements
         WHERE organization_id = $1 AND entitlement_key = 'module:financials'
           AND (starts_at IS NULL OR starts_at <= now())`,
        [organizationId],
      );
      const entitlements = loaded.rows.map((row) => ({
        product: "pms" as const,
        key: "module:financials",
        status: row.status as "active" | "suspended" | "expired",
        ...(row.resourceId
          ? {
              resource: {
                product: "pms" as const,
                resourceType: "pms_property" as const,
                resourceId: row.resourceId as string,
              },
            }
          : {}),
      }));
      expect(
        hasActiveEntitlement(
          { ...context, entitlements },
          {
            product: "pms",
            key: "module:financials",
            resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
          },
        ),
      ).toBe(false);
      const readiness = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM identity.product_entitlements active
           WHERE active.organization_id = $1 AND active.product = 'pms'
             AND active.entitlement_key = 'module:financials'
             AND active.status = 'active' AND active.resource_product IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM identity.product_entitlements suspended
               WHERE suspended.organization_id = $1 AND suspended.product = 'pms'
                 AND suspended.entitlement_key = 'module:financials'
                 AND suspended.status = 'suspended'
                 AND suspended.resource_product = 'pms'
                 AND suspended.resource_type = 'pms_property'
                 AND suspended.resource_id = $2
                 AND (suspended.expires_at IS NULL OR suspended.expires_at > now())
             )
         ) AS enabled`,
        [organizationId, propertyId],
      );
      expect(readiness.rows[0].enabled).toBe(false);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT before_global_grant_rollback");
    }
  });
});
