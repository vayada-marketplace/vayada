import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  createBookingPricingAuthorityStore,
  lockBookingPricingAuthority,
} from "./bookingPricingAuthority.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("Booking pricing authority PostgreSQL owner", () => {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const organizationId = randomUUID(),
      propertyId = randomUUID(),
      actorUserId = randomUUID(),
      membershipId = randomUUID(),
      roleKey = "authority_" + randomUUID();
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Authority test')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Authority test',$2)",
      [organizationId, organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Authority test')",
      [propertyId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,access_origin,property_access_mode)
      VALUES($1,$2,$3,$4,'agency','assigned')`,
      [membershipId, organizationId, actorUserId, roleKey],
    );
    for (const [product, type] of [
      ["pms", "pms_property"],
      ["hotel_catalog", "property"],
    ])
      await pool.query(
        `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship) VALUES($1,$2,$3,$4,'owner')`,
        [organizationId, product, type, propertyId],
      );
    await pool.query(
      "INSERT INTO identity.membership_property_assignments(membership_id,property_id) VALUES($1,$2)",
      [membershipId, propertyId],
    );
    await pool.query(
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO identity.role_permission_grants(organization_kind,role_key,permission_key) VALUES('hotel_group',$1,'pms.rooms_rates.manage')",
      [roleKey],
    );
    const context: RequestContext = {
      actor: {
        internalUserId: actorUserId,
        email: "authority@example.test",
        status: "active",
        providerIdentity: { provider: "workos", providerUserId: "test-user" },
      },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId,
        status: "active",
        roleKey,
        workosRoleSlugs: [],
        permissions: ["pms.rooms_rates.manage"],
      },
      linkedResources: [
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      locale: "en",
      currency: "EUR",
      audit: { requestId: randomUUID(), source: "web", receivedAt: new Date().toISOString() },
    };
    const scope = { organizationId, propertyId, actorUserId },
      store = createBookingPricingAuthorityStore(pool);
    const command = { requestId: randomUUID(), expectedRevision: null, authority: "vayada" };
    const read = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        return await lockBookingPricingAuthority(client, propertyId);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    return { context, scope, store, command, read };
  }
  it("defaults to unconfigured and preserves revisioned choices and historical retry", async () => {
    const f = await fixture();
    expect(await f.read()).toEqual({
      authority: "unconfigured",
      revision: null,
      organizationId: null,
    });
    const first = await f.store.save(f.context, f.scope, f.command);
    expect(await f.read()).toEqual({
      authority: "vayada",
      revision: first.revision,
      organizationId: f.scope.organizationId,
    });
    const second = await f.store.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: first.revision,
      authority: "external",
    });
    expect(await f.read()).toEqual({
      authority: "external",
      revision: second.revision,
      organizationId: f.scope.organizationId,
    });
    expect(await f.store.save(f.context, f.scope, f.command)).toEqual({ ...first, replayed: true });
    expect((await f.read()).revision).toBe(second.revision);
    await expect(
      f.store.save(f.context, f.scope, { ...f.command, authority: "external" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await f.store.save(f.context, f.scope, {
      requestId: randomUUID(),
      expectedRevision: second.revision,
      authority: "unconfigured",
    });
    expect((await f.read()).authority).toBe("unconfigured");
    const rows = (
      await pool.query(
        "SELECT authority,actor_user_id,organization_id FROM booking.pricing_authority_revisions WHERE property_id=$1",
        [f.scope.propertyId],
      )
    ).rows;
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (r) =>
          r.actor_user_id === f.scope.actorUserId && r.organization_id === f.scope.organizationId,
      ),
    ).toBe(true);
  });
  it("serializes competing choices and rejects stale expected revisions", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.store.save(f.context, f.scope, f.command),
      f.store.save(f.context, f.scope, {
        ...f.command,
        requestId: randomUUID(),
        authority: "external",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale" },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM booking.pricing_authority_revisions WHERE property_id=$1",
          [f.scope.propertyId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("keeps a reader's authority stable until its transaction releases the property lock", async () => {
    const f = await fixture(),
      first = await f.store.save(f.context, f.scope, f.command);
    const command = {
      requestId: randomUUID(),
      expectedRevision: first.revision,
      authority: "external",
    };
    const limited = new pg.Pool({
      connectionString: url,
      max: 1,
      options: "-c lock_timeout=100ms",
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await lockBookingPricingAuthority(client, f.scope.propertyId)).toEqual({
        authority: "vayada",
        revision: first.revision,
        organizationId: f.scope.organizationId,
      });
      await expect(
        createBookingPricingAuthorityStore(limited).save(f.context, f.scope, command),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(await lockBookingPricingAuthority(client, f.scope.propertyId)).toEqual({
        authority: "vayada",
        revision: first.revision,
        organizationId: f.scope.organizationId,
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await limited.end();
    }
    await f.store.save(f.context, f.scope, command);
    expect((await f.read()).authority).toBe("external");
  });
  it("checks live authorization even on an accepted retry and denies foreign scope", async () => {
    const f = await fixture();
    for (const context of [
      null,
      { ...f.context, membership: { ...f.context.membership, permissions: [] } },
      { ...f.context, entitlements: [] },
    ]) {
      await expect(f.store.save(context, f.scope, f.command)).rejects.toMatchObject({
        code: "denied",
      });
    }
    await expect(
      f.store.save(f.context, { ...f.scope, propertyId: randomUUID() }, f.command),
    ).rejects.toMatchObject({ code: "denied" });
    await f.store.save(f.context, f.scope, f.command);
    await pool.query("UPDATE identity.organization_memberships SET status='inactive' WHERE id=$1", [
      f.context.membership.membershipId,
    ]);
    await expect(f.store.save(f.context, f.scope, f.command)).rejects.toMatchObject({
      code: "denied",
    });
  });
  it("rejects malformed commands before a write", async () => {
    const f = await fixture();
    for (const change of [
      { authority: "automatic" },
      { expectedRevision: "1" },
      { requestId: " " },
      { propertyId: f.scope.propertyId },
    ]) {
      await expect(
        f.store.save(f.context, f.scope, { ...f.command, ...change }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await f.read()).toEqual({
      authority: "unconfigured",
      revision: null,
      organizationId: null,
    });
  });
});
