// Local-only composition: production import/persistence, synthetic identity and source.
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { createPgPropertyAccessRepository } from "@vayada/backend-authorization";
import type { RequestContext } from "@vayada/backend-auth";
import { createPgPreparedImportRepository } from "../../apps/api/src/domains/preparedHotelImportRepository.js";
import { createPgSharedHotelSetupStatusRepository } from "../../apps/api/src/platform/sharedHotelSetupStatusReadModel.js";
import { createPgPmsRoomFactsCommandRepository } from "../../apps/api/src/domains/pmsRoomFactsCommandRepository.js";
import { createPgPmsRoomFactsReadModel } from "../../apps/api/src/domains/pmsRoomFactsReadModel.js";
import { createPmsRoomFactsVocabularyValidationPort } from "../../apps/api/src/domains/pmsRoomFactsVocabulary.js";
import { registerPreparedHotelImportRoutes } from "../../apps/api/src/routes/preparedHotelImports.js";
import { registerPmsOperationsRoutes } from "../../apps/api/src/routes/pmsOperations.js";
import { createTargetPmsOperationsReadRepository } from "../../apps/api/src/domains/pmsOperationsReadModel.js";
import { registerAirbnbImportRoutes } from "../../apps/api/src/routes/airbnbImports.js";
import { createPgAirbnbImportSourceRepository } from "../../apps/api/src/domains/airbnbImportSourceRepository.js";
import { createPgAirbnbImportApplicationRepository } from "../../apps/api/src/domains/airbnbImportApplicationRepository.js";
import { listings } from "./client.js";

const importOrigins = ["https://pms.localhost:1380", "https://marketplace.localhost:1382"];

