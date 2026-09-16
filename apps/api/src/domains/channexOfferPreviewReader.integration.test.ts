import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { readChannexOfferPreview } from "./channexOfferPreviewReader.js";
import { lockReplacementPricingSources } from "./replacementPricingStorageGuard.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("channel preview published reader", () => {
  const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 200 });
  afterAll(() => pool.end());
  async function fixture(published = true) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const actorUserId = randomUUID(),
      organizationId = randomUUID(),
      propertyId = randomUUID(),
      roomTypeId = randomUUID(),
      membershipId = randomUUID();
    const roleKey = `terms_test_${randomUUID()}`,
      scope = { actorUserId, organizationId, propertyId };
    await pool.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Terms test')", [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await pool.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Terms test',$2)",
      [organizationId, organizationId],
    );
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Terms test')",
      [propertyId],
    );
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Terms room')", [
      roomTypeId,
      propertyId,
    ]);
    await pool.query(
      `INSERT INTO identity.organization_memberships(id,organization_id,user_id,role_key,property_access_mode,access_origin)
      VALUES($1,$2,$3,$4,'all','agency')`,
      [membershipId, organizationId, actorUserId, roleKey],
    );
    for (const permission of ["pms.rooms_rates.read", "pms.operations.read"])
      await pool.query(
        `INSERT INTO identity.role_permission_grants
      (organization_kind,role_key,permission_key) VALUES('hotel_group',$1,$2)`,
        [roleKey, permission],
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
      "INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES($1,'pms','property-management')",
      [organizationId],
    );
    const context: RequestContext = {
      actor: {
        internalUserId: actorUserId,
        email: "terms@example.test",
        status: "active",
        providerIdentity: { provider: "workos", providerUserId: "test-user" },
      },
      selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
      membership: {
        membershipId,
        roleKey,
        status: "active",
        permissions: ["pms.rooms_rates.read", "pms.operations.read"],
        workosRoleSlugs: [],
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sources = await lockReplacementPricingSources(client, context, scope, "preview");
      if (!sources) throw new Error("source fixture required");
      if (published) {
        const room = {
          version: "pricing.v2",
          propertyId,
          roomTypeId,
          revision: 1,
          currency: "EUR",
          capacity: { total: 2, adults: 2, children: 0 },
          children: {
            adultFromAge: 18,
            bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "0", countsTowardCapacity: true }],
          },
          offers: [
            {
              id: "flex",
              termsRevision: "terms-test",
              meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
              price: {
                kind: "independent",
                calendar: {
                  base: { mode: "flat", amountMinor: "10000" },
                  months: [],
                  seasons: [],
                  weekdays: [],
                  dates: [],
                },
              },
              restrictions: {
                kind: "own",
                rules: {
                  minArrivalNights: 1,
                  maxStayNights: null,
                  closedToArrival: false,
                  closedToDeparture: false,
                  stopSell: false,
                },
                seasons: [],
                dates: [],
              },
            },
          ],
        };
        // Synthetic storage fixture, not a publication command or provider validation.
        await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [
          propertyId,
        ]);
        await client.query(
          `INSERT INTO pms.pricing_v2_revisions(property_id,revision,room_count,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id)
          VALUES($1,1,1,'EUR',$2,'{"finance":"fixture"}',$3,$4,$5)`,
          [propertyId, JSON.stringify(sources), randomUUID(), "a".repeat(64), actorUserId],
        );
        await client.query(
          `INSERT INTO pms.pricing_v2_rooms(property_id,revision,room_type_id,currency,configuration)
          VALUES($1,1,$2,'EUR',$3)`,
          [propertyId, roomTypeId, JSON.stringify(room)],
        );
        await client.query("UPDATE pms.pricing_v2_heads SET revision=1 WHERE property_id=$1", [
          propertyId,
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return {
      scope,
      context,
      roomTypeId,
      roleKey,
      read: () => readChannexOfferPreview(pool, context, propertyId),
    };
  }
  it("reads a detached current publication and creates no events or pricing writes", async () => {
    const f = await fixture();
    const result = await f.read();
    expect(result).toMatchObject({
      revision: 1,
      stale: false,
      rooms: [{ roomTypeId: f.roomTypeId }],
    });
    (result!.sources as Record<string, string>).room = "caller mutation";
    expect((await f.read())!.sources.room).not.toBe("caller mutation");
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM platform.domain_events WHERE property_id=$1) AS events,
      (SELECT count(*)::int FROM pms.pricing_v2_revisions WHERE property_id=$1) AS revisions,
      (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1) AS audits,
      (SELECT count(*)::int FROM platform.outbox_events WHERE property_id=$1) AS outbox`,
        [f.scope.propertyId],
      )
    ).rows[0];
    expect(counts).toEqual({ events: 0, revisions: 1, audits: 0, outbox: 0 });
  });
  it("returns null without a publication and detects changed room and finance source evidence", async () => {
    expect(await (await fixture(false)).read()).toBeNull();
    const f = await fixture();
    await pool.query(
      "UPDATE pms.room_types SET room_facts_revision=room_facts_revision+1 WHERE id=$1",
      [f.roomTypeId],
    );
    expect(await f.read()).toMatchObject({ stale: true });
    const finance = await fixture();
    await pool.query(
      "INSERT INTO finance.payment_settings(property_id,default_currency) VALUES($1,'EUR')",
      [finance.scope.propertyId],
    );
    expect(await finance.read()).toMatchObject({ stale: true });
  });
  it("requires both live database grants even when request context still permits them", async () => {
    for (const permission of ["pms.rooms_rates.read", "pms.operations.read"]) {
      const f = await fixture();
      await pool.query(
        "DELETE FROM identity.role_permission_grants WHERE role_key=$1 AND permission_key=$2",
        [f.roleKey, permission],
      );
      await expect(f.read()).rejects.toMatchObject({ code: "denied" });
    }
    const f = await fixture();
    await expect(
      readChannexOfferPreview(
        pool,
        {
          ...f.context,
          membership: { ...f.context.membership, permissions: ["pms.rooms_rates.read"] },
        },
        f.scope.propertyId,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    await pool.query(
      `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["pms.operations.read"]}' WHERE id=$1`,
      [f.context.membership.membershipId],
    );
    await expect(f.read()).rejects.toMatchObject({ code: "denied" });
  });
  it("isolates properties and organizations and rejects revoked access", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      readChannexOfferPreview(pool, f.context, other.scope.propertyId),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      readChannexOfferPreview(
        pool,
        { ...f.context, selectedOrganization: other.context.selectedOrganization },
        f.scope.propertyId,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    await pool.query(
      "UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=$1",
      [f.scope.organizationId],
    );
    await expect(f.read()).rejects.toMatchObject({ code: "denied" });
  });
  it("bounds lock contention and releases failed connections", async () => {
    const f = await fixture(),
      lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("UPDATE identity.organizations SET name=name WHERE id=$1", [
        f.scope.organizationId,
      ]);
      const start = performance.now();
      await expect(f.read()).rejects.toMatchObject({ code: "55P03" });
      expect(performance.now() - start).toBeLessThan(2000);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    expect(await f.read()).toMatchObject({ stale: false });
  });
  it("shares one transaction deadline across slow source queries", async () => {
    const f = await fixture();
    const slow = new Proxy(pool, {
      get(target, key) {
        if (key !== "connect") return Reflect.get(target, key);
        return async () => {
          const connection = await target.connect();
          return new Proxy(connection, {
            get(client, member) {
              if (member !== "query") return Reflect.get(client, member);
              return async (query: pg.QueryConfig) => {
                if (query.text.startsWith("SELECT set_config"))
                  await client.query("SELECT pg_sleep(0.3)");
                return client.query(query);
              };
            },
          });
        };
      },
    });
    const start = performance.now();
    await expect(readChannexOfferPreview(slow, f.context, f.scope.propertyId)).rejects.toThrow();
    expect(performance.now() - start).toBeGreaterThan(4500);
    expect(performance.now() - start).toBeLessThan(7000);
    expect(await f.read()).toMatchObject({ stale: false });
  });
  it("requires bounded acquisition and expires a saturated pool without leaking a waiter", async () => {
    const f = await fixture(),
      unbounded = new pg.Pool({ connectionString: url });
    try {
      await expect(
        readChannexOfferPreview(unbounded, f.context, f.scope.propertyId),
      ).rejects.toThrow("Bounded preview pool required");
    } finally {
      await unbounded.end();
    }
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    try {
      await expect(f.read()).rejects.toThrow();
      expect(pool.waitingCount).toBe(0);
    } finally {
      clients.forEach((client) => client.release());
    }
    expect(await f.read()).toMatchObject({ stale: false });
  });
});
