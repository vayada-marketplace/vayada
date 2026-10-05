import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PROPERTY_MEDIA_PUBLIC_VARIANTS } from "@vayada/domain-hotels";
import { assertHotelSetupLogoScope } from "./hotelSetupCommandScope.js";
import type { HotelSetupPrivilegeQueryable } from "./hotelSetupReaderPrivileges.js";
import { assertHotelSetupLogoPrivileges } from "./hotelSetupLogoPrivileges.js";
import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import { createPgS3PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";
import type { PlatformMediaSessionRecord } from "./routes/platformMedia.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("native property logo lifecycle", () => {
  it("creates, finalizes, publishes and replays only the assigned Owner's logo", async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const creatorUrl = process.env["VAY965_LOGO_CREATOR_DATABASE_URL"];
    const creator = creatorUrl ? new pg.Pool({ connectionString: creatorUrl, max: 1 }) : admin;
    const suffix = randomUUID().replaceAll("-", "");
    const role = `vayada_next_hotel_setup_logo_${suffix}`;
    const organizationId = randomUUID(),
      actorUserId = randomUUID(),
      propertyId = randomUUID(),
      sessionId = randomUUID(),
      password = randomUUID();
    let native: pg.Pool | undefined;
    try {
      await admin.query(
        "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Logo native',$2)",
        [organizationId, `logo-native-${suffix}`],
      );
      await admin.query("INSERT INTO identity.users(id,email) VALUES($1,$2)", [
        actorUserId,
        `${suffix}@example.test`,
      ]);
      await admin.query(
        "INSERT INTO identity.organization_memberships(organization_id,user_id,role_key,access_origin,property_access_mode,pms_access_enabled,booking_access_enabled) VALUES($1,$2,'hotel_owner','agency','all',FALSE,FALSE)",
        [organizationId, actorUserId],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name,creation_organization_id) VALUES($1,$2,'Logo native',$3)",
        [propertyId, `logo-native-${suffix}`, organizationId],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'hotel_catalog','property',$2,'owner','active')",
        [organizationId, propertyId],
      );
      if (creatorUrl) {
        expect(
          (
            await creator.query(
              "SELECT current_user='vayada_admin' AND rolcanlogin AND rolcreaterole AND NOT (rolsuper OR rolreplication OR rolbypassrls) AS safe FROM pg_catalog.pg_roles WHERE rolname=current_user",
            )
          ).rows[0]?.safe,
        ).toBe(true);
      }
      await creator.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await creator.query(
        `GRANT vayada_next_hotel_setup_logo_scope TO ${role} WITH INHERIT TRUE, SET FALSE`,
      );
      await admin.query(
        "INSERT INTO platform.hotel_setup_property_scopes(database_login,property_id,organization_id,operation_class,actor_user_id) VALUES($1,$2,$3,'property_logo',$4)",
        [role, propertyId, organizationId, actorUserId],
      );
      const connection = new URL(url);
      connection.username = role;
      connection.password = password;
      native = new pg.Pool({ connectionString: connection.toString(), max: 6 });
      if (creatorUrl) {
        expect(
          (
            await admin.query(
              "SELECT edge.admin_option AND NOT edge.inherit_option AND NOT edge.set_option AND grantor.rolsuper AS safe FROM pg_catalog.pg_auth_members edge JOIN pg_catalog.pg_roles administrator ON administrator.oid=edge.member JOIN pg_catalog.pg_roles grantor ON grantor.oid=edge.grantor WHERE edge.roleid=$1::regrole AND administrator.rolname='vayada_admin'",
              [role],
            )
          ).rows[0]?.safe,
        ).toBe(true);
        for (const options of [
          "ADMIN TRUE, INHERIT TRUE, SET FALSE",
          "ADMIN TRUE, INHERIT FALSE, SET TRUE",
          "ADMIN FALSE, INHERIT FALSE, SET FALSE",
        ]) {
          await admin.query(`GRANT ${role} TO vayada_admin WITH ${options}`);
          expect(
            (
              await native.query(
                "SELECT platform.hotel_setup_logo_bootstrap_proof_allowed($1,$2,$3) AS allowed",
                [propertyId, organizationId, actorUserId],
              )
            ).rows[0]?.allowed,
          ).toBe(false);
          await expect(assertHotelSetupLogoPrivileges(native)).rejects.toThrow();
          await admin.query(
            `GRANT ${role} TO vayada_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
          );
        }
        await assertHotelSetupLogoPrivileges(native);
      }
      expect(
        (
          await native.query(
            "SELECT platform.hotel_setup_logo_bootstrap_proof_allowed($1,$2,$3) AS allowed",
            [propertyId, organizationId, actorUserId],
          )
        ).rows[0]?.allowed,
      ).toBe(true);
      expect(
        (
          await native.query("SELECT platform.hotel_setup_logo_row_allowed($1,$2,$3) AS allowed", [
            propertyId,
            organizationId,
            actorUserId,
          ])
        ).rows[0]?.allowed,
      ).toBe(false);
      await expect(
        native.query("SELECT platform.hotel_setup_logo_authority($1,$2,$3,TRUE)", [
          propertyId,
          organizationId,
          actorUserId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "INSERT INTO platform.media_upload_sessions(id,upload_session_key,requested_purpose,requested_visibility,actor_user_id,owner_organization_id,property_id,resource_product,resource_type,resource_id,expected_content_type,expected_size_bytes,expected_file_count,staging_prefix,expires_at,session_status,completion_metadata) VALUES($1::uuid,$2,'property.logo','private',$3::uuid,$4::uuid,$5::uuid,'hotel_catalog','property',($5::uuid)::text,'image/jpeg',1024,1,$6,now()+interval '15 minutes','signed','{}')",
          [
            sessionId,
            `pending:${sessionId}`,
            actorUserId,
            organizationId,
            propertyId,
            `staging/${sessionId}`,
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        "UPDATE platform.hotel_setup_property_scopes SET credential_role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1),credential_secret_version=$2,credential_ready_at=now() WHERE database_login=$1",
        [role, randomUUID()],
      );
      await admin.query(
        "GRANT pg_read_server_files TO vayada_next_hotel_setup_logo_scope WITH INHERIT TRUE",
      );
      try {
        expect(
          (
            await native.query("SELECT platform.hotel_setup_logo_allowed($1,$2,$3) AS allowed", [
              propertyId,
              organizationId,
              actorUserId,
            ])
          ).rows[0]?.allowed,
        ).toBe(false);
        await expect(assertHotelSetupLogoPrivileges(native)).rejects.toThrow();
      } finally {
        await admin.query("REVOKE pg_read_server_files FROM vayada_next_hotel_setup_logo_scope");
      }
      expect(
        (
          await native.query(
            "SELECT platform.hotel_setup_logo_bootstrap_proof_allowed($1,$2,$3) AS allowed",
            [propertyId, organizationId, actorUserId],
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      const catalogClient = await native.connect();
      try {
        await catalogClient.query("BEGIN");
        await catalogClient.query(
          "CREATE TEMP TABLE pg_proc AS SELECT * FROM pg_catalog.pg_proc WITH NO DATA",
        );
        await catalogClient.query("SET LOCAL search_path=pg_temp,pg_catalog");
        await assertHotelSetupLogoPrivileges(catalogClient);
        await catalogClient.query("ROLLBACK");
      } finally {
        await catalogClient.query("ROLLBACK").catch(() => undefined);
        catalogClient.release();
      }
      const authorize = async (client: HotelSetupPrivilegeQueryable) => {
        await assertHotelSetupLogoPrivileges(client);
        await assertHotelSetupLogoScope(client, { propertyId, organizationId, actorUserId });
      };
      const uploads = createPgPlatformMediaRepository({
        connectionString: connection.toString(),
        pool: native,
        publicCdnBaseUrl: "https://images.vayada.com",
        authorizeWriteTransaction: authorize,
      });
      const now = new Date().toISOString(),
        expiresAt = new Date(Date.now() + 900000).toISOString();
      const session = await uploads.createUploadSession({
        sessionId,
        uploadSessionKey: `logo.native:${sessionId}`,
        stagingPrefix: `staging/${sessionId}`,
        ownerOrganizationId: organizationId,
        context: {
          actor: { internalUserId: actorUserId },
          selectedOrganization: { organizationId },
        } as never,
        request: {
          purpose: "property.logo",
          visibility: "private",
          resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
          files: [
            {
              clientFileId: "logo",
              filename: "logo.jpg",
              contentType: "image/jpeg",
              sizeBytes: 1024,
            },
          ],
        },
        policy: { purpose: "property.logo", privateOnly: true } as never,
        target: {
          resourceProduct: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          propertyId,
        },
        uploadTargets: [
          {
            uploadTargetId: randomUUID(),
            clientFileId: "logo",
            method: "PUT",
            uploadUrl: "https://s3.example.test/signed",
            headers: { "content-type": "image/jpeg" },
            stagingKey: `staging/${sessionId}/logo.jpg`,
            expiresAt,
          },
        ],
        now,
        expiresAt,
        auditEvent: {
          action: "platform_media.upload_session.created",
          auditKey: `logo.created:${sessionId}`,
          actorUserId,
          organizationId,
          targetType: "media_upload_session",
          targetId: sessionId,
          requestId: sessionId,
          metadata: { purpose: "property.logo" },
        },
      });
      await expect(
        native.query(
          "UPDATE platform.media_upload_sessions SET completion_metadata=(jsonb_set(completion_metadata,'{session,uploadTargets}', '[{}]'::jsonb)#-'{session,files,0,uploadTargetId}') WHERE id=$1",
          [sessionId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const signedForCompletion = (await uploads.findUploadSessionForActor({
        sessionId,
        actorUserId,
        ownerOrganizationId: organizationId,
      }))!;
      await expect(
        uploads.completeUploadSession({
          ...completion(signedForCompletion),
          bucketName: "unreviewed-media-bucket",
        }),
      ).rejects.toMatchObject({ outcome: "rolled_back", cause: { code: "42501" } });
      const manifest = completion(signedForCompletion).variantSets[0]!.map((v) => ({
        ...v,
        mediaId: signedForCompletion.files[0]!.mediaId,
      }));
      await native.query(
        "UPDATE platform.media_upload_sessions SET private_artifact_manifest=$2::jsonb WHERE id=$1",
        [sessionId, JSON.stringify(manifest)],
      );
      await expect(
        native.query(
          "UPDATE platform.media_upload_sessions SET private_artifact_manifest='[]'::jsonb WHERE id=$1",
          [sessionId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const completed = await uploads.completeUploadSession(
        completion(
          (await uploads.findUploadSessionForActor({
            sessionId,
            actorUserId,
            ownerOrganizationId: organizationId,
          }))!,
        ),
      );
      expect(completed.mediaObjects[0]?.visibility).toBe("private");
      // A privileged migration session may operate an unrelated restricted worker.
      const ordinary = `vay965_worker_${suffix}`,
        alias = `vay965_logo_alias_${suffix}`;
      await admin.query(`CREATE ROLE ${ordinary} NOLOGIN NOSUPERUSER`);
      await admin.query(`CREATE ROLE ${alias} NOLOGIN NOSUPERUSER`);
      try {
        await admin.query(`GRANT USAGE ON SCHEMA platform TO ${ordinary},${alias}`);
        await admin.query(`GRANT SELECT ON platform.media_objects TO ${ordinary},${alias}`);
        await admin.query(
          `GRANT vayada_next_hotel_setup_logo_scope TO ${alias} WITH INHERIT TRUE, SET FALSE`,
        );
        await admin.query(`SET ROLE ${ordinary}`);
        expect(
          (await admin.query("SELECT platform.hotel_setup_logo_login_guard() AS allowed")).rows[0]
            ?.allowed,
        ).toBe(true);
        expect(
          (
            await admin.query("SELECT id FROM platform.media_objects WHERE id=$1", [
              completed.mediaObjects[0]!.mediaId,
            ])
          ).rows,
        ).toHaveLength(1);
        await admin.query("RESET ROLE");
        await admin.query(`SET ROLE ${alias}`);
        expect(
          (await admin.query("SELECT platform.hotel_setup_logo_login_guard() AS allowed")).rows[0]
            ?.allowed,
        ).toBe(false);
        expect(
          (
            await admin.query("SELECT id FROM platform.media_objects WHERE id=$1", [
              completed.mediaObjects[0]!.mediaId,
            ])
          ).rows,
        ).toHaveLength(0);
      } finally {
        await admin.query("RESET ROLE");
        await admin.query(`DROP OWNED BY ${ordinary},${alias}`);
        await admin.query(`DROP ROLE ${ordinary},${alias}`);
      }

      const copyToPublic = vi.fn(async () => undefined),
        deletePublic = vi.fn(async () => undefined);
      const commands = createPgS3PropertyMediaCommandRepository({
        connectionString: connection.toString(),
        pool: native,
        authorizeTransaction: authorize,
        serving: {
          bucketName: "vayada-media-production",
          cdnBaseUrl: "https://images.vayada.com",
          cdnOriginHost: "vayada-media-production.s3.example.test",
          publicPathPrefix: "media",
          publicCacheControl: "public, max-age=31536000, immutable",
          privateDownloadTtlSeconds: 300,
          privateDownloadMaxTtlSeconds: 900,
        },
        publisher: { copyToPublic, deletePublic },
        syncReadModels: async (client, input) => {
          await client.query("SELECT platform.sync_hotel_setup_logo_read_models($1::uuid)", [
            input.propertyId,
          ]);
        },
      });
      const command = {
        organizationId,
        propertyId,
        actorUserId,
        idempotencyKey: `logo.assign:${sessionId}`,
        expectedProfileRevision: 1,
        assignment: {
          mediaObjectId: session.files[0]!.mediaId,
          altText: "TEST ONLY logo",
          role: "logo" as const,
          sortOrder: 0 as const,
        },
        audit: { requestId: sessionId, source: "api" as const, receivedAt: now },
      };
      const result = await commands.assignLogo(command);
      expect(result).toMatchObject({ ok: true, response: { profileRevision: 3 } });
      expect(copyToPublic).toHaveBeenCalledTimes(4);
      expect(await commands.assignLogo(command)).toMatchObject({
        ok: true,
        response: { outcome: "idempotent_replay", profileRevision: 3 },
      });
      expect(copyToPublic).toHaveBeenCalledTimes(4);
      expect(
        (
          await uploads.findUploadSessionForActor({
            sessionId,
            actorUserId,
            ownerOrganizationId: organizationId,
          })
        )?.status,
      ).toBe("completed");
      expect(
        (
          await admin.query(
            "SELECT media_type,public_approved FROM hotel_catalog.property_media WHERE property_id=$1",
            [propertyId],
          )
        ).rows,
      ).toEqual([{ media_type: "logo", public_approved: true }]);
      expect(
        (
          await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
            propertyId,
          ])
        ).rows[0]?.profile_revision,
      ).toBe("3");
      await expect(
        native.query(
          "UPDATE platform.media_upload_sessions SET completion_metadata=jsonb_set(completion_metadata,'{session,actorUserId}',to_jsonb($2::text)) WHERE id=$1",
          [sessionId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.idempotency_keys SET idempotency_metadata=jsonb_set(idempotency_metadata,'{commandActorUserId}',to_jsonb($1::text))",
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.media_variants SET storage_key='public/media/foreign' WHERE media_object_id=$1",
          [session.files[0]!.mediaId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const originalMediaId = session.files[0]!.mediaId;
      const originalJob = (
        await admin.query("SELECT payload FROM platform.jobs WHERE property_id=$1", [propertyId])
      ).rows[0]!.payload;
      for (const purpose of ["property.hero_image", "property.gallery_image"]) {
        const approvedId = randomUUID();
        await admin.query(
          "INSERT INTO platform.media_objects(id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,checksum_sha256,width_px,height_px,source_metadata,public_approved,created_by_user_id) SELECT $2::uuid,bucket,replace(storage_key,id::text,$2::text),storage_kind,visibility,$3,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,checksum_sha256,width_px,height_px,source_metadata,public_approved,created_by_user_id FROM platform.media_objects WHERE id=$1",
          [originalMediaId, approvedId, purpose],
        );
        await admin.query(
          "INSERT INTO platform.media_variants(media_object_id,variant_name,visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,public_cdn_url) SELECT $2::uuid,variant_name,visibility,replace(storage_key,$1::text,$2::text),content_type,width_px,height_px,size_bytes,checksum_sha256,replace(public_cdn_url,$1::text,$2::text) FROM platform.media_variants WHERE media_object_id=$1::uuid",
          [originalMediaId, approvedId],
        );
        const forged = JSON.parse(JSON.stringify(originalJob));
        forged.command.assignments[0].mediaObjectId = approvedId;
        forged.media[0].mediaObjectId = approvedId;
        forged.media[0].originalSafeUrl = forged.media[0].originalSafeUrl.replace(
          originalMediaId,
          approvedId,
        );
        for (const v of forged.media[0].promotion)
          for (const key of ["privateStorageKey", "publicStorageKey", "publicUrl"])
            v[key] = v[key].replace(originalMediaId, approvedId);
        await expect(
          native.query("UPDATE platform.jobs SET payload=$1::jsonb", [JSON.stringify(forged)]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          native.query(
            "UPDATE platform.media_variants SET public_cdn_url='https://attacker.invalid/media/foreign' WHERE media_object_id=$1",
            [approvedId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        const revision = Number(
          (
            await admin.query("SELECT profile_revision FROM hotel_catalog.properties WHERE id=$1", [
              propertyId,
            ])
          ).rows[0]!.profile_revision,
        );
        expect(
          await commands.assignLogo({
            ...command,
            idempotencyKey: `reuse:${approvedId}`,
            expectedProfileRevision: revision,
            assignment: { ...command.assignment, mediaObjectId: approvedId },
          }),
        ).toMatchObject({ ok: true, response: { profileRevision: revision + 1 } });
        expect(copyToPublic).toHaveBeenCalledTimes(4);
      }
      const wrongCdn = JSON.parse(JSON.stringify(originalJob));
      for (const v of wrongCdn.media[0].promotion)
        v.publicUrl = v.publicUrl.replace("images.vayada.com", "attacker.invalid");
      wrongCdn.media[0].originalSafeUrl = wrongCdn.media[0].originalSafeUrl.replace(
        "images.vayada.com",
        "attacker.invalid",
      );
      await expect(
        native.query("UPDATE platform.jobs SET payload=$1::jsonb", [JSON.stringify(wrongCdn)]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE hotel_catalog.properties SET profile_status='complete',completeness_reasons='{}'::text[],profile_revision=profile_revision+1 WHERE id=$1",
          [propertyId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.idempotency_keys SET idempotency_metadata=idempotency_metadata-'commandActorUserId'",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.jobs SET payload=jsonb_set(payload,'{command,actorUserId}',to_jsonb($1::text))",
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.jobs SET job_metadata=jsonb_set(job_metadata,'{cleanupKeys}',$1::jsonb)",
          [JSON.stringify(["public/media/foreign/original_safe/publication-foreign.webp"])],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.media_upload_sessions SET completion_metadata=jsonb_set(completion_metadata,'{session,completedMediaObjects,0,approvalStatus}','\"approved\"'::jsonb) WHERE id=$1",
          [sessionId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        native.query(
          "UPDATE platform.media_upload_sessions SET private_artifact_manifest=$2::jsonb WHERE id=$1",
          [
            sessionId,
            JSON.stringify([
              {
                mediaId: randomUUID(),
                variantName: "original_safe",
                visibility: "private",
                storageKey: "private/media/foreign",
                contentType: "image/webp",
                widthPx: 1,
                heightPx: 1,
                sizeBytes: 1,
                checksumSha256: "a".repeat(64),
                publicCdnUrl: null,
              },
            ]),
          ],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await admin.query(
        "UPDATE identity.organization_memberships SET status='inactive' WHERE organization_id=$1",
        [organizationId],
      );
      await expect(commands.assignLogo(command)).rejects.toThrow();
      expect((await native.query("SELECT id FROM platform.media_upload_sessions")).rows).toEqual(
        [],
      );
      await commands.close();
      await uploads.close?.();
    } finally {
      await native?.end();
      await admin.query("SET session_replication_role=replica");
      await admin.query("DELETE FROM platform.product_audit_events WHERE actor_user_id=$1", [
        actorUserId,
      ]);
      await admin.query(
        "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)",
        [propertyId],
      );
      await admin.query("DELETE FROM platform.dead_letter_events WHERE property_id=$1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.jobs WHERE property_id=$1", [propertyId]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id=$1", [propertyId]);
      await admin.query("DELETE FROM platform.media_upload_sessions WHERE property_id=$1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM hotel_catalog.property_media WHERE property_id=$1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.media_objects WHERE property_id=$1", [propertyId]);
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
      await admin.query("DELETE FROM identity.users WHERE id=$1", [actorUserId]);
      await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
      await admin.query("SET session_replication_role=origin");
      await admin.query(`DROP OWNED BY ${role}`);
      await creator.query(`DROP ROLE ${role}`);
      if (creator !== admin) await creator.end();
      await admin.end();
    }
  });
});
function completion(session: PlatformMediaSessionRecord) {
  const mediaId = session.files[0]!.mediaId;
  const dimensions = {
    original_safe: { widthPx: 1200, heightPx: 800 },
    large: { widthPx: 1080, heightPx: 720 },
    thumbnail: { widthPx: 270, heightPx: 180 },
    blur_preview: { widthPx: 27, heightPx: 18 },
  };
  const variants = PROPERTY_MEDIA_PUBLIC_VARIANTS.map((variantName, index) => ({
    variantName,
    visibility: "private" as const,
    storageKey: `private/media/${mediaId}/${variantName}/sha256-${(index + 2).toString(16).repeat(64)}.webp`,
    contentType: "image/webp",
    ...dimensions[variantName],
    sizeBytes: 900 - index * 100,
    checksumSha256: (index + 2).toString(16).repeat(64),
    publicCdnUrl: null,
  }));
  return {
    session,
    files: [
      {
        sessionFile: session.files[0]!,
        uploadTarget: session.uploadTargets[0]!,
        inspection: {
          contentType: "image/webp",
          sizeBytes: 900,
          checksumSha256: "a".repeat(64),
          widthPx: 1200,
          heightPx: 800,
        },
      },
    ],
    variantSets: [variants],
    bucketName: "vayada-media-production",
    now: new Date().toISOString(),
    auditEvent: {
      action: "platform_media.upload_session.finalized" as const,
      auditKey: `logo.finalized:${session.sessionId}`,
      actorUserId: session.actorUserId,
      organizationId: session.ownerOrganizationId,
      targetType: "media_object" as const,
      targetId: mediaId,
      requestId: session.sessionId,
      metadata: { purpose: "property.logo" },
    },
  };
}
