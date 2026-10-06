import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PROPERTY_MEDIA_PUBLIC_VARIANTS } from "@vayada/domain-hotels";
import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import { createPgS3PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import { syncPropertyOfferReadModels } from "./routes/marketplaceAdmin.js";
import { runHotelSetupLogoCleanup } from "./hotelSetupLogoCleanup.js";
import type {
  PlatformMediaSessionRecord,
  PlatformMediaVariantRecord,
} from "./routes/platformMedia.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("protected logo artifact cleanup", () => {
  it("preserves references and uncertainty and retries exact expired private and fenced public artifacts after revocation", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("Test database required");
    const admin = new pg.Pool({ connectionString: url, max: 3 }),
      propertyId = randomUUID(),
      organizationId = randomUUID(),
      actorUserId = randomUUID(),
      suffix = randomUUID().replaceAll("-", ""),
      role = `vayada_next_hotel_setup_logo_cleanup_${suffix.slice(0, 24)}`;
    const repository = createPgPlatformMediaRepository({
      connectionString: url,
      pool: admin,
      publicCdnBaseUrl: "https://images.example.test",
    });
    let commands: ReturnType<typeof createPgS3PropertyMediaCommandRepository> | undefined;
    let native: pg.Pool | undefined;
    const deleted = vi.fn(async (_key: string) => {});
    try {
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        actorUserId,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Cleanup fixture',$2)",
        [organizationId, `cleanup-${suffix}`],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,$2,'Hôtel Cleanup')",
        [propertyId, `cleanup-${suffix}`],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [organizationId, propertyId],
      );
      const password = randomUUID();
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(
        `GRANT vayada_next_hotel_setup_logo_scope TO ${role} WITH INHERIT TRUE,SET FALSE`,
      );
      await admin.query(
        "INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class,actor_user_id,credential_role_oid,credential_secret_version,credential_ready_at,active) SELECT $1,$2,$3,'property_logo',$4,oid,$5,now(),false FROM pg_roles WHERE rolname=$1",
        [role, propertyId, organizationId, actorUserId, randomUUID()],
      );
      const session = await createSession(randomUUID());
      const variants = variantSet(session);
      await admin.query(
        "UPDATE platform.media_upload_sessions SET private_artifact_manifest=$2::jsonb WHERE id=$1",
        [
          session.sessionId,
          JSON.stringify(variants.map((v) => ({ mediaId: session.files[0]!.mediaId, ...v }))),
        ],
      );
      await admin.query("UPDATE identity.users SET status='suspended' WHERE id=$1", [actorUserId]);
      const target = {
        kind: "upload_session" as const,
        targetId: session.sessionId,
        propertyId,
        organizationId,
        actorUserId,
      };
      const plan = await runHotelSetupLogoCleanup({ pool: admin, target, deleteKey: deleted });
      expect(plan).toMatchObject({ status: "PLAN", keyCount: 5 });
      expect(deleted).not.toHaveBeenCalled();
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target: { ...target, actorUserId: randomUUID() },
          deleteKey: deleted,
        }),
      ).rejects.toThrow("scope unavailable");
      const nativeUrl = new URL(url);
      nativeUrl.username = role;
      nativeUrl.password = password;
      native = new pg.Pool({ connectionString: nativeUrl.toString(), max: 1 });
      await expect(
        runHotelSetupLogoCleanup({ pool: native, target, deleteKey: deleted }),
      ).rejects.toThrow();
      expect(deleted).not.toHaveBeenCalled();
      let commitAckLost = false;
      const unknownCommitPool: Parameters<typeof runHotelSetupLogoCleanup>[0]["pool"] = {
        connect: async () => {
          const client = await admin.connect();
          return {
            query: async (sql: string, values?: readonly unknown[]) => {
              const result = await client.query(sql, values as any[]);
              if (sql === "COMMIT" && !commitAckLost) {
                commitAckLost = true;
                throw new Error("lost terminal COMMIT acknowledgement");
              }
              return result;
            },
            release: () => client.release(),
          };
        },
        end: async () => {},
      };
      await expect(
        runHotelSetupLogoCleanup({
          pool: unknownCommitPool,
          target,
          expectedManifestSha256: plan.manifestSha256,
          deleteKey: deleted,
        }),
      ).rejects.toThrow("lost terminal COMMIT");
      expect(deleted).not.toHaveBeenCalled();
      let loseAck = true;
      deleted.mockImplementation(async () => {
        if (loseAck) {
          loseAck = false;
          throw new Error("lost DELETE acknowledgement");
        }
      });
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target,
          expectedManifestSha256: plan.manifestSha256,
          deleteKey: deleted,
        }),
      ).rejects.toThrow("lost DELETE");
      expect(
        (
          await admin.query(
            "SELECT session_status FROM platform.media_upload_sessions WHERE id=$1",
            [session.sessionId],
          )
        ).rows[0],
      ).toEqual({ session_status: "failed" });
      expect(await runHotelSetupLogoCleanup({ pool: admin, target, deleteKey: deleted })).toEqual(
        plan,
      );
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target,
          expectedManifestSha256: plan.manifestSha256,
          deleteKey: deleted,
        }),
      ).resolves.toMatchObject({ status: "PASS", manifestSha256: plan.manifestSha256 });
      const complete = await createSession(randomUUID());
      await repository.completeUploadSession(completion(complete));
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target: { ...target, targetId: complete.sessionId },
          deleteKey: deleted,
        }),
      ).rejects.toThrow("requires inspection");
      const copied = new Set<string>();
      commands = createPgS3PropertyMediaCommandRepository({
        connectionString: url,
        pool: admin,
        serving: {
          bucketName: "owned",
          cdnBaseUrl: "https://images.example.test",
          cdnOriginHost: "origin.example.test",
          publicPathPrefix: "media",
          publicCacheControl: "public,max-age=31536000,immutable",
          privateDownloadTtlSeconds: 300,
          privateDownloadMaxTtlSeconds: 900,
        },
        syncReadModels: syncPropertyOfferReadModels,
        publisher: {
          copyToPublic: async ({ publicStorageKey }) => {
            copied.add(publicStorageKey);
            throw new Error("copy acknowledgement lost");
          },
          deletePublic: async () => {
            throw new Error("storage unavailable");
          },
        },
      });
      const assigned = await commands.assignLogo({
        propertyId,
        organizationId,
        actorUserId,
        idempotencyKey: `cleanup-${suffix}`,
        expectedProfileRevision: 1,
        assignment: {
          role: "logo",
          sortOrder: 0,
          mediaObjectId: complete.files[0]!.mediaId,
          altText: null,
        },
        audit: { requestId: suffix, receivedAt: new Date().toISOString(), source: "api" } as any,
      });
      expect(assigned).toMatchObject({ ok: false, error: { code: "command_in_progress" } });
      const job = (
        await admin.query("SELECT id FROM platform.jobs WHERE property_id=$1", [propertyId])
      ).rows[0];
      expect(job).toBeDefined();
      await admin.query(
        "UPDATE platform.jobs SET run_after=now()-interval '1 hour',locked_at=now()-interval '1 hour' WHERE id=$1",
        [job.id],
      );
      const publication = { ...target, kind: "publication_job" as const, targetId: job.id };
      const originalPayload = (
        await admin.query("SELECT payload FROM platform.jobs WHERE id=$1", [job.id])
      ).rows[0].payload;
      const forgedPayload = structuredClone(originalPayload);
      forgedPayload.media[0].promotion[0].publicStorageKey = `public/media/${randomUUID()}/${forgedPayload.media[0].promotion[0].variantName}/publication-${forgedPayload.publicationToken}.webp`;
      forgedPayload.media[0].promotion[0].publicUrl =
        "https://images.example.test/" +
        forgedPayload.media[0].promotion[0].publicStorageKey.slice(7);
      if (forgedPayload.media[0].promotion[0].variantName === "original_safe")
        forgedPayload.media[0].originalSafeUrl = forgedPayload.media[0].promotion[0].publicUrl;
      await admin.query("UPDATE platform.jobs SET payload=$2::jsonb WHERE id=$1", [
        job.id,
        JSON.stringify(forgedPayload),
      ]);
      const forbiddenDelete = vi.fn(async (_key: string) => {});
      await expect(
        runHotelSetupLogoCleanup({ pool: admin, target: publication, deleteKey: forbiddenDelete }),
      ).rejects.toThrow("registry evidence differs");
      expect(forbiddenDelete).not.toHaveBeenCalled();
      await admin.query("UPDATE platform.jobs SET payload=$2::jsonb WHERE id=$1", [
        job.id,
        JSON.stringify(originalPayload),
      ]);
      const publicPlan = await runHotelSetupLogoCleanup({
        pool: admin,
        target: publication,
        deleteKey: deleted,
      });
      expect(publicPlan).toMatchObject({ status: "PLAN", keyCount: 4 });
      let publicFailure = true;
      const deletePublic = vi.fn(async (key: string) => {
        if (publicFailure) {
          publicFailure = false;
          throw new Error("public cleanup unavailable");
        }
        copied.delete(key);
      });
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target: publication,
          expectedManifestSha256: publicPlan.manifestSha256,
          deleteKey: deletePublic,
        }),
      ).rejects.toThrow("public cleanup unavailable");
      expect(
        (await admin.query("SELECT status FROM platform.jobs WHERE id=$1", [job.id])).rows[0],
      ).toEqual({ status: "dead_lettered" });
      await expect(
        runHotelSetupLogoCleanup({
          pool: admin,
          target: publication,
          expectedManifestSha256: publicPlan.manifestSha256,
          deleteKey: deletePublic,
        }),
      ).resolves.toMatchObject({ status: "PASS", keyCount: 4 });
      expect(copied.size).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM hotel_catalog.property_media WHERE property_id=$1",
            [propertyId],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT visibility,public_approved FROM platform.media_objects WHERE id=$1",
            [complete.files[0]!.mediaId],
          )
        ).rows[0],
      ).toEqual({ visibility: "private", public_approved: false });
    } finally {
      await native?.end();
      await commands?.close();
      const cleanup = await admin.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role=replica");
        await cleanup.query("DELETE FROM platform.product_audit_events WHERE actor_user_id=$1", [
          actorUserId,
        ]);
        await cleanup.query(
          "DELETE FROM platform.dead_letter_events WHERE job_id IN(SELECT id FROM platform.jobs WHERE property_id=$1)",
          [propertyId],
        );
        await cleanup.query(
          "DELETE FROM platform.job_attempts WHERE job_id IN(SELECT id FROM platform.jobs WHERE property_id=$1)",
          [propertyId],
        );
        await cleanup.query("DELETE FROM platform.jobs WHERE property_id=$1", [propertyId]);
        await cleanup.query("DELETE FROM platform.idempotency_keys WHERE property_id=$1", [
          propertyId,
        ]);
        await cleanup.query(
          "DELETE FROM platform.hotel_setup_property_scopes WHERE database_login=$1",
          [role],
        );
        await cleanup.query("DELETE FROM hotel_catalog.property_media WHERE property_id=$1", [
          propertyId,
        ]);
        await cleanup.query("DELETE FROM platform.media_upload_sessions WHERE property_id=$1", [
          propertyId,
        ]);
        await cleanup.query(
          "DELETE FROM platform.media_variants WHERE media_object_id IN(SELECT id FROM platform.media_objects WHERE property_id=$1)",
          [propertyId],
        );
        await cleanup.query("DELETE FROM platform.media_objects WHERE property_id=$1", [
          propertyId,
        ]);
        await cleanup.query(
          "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id=$1",
          [propertyId],
        );
        await cleanup.query("DELETE FROM hotel_catalog.property_slugs WHERE property_id=$1", [
          propertyId,
        ]);
        await cleanup.query(
          "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
          [organizationId],
        );
        await cleanup.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
        await cleanup.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
        await cleanup.query("DELETE FROM identity.users WHERE id=$1", [actorUserId]);
        await cleanup.query(`DROP OWNED BY ${role}`);
        await cleanup.query(`DROP ROLE ${role}`);
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK");
        throw error;
      } finally {
        cleanup.release();
      }
      await admin.end();
    }
    async function createSession(sessionId: string): Promise<PlatformMediaSessionRecord> {
      const uploadTargetId = randomUUID();
      return repository.createUploadSession({
        sessionId,
        uploadSessionKey: `cleanup:${sessionId}`,
        stagingPrefix: `staging/${sessionId}`,
        ownerOrganizationId: organizationId,
        context: {
          actor: { internalUserId: actorUserId },
          selectedOrganization: { organizationId },
        } as any,
        request: {
          purpose: "property.logo",
          visibility: "private",
          resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
          files: [
            {
              filename: "logo.jpg",
              clientFileId: "logo",
              contentType: "image/jpeg",
              sizeBytes: 1000,
            },
          ],
        },
        policy: { purpose: "property.logo", privateOnly: true } as any,
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          propertyId,
        },
        uploadTargets: [
          {
            uploadTargetId,
            clientFileId: "logo",
            method: "PUT",
            uploadUrl: "https://s3.example.test",
            headers: {},
            stagingKey: `staging/${sessionId}/1/logo.jpg`,
            expiresAt: "2026-01-01T00:15:00Z",
          },
        ],
        now: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:15:00Z",
        auditEvent: {
          action: "platform_media.upload_session.created",
          auditKey: `cleanup:${sessionId}`,
          actorUserId,
          organizationId,
          targetType: "media_upload_session",
          targetId: sessionId,
          requestId: sessionId,
          metadata: { purpose: "property.logo" },
        },
      });
    }
    function variantSet(session: PlatformMediaSessionRecord): PlatformMediaVariantRecord[] {
      return PROPERTY_MEDIA_PUBLIC_VARIANTS.map((variantName, i) => ({
        variantName,
        visibility: "private",
        storageKey: `private/media/${session.files[0]!.mediaId}/${variantName}/sha256-${String(i + 1).repeat(64)}.webp`,
        contentType: "image/webp",
        widthPx: 16,
        heightPx: 9,
        sizeBytes: 100,
        checksumSha256: String(i + 1).repeat(64),
        publicCdnUrl: null,
      }));
    }
    function completion(session: PlatformMediaSessionRecord) {
      return {
        session,
        files: [
          {
            sessionFile: session.files[0]!,
            uploadTarget: session.uploadTargets[0]!,
            inspection: {
              contentType: "image/jpeg",
              sizeBytes: 1000,
              checksumSha256: "a".repeat(64),
              widthPx: 16,
              heightPx: 9,
            },
          },
        ],
        variantSets: [variantSet(session)],
        bucketName: "owned",
        now: "2026-01-01T00:01:00Z",
        auditEvent: {
          action: "platform_media.upload_session.finalized" as const,
          auditKey: `complete:${session.sessionId}`,
          actorUserId,
          organizationId,
          targetType: "media_object" as const,
          targetId: session.files[0]!.mediaId,
          requestId: session.sessionId,
          metadata: { purpose: "property.logo" },
        },
      };
    }
  }, 60_000);
});
