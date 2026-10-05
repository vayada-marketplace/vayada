import pg from "pg";
import {
  createHotelSetupLogoCredentialResolver,
  type HotelSetupCredentialOptions,
} from "./hotelSetupCommandCredentials.js";
import { assertHotelSetupLogoScope } from "./hotelSetupCommandScope.js";
import { assertHotelSetupLogoPrivileges } from "./hotelSetupLogoPrivileges.js";
import {
  createPgS3PropertyMediaCommandRepository,
  type PropertyMediaCommandRepository,
} from "./domains/propertyMediaCommandRepository.js";
import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import { createS3PlatformMediaAdapter } from "./platform/platformMediaS3.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import type { PlatformMediaRoutesOptions } from "./routes/platformMedia.js";

/** Native credentials and pools are selected per verified request, never cached or shared. */
export function createHotelSetupLogoRuntime(
  options: HotelSetupCredentialOptions,
  serving: PlatformMediaServingConfig,
  allowedOrigins: string[] = [],
) {
  const resolve = createHotelSetupLogoCredentialResolver(options);
  const adapter = createS3PlatformMediaAdapter({
    bucketName: serving.bucketName,
    cdnBaseUrl: serving.cdnBaseUrl,
    publicPathPrefix: serving.publicPathPrefix,
    publicCacheControl: serving.publicCacheControl,
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("Private logo request persistence required");
  };
  async function acquire(scope: {
    propertyId: string;
    organizationId: string;
    actorUserId: string;
  }) {
    const connectionString = await resolve(
      scope.propertyId,
      scope.organizationId,
      scope.actorUserId,
    );
    const pool = new pg.Pool({ connectionString, max: 1 });
    const authorize = async (client: Parameters<typeof assertHotelSetupLogoScope>[0]) => {
      await assertHotelSetupLogoPrivileges(client);
      await assertHotelSetupLogoScope(client, scope);
    };
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await authorize(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return { pool, connectionString, authorize };
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  const uploads: PlatformMediaRoutesOptions = {
    // These ports cannot be reached without the required request factory.
    repository: {
      createUploadSession: unavailable,
      renewSignedUploadSession: unavailable,
      findUploadSession: unavailable,
      findUploadSessionForActor: unavailable,
      findMediaObject: unavailable,
      completeUploadSession: unavailable,
      createImportJob: unavailable,
      recordAudit: unavailable,
    },
    targetResolver: { resolveTarget: unavailable },
    signer: adapter,
    finalizer: adapter,
    enabledPurposes: ["property.logo"],
    logoOnly: true,
    bucketName: serving.bucketName,
    mediaPathPrefix: serving.publicPathPrefix,
    allowedOrigins,
    async resolveRequestPersistence(input) {
      const organizationId = input.context.selectedOrganization.organizationId;
      const actorUserId = input.context.actor.internalUserId;
      let propertyId: string;
      if (input.operation === "create") {
        const resource = input.request.resource;
        if (
          input.request.purpose !== "property.logo" ||
          resource.product !== "hotel_catalog" ||
          resource.resourceType !== "property" ||
          resource.targetResourceId ||
          (resource.propertyId && resource.propertyId !== resource.resourceId)
        )
          throw new Error("Invalid logo target");
        propertyId = resource.resourceId;
      } else {
        const result = await options.assignments.query<{ propertyId: string }>(
          `SELECT property_id::text AS "propertyId" FROM platform.media_upload_sessions
           WHERE id=$1::uuid AND actor_user_id=$2::uuid AND owner_organization_id=$3::uuid
             AND requested_purpose='property.logo' AND resource_product='hotel_catalog'
             AND resource_type='property' AND resource_id=property_id::text`,
          [input.sessionId, actorUserId, organizationId],
        );
        if (result.rows.length !== 1) throw new Error("Missing logo session");
        propertyId = result.rows[0]!.propertyId;
      }
      const native = await acquire({ propertyId, organizationId, actorUserId });
      try {
        const repository = createPgPlatformMediaRepository({
          ...native,
          publicCdnBaseUrl: serving.cdnBaseUrl,
          mediaPathPrefix: serving.publicPathPrefix,
          authorizeWriteTransaction: native.authorize,
        });
        return { repository, targetResolver: repository, close: () => native.pool.end() };
      } catch (error) {
        await native.pool.end();
        throw error;
      }
    },
  };
  const assignments = {
    async assignLogo(command) {
      const native = await acquire(command);
      let repository: PropertyMediaCommandRepository | undefined;
      try {
        repository = createPgS3PropertyMediaCommandRepository({
          ...native,
          serving,
          authorizeTransaction: native.authorize,
          syncReadModels: async (client, input) => {
            await client.query("SELECT platform.sync_hotel_setup_logo_read_models($1::uuid)", [
              input.propertyId,
            ]);
          },
        });
        return await repository.assignLogo(command);
      } finally {
        try {
          await repository?.close();
        } finally {
          await native.pool.end();
        }
      }
    },
    replacePresentation: unavailable,
    replacePlatformAdminHero: unavailable,
    getPlatformAdminHero: unavailable,
    runPublicationBatch: unavailable,
    close: async () => {},
  } satisfies PropertyMediaCommandRepository;
  return { uploads, assignments };
}
