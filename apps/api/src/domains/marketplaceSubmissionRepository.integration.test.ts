import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import { createPgSharedHotelSetupStatusRepository } from "../platform/sharedHotelSetupStatusReadModel.js";
import { createPgMarketplaceHotelCollaborationPreferencesRepository } from "./marketplaceHotelCollaborationPreferencesRepository.js";
import pg from "pg";
import { marketplaceSubmissionTransactionSources } from "../platform/marketplaceSubmissionTransactionSources.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProductReadinessResult } from "@vayada/domain-hotels";
import {
  createPgMarketplaceSubmissionRepository,
  type MarketplaceSubmissionScope,
} from "./marketplaceSubmissionRepository.js";
import type { MarketplaceSubmissionEvaluation } from "./marketplaceSubmissionReadiness.js";
const database = process.env["TEST_DATABASE_URL"];
const actorUserId = "e1943000-0000-4000-8000-000000000001";
const organizationId = "e1943000-0000-4000-8000-000000000002";
const propertyId = "e1943000-0000-4000-8000-000000000003";
const roleKey = "vay1943_submission_integration";
const scope: MarketplaceSubmissionScope = {
  organizationId,
  propertyId,
  audit: {
    requestedAt: new Date().toISOString(),
    actor: { kind: "user", userId: actorUserId },
    requestId: "vay1943-test",
    correlationId: "vay1943-test",
  },
};
describe.skipIf(!database)("Marketplace submission transactions", () => {
  const admin = new pg.Client({ connectionString: database });
  let gate: (() => Promise<void>) | null = null;
  const repository = createPgMarketplaceSubmissionRepository({
    connectionString: database ?? "postgresql://test",
    sources: (client) => {
      async function evaluate() {
        if (gate) await gate();
        const row = await client.query<{ revision: string }>(
          `SELECT profile_revision::text AS revision FROM hotel_catalog.properties WHERE id=$1::uuid`,
          [propertyId],
        );
        const source = {
          ownerDomain: "hotel_catalog" as const,
          entityType: "test_profile",
          entityId: propertyId,
          revision: row.rows[0]!.revision,
        };
        const readiness = await createProductReadinessResult({
          contractVersion: "onboarding-product-readiness.v1",
          propertyId,
          product: "marketplace",
          status: "ready",
          sourceManifest: {
            contractVersion: "onboarding-source-manifest.v1",
            propertyId,
            sources: [source],
          },
          groups: [
            {
              groupId: "marketplace.hotel_profile",
              status: "ready",
              steps: [
                {
                  owningStepId: "present_hotel",
                  status: "ready",
                  entities: [{ source, status: "ready", blockers: [] }],
                },
              ],
            },
          ],
          evaluatedAt: new Date().toISOString(),
        });
        return {
          readiness,
          snapshot: {
            contractVersion: "marketplace-submission-snapshot.v1",
            catalog: { propertyId },
            preferences: null,
            preferencesRevision: 0,
          },
        } as MarketplaceSubmissionEvaluation;
      }
      return { evaluate, getReadiness: async () => (await evaluate()).readiness };
    },
  });
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(database!).pathname.slice(1)))
      throw new Error("Requires test database");
    await admin.connect();
  });
  beforeEach(async () => {
    gate = null;
    await cleanup();
    await seedAuthorizedProfile();
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });
  async function request() {
    const view = await repository.getReview(scope);
    if (view.readiness.outcome !== "evaluated") throw new Error("readiness unavailable");
    return {
      expectedLatestSubmissionRevisionId: view.latestSubmission?.revisionId ?? null,
      expectedSourceManifestHash: view.readiness.sourceManifestHash,
      expectedReadinessHash: view.readiness.readinessHash,
    };
  }
  it("reads without a submission and atomically recovers one accepted request", async () => {
    const body = await request();
    expect((await repository.getReview(scope)).latestSubmission).toBeNull();
    const first = await repository.submit(scope, "same", body);
    expect(first.status).toBe("pending");
    expect(await repository.submit(scope, "same", body)).toEqual(first);
    const view = await repository.getReview(scope, "same");
    expect(view.recoveredSubmission).toEqual(first);
    expect(view.activeSubmission).toBeNull();
    const count = await admin.query(
      `SELECT count(*)::int AS count FROM marketplace.hotel_submission_revisions WHERE property_id=$1::uuid`,
      [propertyId],
    );
    expect(count.rows[0].count).toBe(1);
  });
  it("serializes simultaneous duplicate requests", async () => {
    const body = await request();
    const [a, b] = await Promise.all([
      repository.submit(scope, "same", body),
      repository.submit(scope, "same", body),
    ]);
    expect(a).toEqual(b);
  });
  it("rejects source drift before writing", async () => {
    const body = await request();
    await admin.query(
      `UPDATE hotel_catalog.properties SET profile_revision=profile_revision+1 WHERE id=$1::uuid`,
      [propertyId],
    );
    await expect(repository.submit(scope, "stale", body)).rejects.toMatchObject({
      code: "invalid_readiness_evidence",
    });
    expect((await repository.getReview(scope)).latestSubmission).toBeNull();
  });
  it("does not allow a second pending submission or changed-body replay", async () => {
    const body = await request();
    await repository.submit(scope, "first", body);
    await expect(repository.submit(scope, "second", body)).rejects.toMatchObject({
      code: "submission_revision_conflict",
    });
    await expect(
      repository.submit(scope, "first", {
        ...body,
        expectedReadinessHash: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    await expect(repository.submit(scope, "third", await request())).rejects.toMatchObject({
      code: "submission_pending_review",
    });
  });
  it("rejects revoked permission even for a previously accepted key", async () => {
    const body = await request();
    await repository.submit(scope, "first", body);
    await admin.query(
      `UPDATE identity.organization_memberships SET status='suspended' WHERE organization_id=$1::uuid`,
      [organizationId],
    );
    await expect(repository.submit(scope, "first", body)).rejects.toMatchObject({ status: 403 });
  });
  it("holds canonical and Marketplace locks until submission commits", async () => {
    const body = await request();
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate = async () => {
      reached();
      await hold;
    };
    const pending = repository.submit(scope, "locked", body);
    await entered;
    try {
      await admin.query("SET lock_timeout = '150ms'");
      await expect(
        admin.query(
          `UPDATE hotel_catalog.properties SET profile_revision=profile_revision+1 WHERE id=$1::uuid`,
          [propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await expect(
        admin.query(
          `SELECT property_id FROM marketplace.marketplace_hotel_profiles WHERE property_id=$1::uuid FOR UPDATE`,
          [propertyId],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release();
      await admin.query("SET lock_timeout = '0'");
    }
    expect((await pending).status).toBe("pending");
  });
  it("composes the real owner readers and keeps incomplete setup blocked", async () => {
    const actual = createPgMarketplaceSubmissionRepository({
      connectionString: database!,
      sources: marketplaceSubmissionTransactionSources,
    });
    try {
      const view = await actual.getReview(scope);
      expect(view.readiness.outcome).toBe("evaluated");
      expect(view.readiness.status).toBe("blocked");
      expect(view.latestSubmission).toBeNull();
    } finally {
      await actual.close();
    }
  });
  it("rolls back the snapshot, moderation, and recovery record when audit fails", async () => {
    const body = await request();
    await admin.query(
      `CREATE OR REPLACE FUNCTION platform.vay1943_submission_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.property_id='${propertyId}'::uuid AND NEW.action='marketplace.hotel_submission.submitted' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`,
    );
    await admin.query(
      `CREATE TRIGGER vay1943_submission_fail_audit BEFORE INSERT ON platform.product_audit_events FOR EACH ROW EXECUTE FUNCTION platform.vay1943_submission_fail_audit()`,
    );
    try {
      await expect(repository.submit(scope, "audit-failure", body)).rejects.toThrow(
        "synthetic audit failure",
      );
    } finally {
      await admin.query(
        "DROP TRIGGER IF EXISTS vay1943_submission_fail_audit ON platform.product_audit_events",
      );
      await admin.query("DROP FUNCTION IF EXISTS platform.vay1943_submission_fail_audit()");
    }
    const view = await repository.getReview(scope, "audit-failure");
    expect(view.latestSubmission).toBeNull();
    expect(view.recoveredSubmission).toBeNull();
  });
  it("submits a complete canonical snapshot through production owner readers", async () => {
    const profiles = createPgSharedHotelSetupStatusRepository({ connectionString: database! });
    const preferences = createPgMarketplaceHotelCollaborationPreferencesRepository({
      connectionString: database!,
    });
    const actual = createPgMarketplaceSubmissionRepository({
      connectionString: database!,
      sources: marketplaceSubmissionTransactionSources,
    });
    const mediaId = "e1943000-0000-4000-8000-000000000004";
    try {
      const updated = await profiles.updatePropertyProfile({
        organizationId,
        propertyId,
        expectedProfileRevision: 1,
        profile: {
          displayName: "Submission Test Hotel",
          propertyType: "hotel",
          location: {
            streetAddress: "Test Street 1",
            postalCode: "10115",
            city: "Berlin",
            countryCode: "DE",
            timezone: "Europe/Berlin",
            latitude: 52,
            longitude: 13,
            localityPublic: true,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
          contacts: [
            {
              channelType: "email",
              value: "hotel@example.test",
              purpose: "general",
              isPublic: false,
            },
            { channelType: "phone", value: "+4930123456", purpose: "general", isPublic: false },
          ],
        },
      });
      expect(updated?.profileRevision).toBe(2);
      await admin.query(
        `INSERT INTO platform.media_objects (id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,source_system,public_approved) VALUES ($1::uuid,'test-media','vay1943/logo.webp','vayada_managed','public','property.logo',$2::uuid,$3::uuid,'marketplace','hotel_profile',$3,'active','image/webp',1024,'platform',TRUE)`,
        [mediaId, organizationId, propertyId],
      );
      await admin.query(
        `INSERT INTO platform.media_variants (media_object_id,variant_name,visibility,storage_key,content_type,size_bytes,public_cdn_url) VALUES ($1::uuid,'original_safe','public','vay1943/logo.webp','image/webp',1024,'https://cdn.example.test/vay1943/logo.webp')`,
        [mediaId],
      );
      await profiles.updatePublicPropertyProfile({
        organizationId,
        propertyId,
        expectedProfileRevision: 2,
        patch: {
          shortDescription:
            "A welcoming hotel with comfortable rooms and easy access to local parks and restaurants.",
          media: [{ mediaObjectId: mediaId, altText: "Hotel logo", sortOrder: 0 }],
        },
      });
      const saved = await preferences.replaceHotelCollaborationPreferences({
        organizationId,
        propertyId,
        idempotencyKey: "complete-preferences",
        audit: scope.audit,
        request: {
          expectedRevision: 0,
          compensationTypes: ["free_stay"],
          contentPlatforms: ["instagram"],
          contentTypes: ["post"],
          availability: { mode: "year_round", selectedMonths: [] },
        },
      });
      expect(saved.ok).toBe(true);
      const view = await actual.getReview(scope);
      expect(view.readiness.status).toBe("ready");
      if (view.readiness.outcome !== "evaluated") throw new Error("readiness unavailable");
      const receipt = await actual.submit(scope, "production-readers", {
        expectedLatestSubmissionRevisionId: null,
        expectedSourceManifestHash: view.readiness.sourceManifestHash,
        expectedReadinessHash: view.readiness.readinessHash,
      });
      expect(receipt.status).toBe("pending");
      const stored = await admin.query(
        `SELECT submission_snapshot FROM marketplace.hotel_submission_revisions WHERE id=$1::uuid`,
        [receipt.revisionId],
      );
      expect(stored.rows[0].submission_snapshot).toMatchObject({
        catalog: {
          profile: { displayName: "Submission Test Hotel" },
          media: [{ mediaType: "logo" }],
        },
        preferences: { compensationTypes: ["free_stay"] },
        preferencesRevision: 1,
      });
      const storageKey = `public/media/${mediaId}/original_safe/logo.webp`;
      const publicUrl = `https://cdn.example.test/${storageKey.slice("public/".length)}`;
      await admin.query(
        `UPDATE platform.media_objects SET storage_key=$2,resource_product='hotel_catalog',resource_type='property' WHERE id=$1::uuid`,
        [mediaId, storageKey],
      );
      await admin.query(
        `UPDATE platform.media_variants SET storage_key=$2,public_cdn_url=$3 WHERE media_object_id=$1::uuid`,
        [mediaId, storageKey, publicUrl],
      );
      const adapter = createPgHotelMediaResolutionPort({
        connectionString: database!,
        serving: {
          bucketName: "test-media",
          cdnBaseUrl: "https://cdn.example.test",
          publicPathPrefix: "media",
        },
      });
      const resolver = createHotelMediaResolutionPort(adapter);
      try {
        expect(await actual.getPublicHotel(propertyId, resolver)).toBeNull();
        await admin.query(
          `UPDATE marketplace.hotel_submission_moderation SET status='approved',decided_by_user_id=$2::uuid,decided_at=now() WHERE submission_revision_id=$1::uuid`,
          [receipt.revisionId, actorUserId],
        );
        // Approval without explicit activation still has no public projection.
        expect(await actual.getPublicHotel(propertyId, resolver)).toBeNull();
        await admin.query(
          `INSERT INTO marketplace.active_hotel_submission_revisions (property_id,submission_revision_id,activated_by_user_id,status_changed_by_user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$3::uuid)`,
          [propertyId, receipt.revisionId, actorUserId],
        );
        expect(await actual.getPublicHotel(propertyId.toUpperCase(), resolver)).toEqual({
          propertyId,
          revisionId: receipt.revisionId,
          displayName: "Submission Test Hotel",
          propertyType: "hotel",
          shortDescription:
            "A welcoming hotel with comfortable rooms and easy access to local parks and restaurants.",
          locality: { city: "Berlin", countryCode: "DE" },
          media: [{ mediaType: "logo", url: publicUrl, altText: "Hotel logo" }],
        });
        await admin.query(
          `UPDATE hotel_catalog.properties SET display_name='Unsubmitted draft' WHERE id=$1::uuid`,
          [propertyId],
        );
        expect((await actual.getPublicHotel(propertyId, resolver))?.displayName).toBe(
          "Submission Test Hotel",
        );
        await admin.query(`DELETE FROM platform.media_variants WHERE media_object_id=$1::uuid`, [
          mediaId,
        ]);
        await admin.query(
          `UPDATE platform.media_objects SET public_approved=FALSE,visibility='private' WHERE id=$1::uuid`,
          [mediaId],
        );
        expect(await actual.getPublicHotel(propertyId, resolver)).toBeNull();
        await admin.query(
          `UPDATE platform.media_objects SET public_approved=TRUE,visibility='public' WHERE id=$1::uuid`,
          [mediaId],
        );
        await admin.query(
          `INSERT INTO platform.media_variants (media_object_id,variant_name,visibility,storage_key,content_type,size_bytes,public_cdn_url) VALUES ($1::uuid,'original_safe','public',$2,'image/webp',1024,$3)`,
          [mediaId, storageKey, publicUrl],
        );
        for (const status of ["suspended", "deactivated"]) {
          await admin.query(
            `UPDATE marketplace.active_hotel_submission_revisions SET activation_status=$2 WHERE property_id=$1::uuid`,
            [propertyId, status],
          );
          expect(await actual.getPublicHotel(propertyId, resolver)).toBeNull();
        }
      } finally {
        await adapter.close?.();
      }
    } finally {
      await actual.close();
      await preferences.close();
      await profiles.close?.();
    }
  });

  async function seedAuthorizedProfile(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1::uuid, 'vay1943-submission@example.test', 'VAY-1943 Submission', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
         VALUES ($1::uuid, 'hotel_group', 'VAY-1943 Submission', 'vay1943-submission', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, 'vay1943-submission', 'VAY-1943 Submission')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1::uuid, $2::uuid)`,
      [propertyId, organizationId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key, access_origin)
         VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES ('hotel_group', $1, 'marketplace.profile.manage') ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'marketplace', 'hotel_profile', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status,
            resource_product, resource_type, resource_id)
         VALUES ($1::uuid, 'marketplace', 'marketplace-hotel-profile', 'active',
                 'marketplace', 'hotel_profile', $2::uuid::text)`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants (organization_kind,role_key,permission_key) VALUES ('hotel_group',$1,'hotel_catalog.setup.manage') ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links (organization_id,product,resource_type,resource_id,relationship,status) VALUES ($1::uuid,'hotel_catalog','property',$2::uuid::text,'owner','active')`,
      [organizationId, propertyId],
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
      await admin.query(
        `DELETE FROM platform.media_variants WHERE media_object_id IN (SELECT id FROM platform.media_objects WHERE property_id=$1::uuid)`,
        [propertyId],
      );
      await admin.query(`DELETE FROM platform.media_objects WHERE property_id=$1::uuid`, [
        propertyId,
      ]);
      await admin.query(`DELETE FROM hotel_catalog.properties WHERE id=$1::uuid`, [propertyId]);
      await admin.query(`DELETE FROM identity.organizations WHERE id=$1::uuid`, [organizationId]);
      await admin.query(`DELETE FROM identity.users WHERE id=$1::uuid`, [actorUserId]);
      await admin.query(`DELETE FROM identity.role_permission_grants WHERE role_key=$1`, [roleKey]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});
