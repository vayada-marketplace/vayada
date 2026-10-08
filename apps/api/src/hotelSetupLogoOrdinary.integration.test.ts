import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createOrdinaryHotelSetupLogoRuntime } from "./hotelSetupLogoRuntime.js";
import { createHotelSetupOrdinaryLoginFixture } from "./hotelSetupOrdinaryLogin.fixture.js";
import type {
  PlatformMediaPersistenceRequest,
  PlatformMediaRoutesOptions,
} from "./routes/platformMedia.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("ordinary logo runtime (VAY-2056)", () => {
  it("claims only logo requests and re-checks the Owner before any logo persistence", async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    const lookup = new pg.Pool({ connectionString: fixture.connectionString, max: 1 });
    const defaults = {
      repository: {},
      targetResolver: {},
      finalizer: {},
    } as unknown as Pick<PlatformMediaRoutesOptions, "repository" | "targetResolver" | "finalizer">;
    const runtime = createOrdinaryHotelSetupLogoRuntime({
      connectionString: fixture.connectionString,
      lookup,
      serving: {
        bucketName: "vay2056-test-bucket",
        cdnBaseUrl: "https://cdn.example.test",
        cdnOriginHost: "origin.example.test",
        publicPathPrefix: "media",
        publicCacheControl: "public, max-age=60",
        privateDownloadTtlSeconds: 60,
        privateDownloadMaxTtlSeconds: 300,
      },
      defaults,
    });
    const resolve = runtime.uploads.resolveRequestPersistence!;
    const suffix = randomUUID().replaceAll("-", "");
    const [org, owner, property] = [1, 2, 3].map(() => randomUUID());
    const context = (roleKey = "hotel_owner") =>
      ({
        actor: { internalUserId: owner, providerIdentity: { sessionId: "verified-session" } },
        selectedOrganization: { organizationId: org, kind: "hotel_group" },
        membership: { roleKey, permissions: ["hotel_catalog.setup.manage"] },
        audit: { requestId: suffix },
      }) as unknown as RequestContext;
    const create = (purpose: string, ctx = context()) =>
      resolve({
        operation: "create",
        context: ctx,
        request: {
          purpose,
          resource: { product: "hotel_catalog", resourceType: "property", resourceId: property },
        },
      } as unknown as PlatformMediaPersistenceRequest);
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Logo fixture',$2)",
        [org, `g${suffix}`],
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
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1::uuid,$1::uuid::text,'Logo fixture',$2)",
        [property, org],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [org, property],
      );

      // Other purposes and unknown sessions keep the shared routes' default persistence.
      expect(await create("property.gallery_image")).toMatchObject({
        repository: defaults.repository,
      });
      expect(
        await resolve({
          operation: "finalize",
          context: context(),
          sessionId: randomUUID(),
        }),
      ).toMatchObject({ repository: defaults.repository });

      // The Owner gets request-bound logo persistence on the ordinary login.
      const persistence = await create("property.logo");
      expect(persistence.repository).not.toBe(defaults.repository);
      await persistence.close();

      // A non-Owner role is refused by the private service's gate; revoked authority by the
      // in-transaction Owner check, before any logo row is written.
      await expect(create("property.logo", context("hotel_manager"))).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      for (const [revoke, restore, id] of [
        [
          "UPDATE identity.organization_resource_links SET status='suspended' WHERE resource_id=$1::text",
          "UPDATE identity.organization_resource_links SET status='active' WHERE resource_id=$1::text",
          property,
        ],
        [
          `UPDATE identity.organization_memberships SET permission_overrides='{"grant":[],"deny":["hotel_catalog.setup.manage"]}' WHERE user_id=$1`,
          "UPDATE identity.organization_memberships SET permission_overrides=NULL WHERE user_id=$1",
          owner,
        ],
        [
          "UPDATE identity.organizations SET status='suspended' WHERE id=$1",
          "UPDATE identity.organizations SET status='active' WHERE id=$1",
          org,
        ],
      ] as const) {
        await admin.query(revoke, [id]);
        await expect(create("property.logo")).rejects.toBeInstanceOf(AuthorizationError);
        await admin.query(restore, [id]);
      }
      expect(
        Number(
          (
            await admin.query(
              "SELECT count(*) AS n FROM platform.media_upload_sessions WHERE property_id=$1",
              [property],
            )
          ).rows[0].n,
        ),
      ).toBe(0);
    } finally {
      await lookup.end();
      await fixture.drop();
      await admin.end();
    }
  }, 30_000);
});
