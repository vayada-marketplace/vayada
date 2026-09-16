import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg, { type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockReplacementPricingAuthorization } from "./replacementPricingAuthorization.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("replacement pricing live identity authorization", () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  afterAll(() => pool.end());
  async function fixture(work: (client: PoolClient, context: RequestContext, scope: { organizationId: string; propertyId: string; actorUserId: string }) => Promise<void>, roleKey = "front_desk") {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const client = await pool.connect();
    const organizationId = randomUUID(), propertyId = randomUUID(), actorUserId = randomUUID(), membershipId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Pricing access')", [actorUserId, `${actorUserId}@example.test`]);
      await client.query("INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Pricing access',$2)", [organizationId, organizationId]);
      await client.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Pricing access')", [propertyId]);
      await client.query(`INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,access_origin,property_access_mode)
        VALUES($1,$2,$3,$4,'agency','assigned')`, [membershipId, organizationId, actorUserId, roleKey]);
      for (const [product, type] of [["pms", "pms_property"], ["hotel_catalog", "property"]]) {
        await client.query(`INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship)
          VALUES($1,$2,$3,$4,'owner')`, [organizationId, product, type, propertyId]);
      }
      await client.query("INSERT INTO identity.membership_property_assignments(membership_id,property_id) VALUES($1,$2)", [membershipId, propertyId]);
      await client.query(`INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key)
        VALUES($1,'pms','property-management')`, [organizationId]);
      for (const permission of ["pms.room_status.read", "pms.rooms_rates.read", "pms.rooms_rates.manage"]) {
        await client.query(`INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key)
          VALUES('hotel_group',$2,$1) ON CONFLICT DO NOTHING`, [permission, roleKey]);
      }
      const context: RequestContext = {
        actor: { internalUserId: actorUserId, email: "pricing@example.test", status: "active", providerIdentity: { provider: "workos", providerUserId: "test-user" } },
        selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
        membership: { membershipId, status: "active", roleKey, workosRoleSlugs: [], permissions: ["pms.rooms_rates.read", "pms.rooms_rates.manage"] },
        linkedResources: [{ product: "pms", resourceType: "pms_property", resourceId: propertyId, relationship: "owner", status: "active" }],
        entitlements: [{ product: "pms", key: "property-management", status: "active" }],
        locale: "en", currency: "EUR", audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
      };
      await work(client, context, { organizationId, propertyId, actorUserId });
    } finally {
      try {
        await client.query("ROLLBACK");
        if (roleKey !== "front_desk") {
          for (const [table, column, value] of [
            ["membership_property_assignments", "membership_id", membershipId],
            ["organization_memberships", "id", membershipId],
            ["product_entitlements", "organization_id", organizationId],
            ["organization_resource_links", "organization_id", organizationId],
            ["role_permission_grants", "role_key", roleKey],
            ["organizations", "id", organizationId], ["users", "id", actorUserId],
          ]) await client.query(`DELETE FROM identity.${table} WHERE ${column}=$1`, [value]);
          await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
        }
      } finally { client.release(); }
    }
  }
  it("requires authenticated context matching the selected scope", async () => fixture(async (client, context, scope) => {
    expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
    const denied = [null, { ...context, entitlements: [] }, { ...context, linkedResources: [] },
      { ...context, membership: { ...context.membership, permissions: [] } },
      { ...context, actor: { ...context.actor, internalUserId: randomUUID() } }];
    for (const candidate of denied) expect(await lockReplacementPricingAuthorization(client, candidate, scope, "manage")).toBe(false);
    for (const key of ["propertyId", "organizationId", "actorUserId"] as const) {
      expect(await lockReplacementPricingAuthorization(client, context, { ...scope, [key]: randomUUID() }, "manage")).toBe(false);
    }
  }));
  it("rejects live revocations even when the authenticated context still allows access", async () => fixture(async (client, context, scope) => {
    const mutations = [
      "UPDATE identity.users SET status='suspended' WHERE id=$1",
      "UPDATE identity.organizations SET status='suspended' WHERE id=$2",
      "UPDATE identity.organization_memberships SET status='inactive' WHERE user_id=$1",
      "UPDATE hotel_catalog.properties SET profile_status='disabled' WHERE id=$3",
      "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$2 AND product='pms'",
      "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$2 AND product='hotel_catalog'",
      "DELETE FROM identity.membership_property_assignments WHERE property_id=$3",
      "UPDATE identity.product_entitlements SET status='expired' WHERE organization_id=$2",
      "UPDATE identity.product_entitlements SET starts_at=now()+interval '1 day' WHERE organization_id=$2",
      "UPDATE identity.product_entitlements SET expires_at=now()-interval '1 day' WHERE organization_id=$2",
      "DELETE FROM identity.product_entitlements WHERE organization_id=$2",
      "UPDATE identity.organization_memberships SET permission_overrides='{\"grant\":[],\"deny\":[\"pms.rooms_rates.manage\"]}' WHERE user_id=$1",
      "UPDATE identity.organization_memberships SET permission_overrides='{}' WHERE user_id=$1",
    ];
    for (const sql of mutations) {
      await client.query("SAVEPOINT revoke");
      // A CTE types all three parameters even when a mutation uses only one.
      await client.query(`WITH scope AS (SELECT $1::uuid,$2::uuid,$3::uuid) ${sql}`, [scope.actorUserId, scope.organizationId, scope.propertyId]);
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage"), sql).toBe(false);
      await client.query("ROLLBACK TO SAVEPOINT revoke");
    }
  }));
  it("honors granular read access and validated grants while suspension wins", async () => fixture(async (client, context, scope) => {
    await client.query("DELETE FROM identity.role_permission_grants WHERE role_key='front_desk' AND permission_key='pms.rooms_rates.manage'");
    expect(await lockReplacementPricingAuthorization(client, context, scope, "read")).toBe(true);
    expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(false);
    await client.query(`UPDATE identity.organization_memberships SET permission_overrides='{"grant":["pms.rooms_rates.manage"],"deny":[]}' WHERE id=$1`, [context.membership.membershipId]);
    expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
    await client.query(`INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
      VALUES($1,'pms','property-management','suspended','pms','pms_property',$2)`, [scope.organizationId, scope.propertyId]);
    expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(false);
  }));
  it("holds live authorization locks until transaction end", async () => fixture(async (client, context, scope) => {
    await client.query(`INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status)
      VALUES($1,'booking','test-unrelated','suspended')`, [scope.organizationId]);
    // Commit only synthetic fixture rows so a second session can attempt revocation.
    await client.query("COMMIT"); await client.query("BEGIN");
    expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(true);
    const concurrent = await pool.connect();
    try {
      await concurrent.query("SET statement_timeout='150ms'");
      await expect(concurrent.query("UPDATE identity.organizations SET status='suspended' WHERE id=$1", [scope.organizationId])).rejects.toMatchObject({ code: "57014" });
      await expect(concurrent.query("UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1", [scope.organizationId])).rejects.toMatchObject({ code: "57014" });
      await expect(concurrent.query(`INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status)
        VALUES($1,'pms','pms-core','suspended')`, [scope.organizationId])).rejects.toMatchObject({ code: "57014" });
      await expect(concurrent.query(`UPDATE identity.product_entitlements SET product='pms',entitlement_key='account_access'
        WHERE organization_id=$1 AND entitlement_key='test-unrelated'`, [scope.organizationId])).rejects.toMatchObject({ code: "57014" });
      await client.query("ROLLBACK");
      await concurrent.query("UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1", [scope.organizationId]);
      await client.query("BEGIN");
      expect(await lockReplacementPricingAuthorization(client, context, scope, "manage")).toBe(false);
    } finally { await concurrent.query("RESET statement_timeout"); concurrent.release(); }
  }, `pricing_test_${randomUUID()}`));
});
