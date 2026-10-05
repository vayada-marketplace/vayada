import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { assertHotelSetupLogoScope } from "./hotelSetupCommandScope.js";
import { createHotelSetupLogoCredentialResolver } from "./hotelSetupCommandCredentials.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("actor-bound native logo authority", () => {
  it("locks only its current Account Owner and canonical property without requiring PMS", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const role = `vayada_next_hotel_setup_logo_${suffix}`;
    const organizationId = randomUUID();
    const actorId = randomUUID();
    const propertyId = randomUUID();
    const password = randomUUID();
    let login: pg.Pool | undefined;
    let created = false;
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Logo test',$2)",
        [organizationId, `logo-${suffix}`],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        actorId,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled,booking_access_enabled) VALUES($1,$2,'hotel_owner','agency','all',FALSE,FALSE)",
        [organizationId, actorId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1,$2,'Logo fixture',$3)",
        [propertyId, `logo-${suffix}`, organizationId],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [organizationId, propertyId],
      );
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      created = true;
      await admin.query(
        `GRANT vayada_next_hotel_setup_logo_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      await admin.query(
        "INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class,actor_user_id,credential_role_oid,credential_secret_version,credential_ready_at) SELECT $1,$2,$3,'property_logo',$4,oid,$5,now() FROM pg_roles WHERE rolname=$1",
        [role, propertyId, organizationId, actorId, randomUUID()],
      );
      const connection = new URL(url);
      connection.username = role;
      connection.password = password;
      login = new pg.Pool({ connectionString: connection.toString(), max: 1 });
      const allowed = async (
        property = propertyId,
        organization = organizationId,
        actor = actorId,
      ) =>
        (
          await login!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_logo_row_allowed($1,$2,$3) AS allowed",
            [property, organization, actor],
          )
        ).rows[0]!.allowed;
      expect(await allowed()).toBe(true);
      const sessionId = randomUUID();
      const sessionMetadata = {
        sessionId,
        purpose: "property.logo",
        actorUserId: actorId,
        ownerOrganizationId: organizationId,
        requestedVisibility: "private",
        effectiveVisibility: "private",
        stagingPrefix: `staging/${sessionId}`,
        resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          propertyId,
        },
      };
      const bound = async (metadata: unknown) =>
        (
          await login!.query<{ allowed: boolean }>(
            "SELECT platform.hotel_setup_logo_session_binding($1,$2,$3,$4,$5::jsonb) AS allowed",
            [sessionId, propertyId, organizationId, actorId, JSON.stringify(metadata)],
          )
        ).rows[0]!.allowed;
      expect(await bound(sessionMetadata)).toBe(true);
      for (const metadata of [
        null,
        {},
        [],
        { ...sessionMetadata, sessionId: randomUUID() },
        { ...sessionMetadata, purpose: "property.gallery_image" },
        { ...sessionMetadata, actorUserId: randomUUID() },
        { ...sessionMetadata, ownerOrganizationId: randomUUID() },
        { ...sessionMetadata, requestedVisibility: "public" },
        { ...sessionMetadata, effectiveVisibility: "public" },
        { ...sessionMetadata, platformAdmin: false },
        { ...sessionMetadata, stagingPrefix: "staging/foreign" },
        { ...sessionMetadata, resource: null },
        { ...sessionMetadata, resource: [] },
        { ...sessionMetadata, target: "property" },
        { ...sessionMetadata, target: [] },
        { ...sessionMetadata, resource: { ...sessionMetadata.resource, propertyId: null } },
        { ...sessionMetadata, resource: { ...sessionMetadata.resource, propertyId: randomUUID() } },
        {
          ...sessionMetadata,
          resource: { ...sessionMetadata.resource, targetResourceId: randomUUID() },
        },
        { ...sessionMetadata, target: { ...sessionMetadata.target, propertyId: randomUUID() } },
      ])
        expect(await bound(metadata)).toBe(false);
      for (let index = 0; index < 4; index++) {
        const values: unknown[] = [
          sessionId,
          propertyId,
          organizationId,
          actorId,
          JSON.stringify(sessionMetadata),
        ];
        values[index] = null;
        expect(
          (
            await login.query<{ allowed: boolean }>(
              "SELECT platform.hotel_setup_logo_session_binding($1,$2,$3,$4,$5::jsonb) AS allowed",
              values,
            )
          ).rows[0]!.allowed,
        ).toBe(false);
      }
      const endpoint = new URL(url);
      endpoint.username = "";
      endpoint.password = "";
      endpoint.search = "";
      const readNativeSecret = vi.fn(async () => ({ username: role, password }));
      const resolve = createHotelSetupLogoCredentialResolver({
        assignments: admin,
        readNativeSecret,
        databaseEndpoint: endpoint.toString(),
        secretPrefix: "hotel-setup-command/prod/property/",
      });
      expect(new URL(await resolve(propertyId, organizationId, actorId)).username).toBe(role);
      const denySecret = async () => {
        readNativeSecret.mockClear();
        await expect(resolve(propertyId, organizationId, actorId)).rejects.toThrow(
          "Missing hotel setup logo assignment",
        );
        expect(readNativeSecret).not.toHaveBeenCalled();
      };

      expect(await allowed(randomUUID())).toBe(false);
      expect(await allowed(propertyId, randomUUID())).toBe(false);
      expect(await allowed(propertyId, organizationId, randomUUID())).toBe(false);
      await expect(
        login.query("SET ROLE vayada_next_hotel_setup_logo_scope"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        login.query("SELECT id FROM platform.media_upload_sessions"),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=FALSE WHERE database_login=$1",
        [role],
      );
      expect(await allowed()).toBe(false);
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET active=TRUE,credential_role_oid=(credential_role_oid::bigint+1)::oid WHERE database_login=$1",
        [role],
      );
      expect(await allowed()).toBe(false);
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET credential_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1) WHERE database_login=$1",
        [role],
      );
      await admin.query(
        "UPDATE identity.organization_memberships SET status='inactive' WHERE user_id=$1 AND organization_id=$2",
        [actorId, organizationId],
      );
      expect(await allowed()).toBe(false);
      await denySecret();
      await admin.query(
        "UPDATE identity.organization_memberships SET status='active' WHERE user_id=$1 AND organization_id=$2",
        [actorId, organizationId],
      );
      await admin.query(
        "UPDATE identity.organization_resource_links SET status='suspended' WHERE organization_id=$1 AND resource_id=$2",
        [organizationId, propertyId],
      );
      expect(await allowed()).toBe(false);
      await denySecret();
      await admin.query(
        "UPDATE identity.organization_resource_links SET status='active' WHERE organization_id=$1 AND resource_id=$2",
        [organizationId, propertyId],
      );
      expect(await allowed()).toBe(true);
      await admin.query(`ALTER ROLE ${role} SET statement_timeout='1s'`);
      expect(await allowed()).toBe(false);
      await denySecret();
      await admin.query(`ALTER ROLE ${role} RESET ALL`);
      await admin.query(`ALTER ROLE ${role} VALID UNTIL 'infinity'`);
      expect(await allowed()).toBe(false);
      await denySecret();
      await admin.query("UPDATE pg_catalog.pg_authid SET rolvaliduntil=NULL WHERE rolname=$1", [
        role,
      ]);
      expect(await allowed()).toBe(true);
      // A command holds current Owner authority until its transaction finishes.
      const command = await login.connect();
      try {
        await command.query("BEGIN");
        await assertHotelSetupLogoScope(command, {
          propertyId,
          organizationId,
          actorUserId: actorId,
        });
        await admin.query("BEGIN");
        await admin.query("SET LOCAL lock_timeout='100ms'");
        await expect(
          admin.query(
            "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1 AND user_id=$2",
            [organizationId, actorId],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
        await admin.query("ROLLBACK");
        await command.query("COMMIT");
      } finally {
        await command.query("ROLLBACK");
        command.release();
      }
    } finally {
      await login?.end();
      await admin.query(
        "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
        [role],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
      await admin.query("DELETE FROM identity.organization_memberships WHERE organization_id=$1", [
        organizationId,
      ]);
      await admin.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      if (created) {
        await admin.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});
