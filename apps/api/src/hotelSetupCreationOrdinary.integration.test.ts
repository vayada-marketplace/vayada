import { randomUUID } from "node:crypto";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import type { SharedPropertyProfileInput } from "./routes/sharedHotelSetupStatus.js";

const url = process.env.TEST_DATABASE_URL;

const profile = (displayName: string): SharedPropertyProfileInput => ({
  displayName,
  propertyType: "hotel",
  location: {
    countryCode: "LK",
    city: "Galle",
    streetAddress: "",
    postalCode: "",
    timezone: "Asia/Colombo",
    latitude: null,
    longitude: null,
    localityPublic: false,
    geoPublic: false,
    mapDisplayMode: "hidden",
  },
  contacts: [],
});

describe.skipIf(!url)("ordinary self-serve hotel creation (VAY-2056)", () => {
  it("creates a hotel for the current Owner and leaves admin provisioning unchanged", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const pool = new pg.Pool({ connectionString: fixture.connectionString, max: 2 });
    const selfServe = createPgSharedHotelSetupStatusRepository({
      connectionString: fixture.connectionString,
      pool,
      hotelSetupOwnerCreation: true,
    });
    const provisioning = createPgSharedHotelSetupStatusRepository({
      connectionString: fixture.connectionString,
      pool,
    });
    const suffix = randomUUID().replaceAll("-", "");
    const [org, owner, stranger, platformAdmin] = [1, 2, 3, 4].map(() => randomUUID());
    const create = (key: string, actorUserId = owner, name = "Self-serve hotel") =>
      selfServe.createPropertyProfile({
        organizationId: org,
        idempotencyKey: `${key}-${suffix}`,
        correlationId: `request-${suffix}`,
        profile: profile(name),
        audit: {
          actorUserId,
          requestId: `request-${suffix}`,
          receivedAt: new Date().toISOString(),
        },
      });
    const links = async (propertyId: string) =>
      (
        await admin.query(
          "SELECT product,relationship,status FROM identity.organization_resource_links WHERE resource_id=$1 ORDER BY product",
          [propertyId],
        )
      ).rows;
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Creation fixture',$2)",
        [org, `n${suffix}`],
      );
      for (const [id, email] of [
        [owner, `o${suffix}@example.test`],
        [stranger, `s${suffix}@example.test`],
        [platformAdmin, `a${suffix}@example.test`],
      ])
        await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [id, email]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode) VALUES($1,$2,'hotel_owner','agency','all')",
        [org, owner],
      );

      // The current Owner creates a hotel; the native-era owner-link trigger records it.
      const created = await create("first");
      expect(created.profile.displayName).toBe("Self-serve hotel");
      expect(await links(created.propertyId)).toEqual([
        { product: "hotel_catalog", relationship: "owner", status: "active" },
      ]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM platform.product_audit_events WHERE action='hotel_setup.property.create' AND target_resource_id=$1 AND actor_user_id=$2",
            [created.propertyId, owner],
          )
        ).rows[0].n,
      ).toBe(1);
      // A retry returns the same hotel; a changed request under the same key conflicts.
      expect((await create("first")).propertyId).toBe(created.propertyId);
      await expect(create("first", owner, "Changed")).rejects.toMatchObject({
        code: "idempotency_key_conflict",
        propertyId: created.propertyId,
      });

      // A non-member, a revoked permission and a suspended organization are refused.
      await expect(create("stranger", stranger)).rejects.toBeInstanceOf(AuthorizationError);
      await admin.query(
        `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["hotel_catalog.setup.manage"]}' WHERE user_id=$1`,
        [owner],
      );
      await expect(create("revoked")).rejects.toBeInstanceOf(AuthorizationError);
      await admin.query(
        "UPDATE identity.organization_memberships SET permission_overrides=NULL WHERE user_id=$1",
        [owner],
      );
      await admin.query("UPDATE identity.organizations SET status='suspended' WHERE id=$1", [org]);
      await expect(create("suspended")).rejects.toThrow(
        "Active hotel-group organization was not found",
      );
      await admin.query("UPDATE identity.organizations SET status='active' WHERE id=$1", [org]);
      // Self-serve never accepts provisioning-only inputs.
      await expect(
        selfServe.createPropertyProfile({
          organizationId: org,
          idempotencyKey: `provision-${suffix}`,
          correlationId: `request-${suffix}`,
          profile: profile("Provisioned"),
          audit: {
            actorUserId: owner,
            requestId: `request-${suffix}`,
            receivedAt: new Date().toISOString(),
            reason: "support",
          },
          targetAccountUserId: owner,
          provisioningReference: `ref-${suffix}`,
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);

      // Regression (review finding 1): the provisioning instance still creates a hotel for a
      // platform admin who is not a member of the hotel's organization.
      const provisioned = await provisioning.createPropertyProfile({
        organizationId: org,
        idempotencyKey: `provision-${suffix}`,
        correlationId: `request-${suffix}`,
        profile: profile("Provisioned"),
        audit: {
          actorUserId: platformAdmin,
          requestId: `request-${suffix}`,
          receivedAt: new Date().toISOString(),
          reason: "support",
        },
        targetAccountUserId: owner,
        provisioningReference: `ref-${suffix}`,
      });
      expect(provisioned.propertyId).not.toBe(created.propertyId);
      expect(await links(provisioned.propertyId)).toEqual([
        { product: "hotel_catalog", relationship: "owner", status: "active" },
      ]);
    } finally {
      await pool.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
