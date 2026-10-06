import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  parsePublicationJobPayload,
  publicationCleanupKeys,
  PUBLICATION_JOB_LEASE_MS,
  sha256,
} from "./domains/propertyMediaCommandEnvelope.js";
import {
  claimPublicationJob,
  finalizePublicationFailure,
  type CommandPool,
  type CommandPoolClient,
} from "./domains/propertyMediaCommandStore.js";
import { syncPropertyOfferReadModels } from "./routes/marketplaceAdmin.js";

export type HotelSetupLogoCleanupTarget = {
  kind: "upload_session" | "publication_job";
  targetId: string;
  propertyId: string;
  organizationId: string;
  actorUserId: string;
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Protected operational image only. Native Owner roles cannot pass the ownership check. */
export async function runHotelSetupLogoCleanup(input: {
  pool: CommandPool;
  target: HotelSetupLogoCleanupTarget;
  expectedManifestSha256?: string;
  deleteKey(key: string): Promise<void>;
  now?: Date;
}) {
  const { pool, target } = input;
  if (
    ![target.targetId, target.propertyId, target.organizationId, target.actorUserId].every((id) =>
      uuid.test(id),
    ) ||
    !["upload_session", "publication_job"].includes(target.kind)
  )
    throw new Error("Invalid cleanup target");
  const now = input.now ?? new Date();
  const holder = await pool.connect();
  const receiptId = randomUUID();
  try {
    const lock = await holder.query<{ held: boolean }>(
      "SELECT pg_try_advisory_lock(8734516) AS held",
    );
    if (lock.rows[0]?.held !== true) throw new Error("Cleanup release lock unavailable");
    const authorize = async (client: CommandPoolClient) => {
      const result = await client.query<{ safe: boolean }>(
        `SELECT current_user=session_user
        AND current_user=(SELECT relowner::regrole::text FROM pg_class WHERE oid='platform.hotel_setup_property_scopes'::regclass)
        AND EXISTS(SELECT 1 FROM platform.hotel_setup_property_scopes scope JOIN pg_roles role ON role.rolname=scope.database_login
          WHERE scope.operation_class='property_logo' AND scope.property_id=$1::uuid AND scope.organization_id=$2::uuid
            AND scope.actor_user_id=$3::uuid AND scope.credential_role_oid=role.oid
            AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL) AS safe`,
        [target.propertyId, target.organizationId, target.actorUserId],
      );
      if (result.rows[0]?.safe !== true) throw new Error("Cleanup operational scope unavailable");
    };
    await holder.query("BEGIN");
    await authorize(holder);
    await holder.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE", [
      target.propertyId,
    ]);
    let keys: string[];
    let mediaIds: string[];
    if (target.kind === "upload_session") {
      const row = (
        await holder.query<{ session: any; manifest: any; valid: boolean }>(
          `SELECT completion_metadata->'session' AS session, private_artifact_manifest AS manifest,
        platform.hotel_setup_logo_session_binding(id,property_id,owner_organization_id,actor_user_id,completion_metadata->'session')
        AND platform.hotel_setup_logo_manifest_valid(completion_metadata,private_artifact_manifest) AS valid
        FROM platform.media_upload_sessions WHERE id=$1::uuid AND property_id=$2::uuid AND owner_organization_id=$3::uuid
          AND actor_user_id=$4::uuid AND requested_purpose='property.logo' AND session_status IN('signed','failed')
          AND completed_media_object_id IS NULL AND expires_at<=$5::timestamptz-interval '30 minutes' FOR UPDATE`,
          [
            target.targetId,
            target.propertyId,
            target.organizationId,
            target.actorUserId,
            now.toISOString(),
          ],
        )
      ).rows[0];
      if (
        !row ||
        row.valid !== true ||
        row.session.files?.length !== 1 ||
        row.session.uploadTargets?.length !== 1
      )
        throw new Error("Cleanup session requires inspection");
      const mediaId = row.session.files[0].mediaId;
      mediaIds = [mediaId];
      const stagingKey = row.session.uploadTargets[0].stagingKey;
      if (
        !uuid.test(mediaId) ||
        stagingKey !== `staging/${target.targetId}/1/${row.session.files[0].filename}` ||
        stagingKey.includes("..") ||
        row.session.files[0].filename.includes("/")
      )
        throw new Error("Cleanup staging manifest invalid");
      const refs = await holder.query(
        `SELECT id FROM platform.media_objects WHERE id=$1::uuid
        UNION ALL SELECT id FROM hotel_catalog.property_media WHERE property_id=$2::uuid AND platform_media_object_id=$1::uuid
        UNION ALL SELECT id FROM platform.jobs WHERE property_id=$2::uuid AND payload->'media' @> jsonb_build_array(jsonb_build_object('mediaObjectId',$1::uuid::text))
        UNION ALL SELECT id FROM platform.media_upload_sessions WHERE id<>$3::uuid AND completion_metadata#>>'{session,files,0,mediaId}'=$1::uuid::text`,
        [mediaId, target.propertyId, target.targetId],
      );
      if (refs.rows.length) throw new Error("Cleanup preserves registered or pending artifacts");
      keys = [stagingKey, ...row.manifest.map((item: any) => item.storageKey)];
    } else {
      const job = (
        await holder.query<{ payload: unknown; status: string; lockedAt: Date | null }>(
          `SELECT payload,status,locked_at AS "lockedAt" FROM platform.jobs
        WHERE id=$1::uuid AND property_id=$2::uuid AND queue_name='hotel-catalog.property-media' AND job_type='hotel-catalog.property-media.publish' FOR UPDATE`,
          [target.targetId, target.propertyId],
        )
      ).rows[0];
      const payload = job && parsePublicationJobPayload(job.payload);
      if (
        !job ||
        !payload ||
        payload.command.operation !== "logo" ||
        payload.command.propertyId !== target.propertyId ||
        payload.command.organizationId !== target.organizationId ||
        payload.command.actorUserId !== target.actorUserId ||
        !["pending", "running", "dead_lettered"].includes(job.status) ||
        (job.status === "running" &&
          (!job.lockedAt || job.lockedAt.getTime() > now.getTime() - PUBLICATION_JOB_LEASE_MS))
      )
        throw new Error("Cleanup publication requires inspection");
      const fence = await holder.query(
        `SELECT id FROM platform.idempotency_keys WHERE id=$1::uuid AND property_id=$2::uuid AND operation='hotel_catalog.property_media.logo.assign'
        AND key_hash=$3 AND request_fingerprint_hash=$4 AND idempotency_metadata->>'commandActorUserId'=$5 AND idempotency_metadata->>'commandOrganizationId'=$6
        AND ((status='in_progress' AND idempotency_metadata#>>'{publication,jobId}'=$7)
          OR (status='completed' AND idempotency_metadata#>>'{result,ok}'='false')) FOR UPDATE`,
        [
          payload.idempotencyId,
          target.propertyId,
          payload.keyHash,
          payload.requestFingerprintHash,
          target.actorUserId,
          target.organizationId,
          target.targetId,
        ],
      );
      if (fence.rows.length !== 1) throw new Error("Cleanup publication fence unavailable");
      for (const media of payload.media) {
        const objects = await holder.query(
          `SELECT id FROM platform.media_objects WHERE id=$1::uuid AND property_id=$2::uuid AND owner_organization_id=$3::uuid
          AND created_by_user_id=$4::uuid AND purpose='property.logo' AND visibility='private' AND NOT public_approved FOR UPDATE`,
          [media.mediaObjectId, target.propertyId, target.organizationId, target.actorUserId],
        );
        if (objects.rows.length !== 1)
          throw new Error("Cleanup preserves published or foreign media");
        const refs = await holder.query(
          `SELECT id FROM hotel_catalog.property_media WHERE property_id=$1::uuid AND platform_media_object_id=$2::uuid
          AND NOT (public_approved=FALSE AND rights_metadata->>'publicationJobId'=$3)
          UNION ALL SELECT id FROM platform.jobs WHERE property_id=$1::uuid AND id<>$3::uuid AND status IN('pending','running')
            AND payload->'media' @> jsonb_build_array(jsonb_build_object('mediaObjectId',$2::uuid::text))`,
          [target.propertyId, media.mediaObjectId, target.targetId],
        );
        if (refs.rows.length) throw new Error("Cleanup preserves referenced media");
        const variants = await holder.query<{ key: string; name: string; checksum: string }>(
          `SELECT storage_key AS key,variant_name AS name,checksum_sha256 AS checksum FROM platform.media_variants WHERE media_object_id=$1::uuid AND visibility='private' FOR UPDATE`,
          [media.mediaObjectId],
        );
        if (
          variants.rows.length !== 4 ||
          media.promotion.some(
            (v) =>
              v.publicStorageKey !==
                `public/media/${media.mediaObjectId}/${v.variantName}/publication-${payload.publicationToken}.webp` ||
              !variants.rows.some(
                (row) =>
                  row.name === v.variantName &&
                  row.key === v.privateStorageKey &&
                  row.key ===
                    `private/media/${media.mediaObjectId}/${row.name}/sha256-${row.checksum}.webp`,
              ),
          )
        )
          throw new Error("Cleanup registry evidence differs");
      }
      keys = publicationCleanupKeys(payload.media);
      mediaIds = payload.media.map((media) => media.mediaObjectId);
    }
    keys = [...new Set(keys)].sort();
    const manifestSha256 = sha256(canonicalJson({ ...target, keys }));
    const receipt = {
      kind: target.kind,
      targetId: target.targetId,
      manifestSha256,
      keyCount: keys.length,
    };
    if (!input.expectedManifestSha256) {
      await holder.query("ROLLBACK");
      return { status: "PLAN" as const, ...receipt };
    }
    if (input.expectedManifestSha256 !== manifestSha256)
      throw new Error("Cleanup manifest changed");
    if (target.kind === "upload_session") {
      await holder.query(
        `UPDATE platform.media_upload_sessions SET session_status='failed',completion_metadata=jsonb_set(completion_metadata,'{session,status}','"failed"'::jsonb),
        updated_at=$2::timestamptz WHERE id=$1::uuid`,
        [target.targetId, now.toISOString()],
      );
      await holder.query("COMMIT");
    } else {
      await holder.query("ROLLBACK");
      // The operational holder must not occupy the only pool slot while the existing saga acquires a client.
      const direct: CommandPool = {
        connect: async () => ({ query: holder.query.bind(holder), release: () => {} }),
        end: async () => {},
        authorizeTransaction: authorize,
      };
      const status = (
        await holder.query<{ status: string }>(
          "SELECT status FROM platform.jobs WHERE id=$1::uuid",
          [target.targetId],
        )
      ).rows[0]?.status;
      if (status !== "dead_lettered") {
        const claimed = await claimPublicationJob(direct, {
          jobId: target.targetId,
          force: false,
          workerId: `logo-cleanup:${receiptId}`,
          now,
        });
        if (!claimed || !("publicationClaim" in claimed))
          throw new Error("Cleanup publication claim unavailable");
        await finalizePublicationFailure(
          direct,
          claimed.publicationClaim,
          now,
          "Stopped logo publication cleanup",
          syncPropertyOfferReadModels,
          {
            attemptAlreadyFinished:
              claimed.publicationClaim.cleanupRequired ||
              claimed.publicationClaim.exhaustedBeforeClaim,
          },
        );
      }
    }
    await holder.query("BEGIN");
    await authorize(holder);
    await holder.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE", [
      target.propertyId,
    ]);
    // Exact terminal acknowledgement precedes deletion; COMMIT uncertainty never permits a blind delete.
    const terminal =
      target.kind === "upload_session"
        ? await holder.query(
            "SELECT id FROM platform.media_upload_sessions WHERE id=$1::uuid AND session_status='failed' AND completed_media_object_id IS NULL FOR UPDATE",
            [target.targetId],
          )
        : await holder.query(
            "SELECT id FROM platform.jobs WHERE id=$1::uuid AND status='dead_lettered' FOR UPDATE",
            [target.targetId],
          );
    if (terminal.rows.length !== 1) throw new Error("Cleanup terminal receipt unavailable");
    const referenced =
      target.kind === "upload_session"
        ? await holder.query("SELECT id FROM platform.media_objects WHERE id=ANY($1::uuid[])", [
            mediaIds,
          ])
        : await holder.query(
            `SELECT object.id FROM platform.media_objects object WHERE object.id=ANY($1::uuid[])
        AND (object.visibility<>'private' OR object.public_approved OR EXISTS(SELECT 1 FROM platform.media_variants variant WHERE variant.media_object_id=object.id AND variant.visibility<>'private')) FOR UPDATE`,
            [mediaIds],
          );
    if (referenced.rows.length) throw new Error("Cleanup publication outcome changed");
    const assignments = await holder.query(
      "SELECT id FROM hotel_catalog.property_media WHERE property_id=$1::uuid AND platform_media_object_id=ANY($2::uuid[])",
      [target.propertyId, mediaIds],
    );
    if (assignments.rows.length) throw new Error("Cleanup preserves referenced artifacts");
    for (const key of keys) await input.deleteKey(key);
    if (target.kind === "publication_job")
      await holder.query(
        `UPDATE platform.jobs SET job_metadata=job_metadata||jsonb_build_object('cleanupRequired',false,'cleanupPassesRemaining',0,'cleanupReconciledAt',$2::text) WHERE id=$1::uuid`,
        [target.targetId, now.toISOString()],
      );
    else
      await holder.query(
        `UPDATE platform.media_upload_sessions SET completion_metadata=completion_metadata||jsonb_build_object('artifactCleanup',jsonb_build_object('manifestSha256',$2::text,'completedAt',$3::text)) WHERE id=$1::uuid`,
        [target.targetId, manifestSha256, now.toISOString()],
      );
    await holder.query("COMMIT");
    return { status: "PASS" as const, ...receipt };
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await holder.query("SELECT pg_advisory_unlock(8734516)").catch(() => undefined);
    holder.release();
  }
}
