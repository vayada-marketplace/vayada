// VAY-2169 end to end on PostgreSQL: a hotel submits its profile from setup, a Vayada operator
// approves it, the public /hotels/[id] read answers 200 and setup reports it live. Then the operator
// requests changes on an update, the hotel resubmits, and the approved update becomes public.
import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";

import { createPgHotelMediaResolutionPort } from "./platform/hotelMediaResolver.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import { marketplaceSubmissionTransactionSources } from "./platform/marketplaceSubmissionTransactionSources.js";
import { createPgMarketplaceHotelCollaborationPreferencesRepository } from "./domains/marketplaceHotelCollaborationPreferencesRepository.js";
import { createPgMarketplaceHotelSubmissionModerationRepository } from "./domains/marketplaceHotelSubmissionModerationRepository.js";
import { createPgMarketplaceSetupLifecycleStatusRepository } from "./domains/marketplaceSetupLifecycleStatusRepository.js";
import { createPgMarketplaceSubmissionRepository } from "./domains/marketplaceSubmissionRepository.js";
import { registerMarketplaceHotelSubmissionModerationRoutes } from "./routes/marketplaceHotelSubmissionModeration.js";
import { registerMarketplacePublicHotelRoutes } from "./routes/marketplacePublicHotel.js";
import { registerMarketplaceSubmissionRoutes } from "./routes/marketplaceSubmission.js";

const database = process.env["TEST_DATABASE_URL"];
const ownerUserId = "e2169200-0000-4000-8000-000000000001";
const organizationId = "e2169200-0000-4000-8000-000000000002";
const propertyId = "e2169200-0000-4000-8000-000000000003";
const mediaId = "e2169200-0000-4000-8000-000000000004";
const adminUserId = "e2169200-0000-4000-8000-000000000005";
const roleKey = "vay2169_approval_e2e";
const storageKey = `public/media/${mediaId}/original_safe/logo.webp`;
const publicUrl = `https://cdn.example.test/${storageKey.slice("public/".length)}`;
const audit = { requestId: "req", correlationId: "corr", receivedAt: new Date().toISOString() };

