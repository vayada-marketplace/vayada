import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHotelMediaResolutionPort,
  createProductReadinessResult,
} from "@vayada/domain-hotels";
import type { MarketplaceHotelSubmissionDecisionCommand } from "@vayada/domain-marketplace";

import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import { createPgMarketplaceHotelSubmissionModerationRepository } from "./marketplaceHotelSubmissionModerationRepository.js";
import {
  createPgMarketplaceSubmissionRepository,
  type MarketplaceSubmissionScope,
} from "./marketplaceSubmissionRepository.js";
import type { MarketplaceSubmissionEvaluation } from "./marketplaceSubmissionReadiness.js";

const database = process.env["TEST_DATABASE_URL"];
const ownerUserId = "e2169100-0000-4000-8000-000000000001";
const organizationId = "e2169100-0000-4000-8000-000000000002";
const propertyId = "e2169100-0000-4000-8000-000000000003";
const mediaId = "e2169100-0000-4000-8000-000000000004";
const adminUserId = "e2169100-0000-4000-8000-000000000005";
const unknownRevisionId = "e2169100-0000-4000-8000-0000000000ff";
const roleKey = "vay2169_moderation_integration";
const storageKey = `public/media/${mediaId}/original_safe/logo.webp`;
const publicUrl = `https://cdn.example.test/${storageKey.slice("public/".length)}`;
const scope: MarketplaceSubmissionScope = {
  organizationId,
  propertyId,
  audit: {
    requestedAt: new Date().toISOString(),
    actor: { kind: "user", userId: ownerUserId },
    requestId: "vay2169-owner",
    correlationId: "vay2169-owner",
  },
};
const snapshot = {
  contractVersion: "marketplace-submission-snapshot.v1",
  catalog: {
    contractVersion: "marketplace-catalog-submission.v1",
    propertyId,
    profileRevision: 1,
    profile: {
      displayName: "Hotel Alpenrose Munich",
      propertyType: "hotel",
      location: { localityPublic: true, city: "Munich", countryCode: "DE" },
    },
    presentation: { shortDescription: "A family-run boutique hotel near the English Garden." },
    media: [{ mediaObjectId: mediaId, mediaType: "logo", altText: "Hotel logo", sortOrder: 0 }],
  },
  preferences: {
    compensationTypes: ["free_stay", "paid"],
    contentPlatforms: ["instagram", "tiktok"],
    contentTypes: ["short_form_video"],
    availability: { mode: "year_round", selectedMonths: [] },
  },
  preferencesRevision: 1,
};