async function main() {
  // Deliberately fixed isolated endpoint; never accepts a production DSN or provider key.
  const connectionString = "postgresql://postgres@127.0.0.1:59709/vay1009_import_test";
  const db = new pg.Client({ connectionString });
  await db.connect();
  const profiles = createPgSharedHotelSetupStatusRepository({ connectionString });
  const commandPort = createPgPmsRoomFactsCommandRepository({
    connectionString,
    vocabularyValidator: createPmsRoomFactsVocabularyValidationPort(),
  });
  const readPort = createPgPmsRoomFactsReadModel({ connectionString });
  const repository = createPgPreparedImportRepository(connectionString);
  const actor = "10090000-0000-4000-8000-000000000001";
  const organization = "10090000-0000-4000-8000-000000000002";
  const source = "10090000-0000-4000-8000-000000000003";
  await db.query(
    `INSERT INTO identity.users(id,email,status) VALUES ($1,'import-demo@example.test','active') ON CONFLICT DO NOTHING`,
    [actor],
  );
  await db.query(
    `INSERT INTO identity.organizations(id,kind,name,slug,status,workos_external_id)
 VALUES ($1,'hotel_group','Synthetic Import Test','vay1009-import-test','active',$2) ON CONFLICT DO NOTHING`,
    [organization, `vayada-signup:marketplace-web:hotel:invite:${source}`],
  );
  await db.query(
    `INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key,access_origin)
 VALUES ($1,$2,'active','hotel_owner','agency') ON CONFLICT DO NOTHING`,
    [organization, actor],
  );
  const profile = await profiles.createPropertyProfile({
    organizationId: organization,
    targetAccountUserId: actor,
    correlationId: "vay1009-database-demo",
    idempotencyKey: "vay1009-database-demo",
    provisioningReference: "vay1009-database-demo",
    profile: {
      displayName: "Synthetic Import Hotel",
      propertyType: "hotel",
      location: {
        streetAddress: "Teststrasse 1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [],
    },
  });
  const propertyId = profile.propertyId;
  await db.query(
    `INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status)
 VALUES ($1,'pms','pms_property',$2,'owner','active') ON CONFLICT DO NOTHING`,
    [organization, propertyId],
  );
  await db.query(
    `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id)
 SELECT $1::uuid,'pms','property-management','active','pms','pms_property',$2
 WHERE NOT EXISTS (SELECT 1 FROM identity.product_entitlements WHERE organization_id=$1 AND product='pms')`,
    [organization, propertyId],
  );
  await db.query(
    `INSERT INTO marketplace.invite_codes(id,code,invite_type,status,payload,redeemed_by_user_id)
 VALUES ($1::uuid,$1::text,'hotel','redeemed',$2,$3) ON CONFLICT DO NOTHING`,
    [
      source,
      JSON.stringify({
        contractVersion: "hotel-account-invite.v1",
        redemption: { organizationId: organization },
        preparedData: {
          contractVersion: "prepared-hotel-import.v1",
          property: {},
          rooms: listings,
        },
      }),
      actor,
    ],
  );
  const membership = await db.query(
    "SELECT id FROM identity.organization_memberships WHERE organization_id=$1 AND user_id=$2",
    [organization, actor],
  );
  await db.query(
    "INSERT INTO identity.membership_property_assignments(membership_id,property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [membership.rows[0].id, propertyId],
  );
  await db.end();
  const app = Fastify();
  const token = randomUUID();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request, reply) => {
    // Vite adds the private token; direct browser/cross-origin calls cannot impersonate the fixture.
    if (request.headers["x-import-demo-token"] !== token) return reply.code(403).send();
    request.authContext = {
      actor: { internalUserId: actor, status: "active" },
      selectedOrganization: { organizationId: organization, kind: "hotel_group", status: "active" },
      membership: {
        membershipId: membership.rows[0].id,
        roleKey: "hotel_owner",
        status: "active",
        permissions: [
          "hotel_catalog.setup.manage",
          "marketplace.profile.manage",
          "pms.operations.manage",
          "pms.rooms_rates.read",
          "pms.room_status.read",
          "pms.operations.read",
        ],
      },
      linkedResources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
        {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
      ],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
        },
      ],
    } as RequestContext;
  });
  app.get("/api/import-demo", async () => ({ propertyId }));
  await app.register(registerPreparedHotelImportRoutes, {
    prefix: "/api/hotel-setup",
    repository,
    profiles,
    rooms: {
      commandPort,
      bindingReadPort: readPort,
      factsReadPort: readPort,
      unitReadPort: readPort,
      capacityReadPort: readPort,
    },
  });
  const propertyAccess = createPgPropertyAccessRepository({ connectionString });
  // No provider transport: connection identity/listing facts are explicitly synthetic.
  await app.register(registerAirbnbImportRoutes, {
    prefix: "/api/hotel-setup",
    repository: createPgAirbnbImportSourceRepository(connectionString),
    propertyAccessRepository: propertyAccess,
    allowedOrigins: importOrigins,
    resolveBinding: async () => ({
      environment: "staging",
      groupId: organization,
      externalPropertyId: propertyId,
    }),
    createLink: async (_binding, attempt) => {
      const url = new URL(
        `/setup/airbnb-return/${propertyId}/${attempt.sourceId}`,
        "https://marketplace.localhost:1382",
      );
      url.search = new URLSearchParams({
        success: "true",
        token: attempt.state,
        channel_id: randomUUID(),
      }).toString();
      return url.href;
    },
    readListings: async () => ({
      contractVersion: "prepared-hotel-import.v1",
      property: {},
      rooms: [
        {
          id: "abb_database_suite",
          name: "Synthetic Airbnb Suite",
          description: "",
          maxGuests: 2,
          maxAdults: null,
          maxChildren: null,
          bedType: "",
          bedQuantity: null,
          bathroomType: "",
          sizeSquareMetres: null,
        },
      ],
    }),
    review: {
      profiles,
      applications: createPgAirbnbImportApplicationRepository(connectionString),
      rooms: {
        commandPort,
        bindingReadPort: readPort,
        factsReadPort: readPort,
        unitReadPort: readPort,
        capacityReadPort: readPort,
      },
    },
  });
  await app.register(registerPmsOperationsRoutes, {
    prefix: "/api/pms",
    repository: createTargetPmsOperationsReadRepository({ connectionString }),
    propertyAccessRepository: propertyAccess,
    allowedOrigins: ["https://pms.localhost:1380"],
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      profiles.close?.(),
      commandPort.close(),
      readPort.close(),
      propertyAccess.close?.(),
    ]);
  });
  await app.listen({ host: "127.0.0.1", port: 49709 });
  // Run Vite in this process: token stays out of browser bundles and command arguments.
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: "tools/hotel-import-simulator/vite.config.ts",
    server: {
      port: Number(process.env.PORT ?? 49710),
      proxy: {
        "/api": {
          target: "http://127.0.0.1:49709",
          headers: { "x-import-demo-token": token },
          bypass(req, res) {
            const origin = req.headers.origin;
            if (origin && !importOrigins.includes(origin)) {
              res?.writeHead(403);
              res?.end();
              return false;
            }
          },
        },
      },
    },
  });
  await vite.listen();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, async () => {
      await vite.close();
      await app.close();
      process.exit(0);
    });
  console.log(
    "Local database import demo ready at /database.html; identity and Airbnb are simulated.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