describe.skipIf(!database)("Marketplace approval from setup to the public page (VAY-2169)", () => {
  const admin = new pg.Client({ connectionString: database });
  const profiles = createPgSharedHotelSetupStatusRepository({
    connectionString: database ?? "postgresql://test",
  });
  const preferences = createPgMarketplaceHotelCollaborationPreferencesRepository({
    connectionString: database ?? "postgresql://test",
  });
  const submissions = createPgMarketplaceSubmissionRepository({
    connectionString: database ?? "postgresql://test",
    sources: marketplaceSubmissionTransactionSources,
  });
  const moderation = createPgMarketplaceHotelSubmissionModerationRepository({
    connectionString: database ?? "postgresql://test",
  });
  const lifecycle = createPgMarketplaceSetupLifecycleStatusRepository({
    connectionString: database ?? "postgresql://test",
  });
  const media = createPgHotelMediaResolutionPort({
    connectionString: database ?? "postgresql://test",
    serving: {
      bucketName: "test-media",
      cdnBaseUrl: "https://cdn.example.test",
      publicPathPrefix: "media",
    },
  });
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(database!).pathname.slice(1)))
      throw new Error("Requires test database");
    await admin.connect();
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      if (request.headers.authorization === "Bearer owner")
        request.authContext = {
          actor: { internalUserId: ownerUserId },
          selectedOrganization: { organizationId, kind: "hotel_group" },
          membership: { permissions: ["marketplace.profile.manage"] },
          linkedResources: [
            {
              product: "marketplace",
              resourceType: "hotel_profile",
              resourceId: propertyId,
              relationship: "owner",
              status: "active",
            },
          ],
          entitlements: [
            {
              product: "marketplace",
              key: "marketplace-hotel-profile",
              status: "active",
              resource: {
                product: "marketplace",
                resourceType: "hotel_profile",
                resourceId: propertyId,
              },
            },
          ],
          audit,
        } as unknown as RequestContext;
      if (request.headers.authorization === "Bearer admin")
        request.authContext = {
          actor: { internalUserId: adminUserId },
          selectedOrganization: { organizationId: "org_platform", kind: "platform" },
          membership: { permissions: ["platform.user.suspend"] },
          linkedResources: [
            {
              product: "platform",
              resourceType: "platform",
              resourceId: "vayada",
              relationship: "operator",
              status: "active",
            },
          ],
          entitlements: [
            {
              product: "platform",
              key: "platform-admin",
              status: "active",
              resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
            },
          ],
          audit,
        } as unknown as RequestContext;
    });
    const resolver = () => createHotelMediaResolutionPort(media);
    await app.register(registerMarketplaceSubmissionRoutes, {
      prefix: "/api/marketplace",
      repository: submissions,
    });
    await app.register(registerMarketplaceHotelSubmissionModerationRoutes, {
      prefix: "/api/marketplace",
      repository: moderation,
      mediaResolver: resolver,
    });
    await app.register(registerMarketplacePublicHotelRoutes, {
      prefix: "/api/marketplace",
      read: (id) => submissions.getPublicHotel(id, resolver()),
    });
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await app.close();
    await cleanup();
    await Promise.all([
      submissions.close(),
      moderation.close(),
      lifecycle.close(),
      preferences.close(),
      profiles.close?.(),
      media.close?.(),
    ]);
    await admin.end();
  });

  const owner = { authorization: "Bearer owner" };
  const operator = { authorization: "Bearer admin" };

  async function ownerReview() {
    const reply = await app.inject({
      url: `/api/marketplace/properties/${propertyId}/submission-review`,
      headers: owner,
    });
    expect(reply.statusCode).toBe(200);
    return reply.json();
  }
  async function ownerSubmits(key: string) {
    const review = await ownerReview();
    expect(review.readiness.status).toBe("ready");
    const reply = await app.inject({
      method: "POST",
      url: `/api/marketplace/properties/${propertyId}/submissions`,
      headers: { ...owner, "idempotency-key": key },
      payload: {
        expectedLatestSubmissionRevisionId: review.latestSubmission?.revisionId ?? null,
        expectedSourceManifestHash: review.readiness.sourceManifestHash,
        expectedReadinessHash: review.readiness.readinessHash,
      },
    });
    expect(reply.statusCode).toBe(201);
    return reply.json() as { revisionId: string; status: string; revisionNumber: number };
  }
  async function operatorDecides(revisionId: string, key: string, payload: object) {
    return app.inject({
      method: "POST",
      url: `/api/marketplace/admin/hotel-submissions/${revisionId}/decision`,
      headers: { ...operator, "idempotency-key": key },
      payload,
    });
  }
  async function publicHotel() {
    return app.inject({ url: `/api/marketplace/hotels/${propertyId}` });
  }
  async function phase() {
    return (
      await lifecycle.getMarketplaceSetupLifecycleStatus({
        organizationId,
        propertyId,
        actorUserId: ownerUserId,
      })
    ).phase;
  }

  it("publishes an approved submission and replaces it only with an approved update", async () => {
    await completeMarketplaceSetup("Hotel Alpenrose Munich");
    const first = await ownerSubmits("submit-1");
    expect(first.status).toBe("pending");
    expect(await phase()).toBe("pending_review");
    expect((await publicHotel()).statusCode).toBe(404);

    // The hotel's own session can't see or decide the queue.
    for (const url of [
      "/api/marketplace/admin/hotel-submissions",
      `/api/marketplace/admin/hotel-submissions/${first.revisionId}`,
    ])
      expect((await app.inject({ url, headers: owner })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/marketplace/admin/hotel-submissions/${first.revisionId}/decision`,
          headers: { ...owner, "idempotency-key": "owner-approve" },
          payload: { decision: "approve" },
        })
      ).statusCode,
    ).toBe(403);

    const queue = await app.inject({
      url: "/api/marketplace/admin/hotel-submissions",
      headers: operator,
    });
    expect(queue.statusCode).toBe(200);
    expect(
      queue
        .json()
        .submissions.filter((item: { propertyId: string }) => item.propertyId === propertyId),
    ).toEqual([
      expect.objectContaining({
        revisionId: first.revisionId,
        displayName: "Hotel Alpenrose Munich",
        city: "Munich",
        countryCode: "DE",
        previous: null,
        live: false,
      }),
    ]);
    const review = await app.inject({
      url: `/api/marketplace/admin/hotel-submissions/${first.revisionId}`,
      headers: operator,
    });
    expect(review.json().review).toMatchObject({
      submittedByEmail: "vay2169-e2e-owner@example.test",
      preview: {
        displayName: "Hotel Alpenrose Munich",
        locality: { city: "Munich", countryCode: "DE" },
        media: [{ mediaType: "logo", url: publicUrl }],
      },
      preferences: { compensationTypes: ["free_stay"], contentPlatforms: ["instagram"] },
    });

    const approved = await operatorDecides(first.revisionId, "approve-1", { decision: "approve" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      publicPath: `/hotels/${propertyId}`,
    });
    const live = await publicHotel();
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      propertyId,
      revisionId: first.revisionId,
      displayName: "Hotel Alpenrose Munich",
      media: [{ mediaType: "logo", url: publicUrl, altText: "Hotel logo" }],
    });
    // Setup's review card shows "Live" for exactly this state.
    expect((await ownerReview()).activeSubmission).toEqual({
      revisionId: first.revisionId,
      status: "active",
    });
    expect(await phase()).toBe("published");

    // The hotel renames itself and submits the update; Vayada asks for changes.
    await renameHotel("Alpenrose Boutique Munich");
    const second = await ownerSubmits("submit-2");
    expect(await phase()).toBe("pending_review");
    const note = "Please add the neighbourhood to your description.";
    const changes = await operatorDecides(second.revisionId, "changes-2", {
      decision: "request_changes",
      note,
    });
    expect(changes.statusCode).toBe(200);
    const sentBack = await ownerReview();
    expect(sentBack.latestSubmission).toMatchObject({
      revisionId: second.revisionId,
      status: "changes_requested",
      decisionReason: note,
    });
    expect(sentBack.activeSubmission).toEqual({ revisionId: first.revisionId, status: "active" });
    expect((await publicHotel()).json().displayName).toBe("Hotel Alpenrose Munich");

    // The hotel resubmits; the approved update replaces the public profile.
    const third = await ownerSubmits("submit-3");
    expect(third.revisionNumber).toBe(3);
    expect(
      (await operatorDecides(third.revisionId, "approve-3", { decision: "approve" })).statusCode,
    ).toBe(200);
    const updated = await publicHotel();
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      revisionId: third.revisionId,
      displayName: "Alpenrose Boutique Munich",
    });
    expect(await phase()).toBe("published");
    expect(
      (await operatorDecides(third.revisionId, "approve-again", { decision: "approve" })).json()
        .code,
    ).toBe("submission_already_decided");
  });

  async function completeMarketplaceSetup(displayName: string) {
    await profiles.updatePropertyProfile({
      organizationId,
      propertyId,
      expectedProfileRevision: 1,
      profile: profile(displayName),
    });
    await admin.query(
      `INSERT INTO platform.media_objects (id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,source_system,public_approved) VALUES ($1::uuid,'test-media',$4,'vayada_managed','public','property.logo',$2::uuid,$3::uuid,'hotel_catalog','property',$3,'active','image/webp',1024,'platform',TRUE)`,
      [mediaId, organizationId, propertyId, storageKey],
    );
    await admin.query(
      `INSERT INTO platform.media_variants (media_object_id,variant_name,visibility,storage_key,content_type,size_bytes,public_cdn_url) VALUES ($1::uuid,'original_safe','public',$2,'image/webp',1024,$3)`,
      [mediaId, storageKey, publicUrl],
    );
    await profiles.updatePublicPropertyProfile({
      organizationId,
      propertyId,
      expectedProfileRevision: 2,
      patch: {
        shortDescription:
          "A family-run boutique hotel near the English Garden with a rooftop terrace and bikes.",
        media: [{ mediaObjectId: mediaId, altText: "Hotel logo", sortOrder: 0 }],
      },
    });
    const saved = await preferences.replaceHotelCollaborationPreferences({
      organizationId,
      propertyId,
      idempotencyKey: "e2e-preferences",
      audit: {
        requestedAt: new Date().toISOString(),
        actor: { kind: "user", userId: ownerUserId },
        requestId: "vay2169-e2e",
        correlationId: "vay2169-e2e",
      },
      request: {
        expectedRevision: 0,
        compensationTypes: ["free_stay"],
        contentPlatforms: ["instagram"],
        contentTypes: ["post"],
        availability: { mode: "year_round", selectedMonths: [] },
      },
    });
    expect(saved.ok).toBe(true);
  }

  async function renameHotel(displayName: string) {
    const current = await admin.query<{ revision: number }>(
      `SELECT profile_revision AS revision FROM hotel_catalog.properties WHERE id=$1::uuid`,
      [propertyId],
    );
    const result = await profiles.updatePropertyProfile({
      organizationId,
      propertyId,
      expectedProfileRevision: current.rows[0]!.revision,
      profile: profile(displayName),
    });
    expect(result).toBeTruthy();
  }

  function profile(displayName: string) {
    return {
      displayName,
      propertyType: "hotel",
      location: {
        streetAddress: "Test Street 1",
        postalCode: "80538",
        city: "Munich",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: 48.15,
        longitude: 11.59,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden" as const,
      },
      contacts: [
        {
          channelType: "email" as const,
          value: "hotel@example.test",
          purpose: "general" as const,
          isPublic: false,
        },
        {
          channelType: "phone" as const,
          value: "+4989123456",
          purpose: "general" as const,
          isPublic: false,
        },
      ],
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES
         ($1::uuid, 'vay2169-e2e-owner@example.test', 'VAY-2169 Owner', 'active'),
         ($2::uuid, 'vay2169-e2e-admin@example.test', 'VAY-2169 Admin', 'active')`,
      [ownerUserId, adminUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1::uuid, 'hotel_group', 'VAY-2169 E2E', 'vay2169-e2e', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, 'vay2169-e2e', 'VAY-2169 E2E')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id) VALUES ($1::uuid, $2::uuid)`,
      [propertyId, organizationId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (organization_id, user_id, status, role_key, access_origin) VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, ownerUserId, roleKey],
    );
    for (const permission of [
      "marketplace.profile.manage",
      "marketplace.collaboration.read",
      "hotel_catalog.setup.manage",
    ])
      await admin.query(
        `INSERT INTO identity.role_permission_grants (organization_kind, role_key, permission_key) VALUES ('hotel_group', $1, $2) ON CONFLICT DO NOTHING`,
        [roleKey, permission],
      );
    await admin.query(
      `INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES ($1::uuid, 'marketplace', 'hotel_profile', $2::uuid::text, 'owner', 'active'), ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    // Organization-wide, the way the setup track grants it.
    await admin.query(
      `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status) VALUES ($1::uuid, 'marketplace', 'marketplace-hotel-profile', 'active')`,
      [organizationId],
    );
  }

  async function cleanup() {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role='replica'");
      for (const table of [
        "platform.outbox_events",
        "platform.product_audit_events",
        "platform.domain_events",
        "platform.idempotency_keys",
        "marketplace.active_hotel_submission_revisions",
        "marketplace.hotel_submission_moderation",
        "marketplace.hotel_submission_revisions",
        "marketplace.hotel_collaboration_preferences",
        "marketplace.marketplace_hotel_profiles",
        "hotel_catalog.property_media",
        "hotel_catalog.property_slugs",
        "hotel_catalog.property_profiles",
        "hotel_catalog.property_locations",
        "hotel_catalog.property_contact_channels",
      ])
        await admin.query(`DELETE FROM ${table} WHERE property_id=$1::uuid`, [propertyId]);
      for (const table of [
        "identity.product_entitlements",
        "identity.organization_resource_links",
        "identity.organization_memberships",
      ])
        await admin.query(`DELETE FROM ${table} WHERE organization_id=$1::uuid`, [organizationId]);
      await admin.query(`DELETE FROM platform.media_variants WHERE media_object_id=$1::uuid`, [
        mediaId,
      ]);
      await admin.query(`DELETE FROM platform.media_objects WHERE id=$1::uuid`, [mediaId]);
      await admin.query(`DELETE FROM hotel_catalog.properties WHERE id=$1::uuid`, [propertyId]);
      await admin.query(`DELETE FROM identity.organizations WHERE id=$1::uuid`, [organizationId]);
      await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
        [ownerUserId, adminUserId],
      ]);
      await admin.query(`DELETE FROM identity.role_permission_grants WHERE role_key=$1`, [roleKey]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});