describe.skipIf(!database)("Marketplace hotel submission moderation", () => {
  const admin = new pg.Client({ connectionString: database });
  const submissions = createPgMarketplaceSubmissionRepository({
    connectionString: database ?? "postgresql://test",
    sources: (client) => {
      async function evaluate() {
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
        return { readiness, snapshot } as unknown as MarketplaceSubmissionEvaluation;
      }
      return { evaluate, getReadiness: async () => (await evaluate()).readiness };
    },
  });
  const moderation = createPgMarketplaceHotelSubmissionModerationRepository({
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
  const resolver = createHotelMediaResolutionPort(media);

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(database!).pathname.slice(1)))
      throw new Error("Requires test database");
    await admin.connect();
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    await submissions.close();
    await moderation.close();
    await media.close?.();
    await admin.end();
  });

  async function submit(key: string) {
    const view = await submissions.getReview(scope);
    if (view.readiness.outcome !== "evaluated") throw new Error("readiness unavailable");
    return submissions.submit(scope, key, {
      expectedLatestSubmissionRevisionId: view.latestSubmission?.revisionId ?? null,
      expectedSourceManifestHash: view.readiness.sourceManifestHash,
      expectedReadinessHash: view.readiness.readinessHash,
    });
  }
  function decision(
    revisionId: string,
    key: string,
    request: MarketplaceHotelSubmissionDecisionCommand["request"] = { decision: "approve" },
  ): MarketplaceHotelSubmissionDecisionCommand {
    return {
      revisionId,
      idempotencyKey: key,
      request,
      audit: {
        actorUserId: adminUserId,
        actorOrganizationId: organizationId,
        requestId: `vay2169-${key}`,
        correlationId: null,
        requestedAt: new Date().toISOString(),
      },
    };
  }
  const note = "Please use a photo of the hotel as the cover instead of the logo.";

  it("queues a submission and approval publishes exactly that snapshot", async () => {
    const receipt = await submit("first");
    expect(await queue()).toEqual([
      expect.objectContaining({
        revisionId: receipt.revisionId,
        propertyId,
        revisionNumber: 1,
        displayName: "Hotel Alpenrose Munich",
        propertyType: "hotel",
        city: "Munich",
        countryCode: "DE",
        previous: null,
        live: false,
      }),
    ]);
    const review = await moderation.getReview(receipt.revisionId, resolver);
    expect(review).toMatchObject({
      status: "pending",
      submittedByEmail: "vay2169-owner@example.test",
      preview: {
        displayName: "Hotel Alpenrose Munich",
        locality: { city: "Munich", countryCode: "DE" },
        media: [{ mediaType: "logo", url: publicUrl, altText: "Hotel logo" }],
      },
      preferences: { compensationTypes: ["free_stay", "paid"] },
      history: [{ revisionId: receipt.revisionId, status: "pending", note: null }],
      live: null,
    });
    expect(await submissions.getPublicHotel(propertyId, resolver)).toBeNull();

    const approved = await moderation.decide(decision(receipt.revisionId, "approve-1"));
    expect(approved).toMatchObject({
      ok: true,
      response: {
        status: "approved",
        note: null,
        decidedByUserId: adminUserId,
        publicPath: `/hotels/${propertyId}`,
      },
    });
    expect((await submissions.getPublicHotel(propertyId, resolver))?.revisionId).toBe(
      receipt.revisionId,
    );
    const owner = await submissions.getReview(scope);
    expect(owner.latestSubmission?.status).toBe("approved");
    expect(owner.activeSubmission).toEqual({ revisionId: receipt.revisionId, status: "active" });
    expect(await profileStatus()).toBe("verified");
    expect(await auditActions()).toEqual([
      "marketplace.hotel_submission.submitted",
      "marketplace.hotel_submission.approved",
    ]);
    expect(await queue()).toEqual([]);

    // Replays return the stored outcome; a changed body under the same key does not.
    expect(await moderation.decide(decision(receipt.revisionId, "approve-1"))).toEqual(approved);
    expect(
      await moderation.decide(
        decision(receipt.revisionId, "approve-1", { decision: "request_changes", note }),
      ),
    ).toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    expect(await moderation.decide(decision(receipt.revisionId, "approve-2"))).toEqual({
      ok: false,
      error: { code: "submission_already_decided" },
    });
  });

  it("requests changes, takes a resubmission and keeps the live version until the update is approved", async () => {
    const first = await submit("first");
    const changes = await moderation.decide(
      decision(first.revisionId, "changes-1", { decision: "request_changes", note }),
    );
    expect(changes).toMatchObject({ ok: true, response: { status: "changes_requested", note } });
    const owner = await submissions.getReview(scope);
    expect(owner.latestSubmission).toMatchObject({
      status: "changes_requested",
      decisionReason: note,
    });
    expect(owner.activeSubmission).toBeNull();
    expect(await profileStatus()).toBe("pending");
    expect(await submissions.getPublicHotel(propertyId, resolver)).toBeNull();
    const audit = await admin.query(
      `SELECT private_payload FROM platform.product_audit_events WHERE property_id=$1::uuid AND action='marketplace.hotel_submission.changes_requested'`,
      [propertyId],
    );
    expect(audit.rows).toEqual([{ private_payload: { note } }]);

    const second = await submit("second");
    expect(second.revisionNumber).toBe(2);
    expect(await queue()).toEqual([
      expect.objectContaining({
        revisionId: second.revisionId,
        previous: { status: "changes_requested", decidedAt: expect.any(String) },
        live: false,
      }),
    ]);
    expect((await moderation.decide(decision(second.revisionId, "approve-2"))).ok).toBe(true);

    const third = await submit("third");
    expect(await queue()).toEqual([
      expect.objectContaining({
        revisionId: third.revisionId,
        previous: { status: "approved", decidedAt: expect.any(String) },
        live: true,
      }),
    ]);
    // The approved revision stays public while the update waits.
    expect((await submissions.getPublicHotel(propertyId, resolver))?.revisionId).toBe(
      second.revisionId,
    );
    expect((await moderation.decide(decision(third.revisionId, "approve-3"))).ok).toBe(true);
    expect((await submissions.getPublicHotel(propertyId, resolver))?.revisionId).toBe(
      third.revisionId,
    );
    const statuses = await admin.query(
      `SELECT revision.revision_number AS number, moderation.status
       FROM marketplace.hotel_submission_revisions revision
       JOIN marketplace.hotel_submission_moderation moderation ON moderation.submission_revision_id=revision.id
       WHERE revision.property_id=$1::uuid ORDER BY revision.revision_number`,
      [propertyId],
    );
    expect(statuses.rows).toEqual([
      { number: 1, status: "changes_requested" },
      { number: 2, status: "approved" },
      { number: 3, status: "approved" },
    ]);
  });

  it("refuses approval while the hotel cannot be public", async () => {
    expect(await moderation.decide(decision(unknownRevisionId, "unknown"))).toEqual({
      ok: false,
      error: { code: "submission_not_found" },
    });
    const first = await submit("first");
    const refusals: [string, string, string][] = [
      [
        `UPDATE hotel_catalog.properties SET lifecycle_status='suspended' WHERE id=$1::uuid`,
        `UPDATE hotel_catalog.properties SET lifecycle_status='provisioning' WHERE id=$1::uuid`,
        "property_unavailable",
      ],
      [
        `UPDATE marketplace.marketplace_hotel_profiles SET marketplace_profile_status='suspended' WHERE property_id=$1::uuid`,
        `UPDATE marketplace.marketplace_hotel_profiles SET marketplace_profile_status='pending' WHERE property_id=$1::uuid`,
        "marketplace_profile_unavailable",
      ],
      [
        `UPDATE identity.product_entitlements SET status='suspended' WHERE organization_id=(SELECT organization_id FROM marketplace.marketplace_hotel_profiles WHERE property_id=$1::uuid)`,
        `UPDATE identity.product_entitlements SET status='active' WHERE organization_id=(SELECT organization_id FROM marketplace.marketplace_hotel_profiles WHERE property_id=$1::uuid)`,
        "marketplace_entitlement_inactive",
      ],
    ];
    for (const [block, restore, code] of refusals) {
      await admin.query(block, [propertyId]);
      expect(await moderation.decide(decision(first.revisionId, `blocked-${code}`))).toEqual({
        ok: false,
        error: { code },
      });
      await admin.query(restore, [propertyId]);
    }
    expect((await moderation.decide(decision(first.revisionId, "approve-1"))).ok).toBe(true);

    const second = await submit("second");
    await admin.query(
      `UPDATE marketplace.active_hotel_submission_revisions SET activation_status='suspended' WHERE property_id=$1::uuid`,
      [propertyId],
    );
    expect(await moderation.decide(decision(second.revisionId, "approve-2"))).toEqual({
      ok: false,
      error: { code: "marketplace_publication_suspended" },
    });
    expect(await submissions.getPublicHotel(propertyId, resolver)).toBeNull();
  });

  it("lets only one of two simultaneous decisions win", async () => {
    const first = await submit("first");
    const results = await Promise.all([
      moderation.decide(decision(first.revisionId, "admin-a")),
      moderation.decide(
        decision(first.revisionId, "admin-b", { decision: "request_changes", note }),
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "submission_already_decided" } },
    ]);
  });

  /** Other suites share the database; only this hotel's queue entries matter here. */
  async function queue() {
    return (await moderation.listPending()).filter((item) => item.propertyId === propertyId);
  }
  async function profileStatus() {
    const result = await admin.query(
      `SELECT marketplace_profile_status AS status FROM marketplace.marketplace_hotel_profiles WHERE property_id=$1::uuid`,
      [propertyId],
    );
    return result.rows[0]?.status;
  }
  async function auditActions() {
    const result = await admin.query(
      `SELECT action FROM platform.product_audit_events WHERE property_id=$1::uuid ORDER BY occurred_at, action`,
      [propertyId],
    );
    return result.rows.map((row) => row.action);
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES
         ($1::uuid, 'vay2169-owner@example.test', 'VAY-2169 Owner', 'active'),
         ($2::uuid, 'vay2169-admin@example.test', 'VAY-2169 Admin', 'active')`,
      [ownerUserId, adminUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1::uuid, 'hotel_group', 'VAY-2169 Moderation', 'vay2169-moderation', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, 'vay2169-moderation', 'VAY-2169 Moderation')`,
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
    for (const permission of ["marketplace.profile.manage", "hotel_catalog.setup.manage"])
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
    await admin.query(
      `INSERT INTO platform.media_objects (id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,source_system,public_approved) VALUES ($1::uuid,'test-media',$4,'vayada_managed','public','property.logo',$2::uuid,$3::uuid,'hotel_catalog','property',$3,'active','image/webp',1024,'platform',TRUE)`,
      [mediaId, organizationId, propertyId, storageKey],
    );
    await admin.query(
      `INSERT INTO platform.media_variants (media_object_id,variant_name,visibility,storage_key,content_type,size_bytes,public_cdn_url) VALUES ($1::uuid,'original_safe','public',$2,'image/webp',1024,$3)`,
      [mediaId, storageKey, publicUrl],
    );
  }

  async function cleanup() {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role='replica'");
      for (const table of [
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "marketplace.active_hotel_submission_revisions",
        "marketplace.hotel_submission_moderation",
        "marketplace.hotel_submission_revisions",
        "marketplace.marketplace_hotel_profiles",
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
