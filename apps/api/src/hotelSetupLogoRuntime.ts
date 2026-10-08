import type { RequestContext } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
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
import type { PropertyMediaReadModelSync } from "./domains/propertyMediaCommandStore.js";
import { lockHotelSetupOwnerAuthority } from "./platform/hotelSetupProfileWriter.js";
import { syncPropertyOfferReadModels } from "./routes/marketplaceAdmin.js";
import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import { createS3PlatformMediaAdapter } from "./platform/platformMediaS3.js";
import type { PlatformMediaServingConfig } from "./platform/mediaServing.js";
import type {
  PlatformMediaVariantRecord,
  PlatformMediaSessionRecord,
  PlatformMediaRoutesOptions,
} from "./routes/platformMedia.js";

type LogoScope = { propertyId: string; organizationId: string; actorUserId: string };
type LogoAuthorize = (client: Parameters<typeof assertHotelSetupLogoScope>[0]) => Promise<void>;
type LogoConnection = { pool: pg.Pool; connectionString: string; authorize: LogoAuthorize };

const LOGO_PERMISSIONS = ["hotel_catalog.setup.manage"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Native credentials and pools are selected per verified request, never cached or shared. */
export function createHotelSetupLogoRuntime(
  options: HotelSetupCredentialOptions,
  serving: PlatformMediaServingConfig,
  allowedOrigins: string[] = [],
) {
  const resolve = createHotelSetupLogoCredentialResolver(options);
  return buildHotelSetupLogoRuntime({
    lookup: options.assignments,
    serving,
    allowedOrigins,
    async connect(scope) {
      const connectionString = await resolve(
        scope.propertyId,
        scope.organizationId,
        scope.actorUserId,
      );
      return {
        pool: new pg.Pool({ connectionString, max: 1 }),
        connectionString,
        async authorize(client) {
          await assertHotelSetupLogoPrivileges(client);
          await assertHotelSetupLogoScope(client, scope);
        },
      };
    },
    async syncReadModels(client, input) {
      await client.query("SELECT platform.sync_hotel_setup_logo_read_models($1::uuid)", [
        input.propertyId,
      ]);
    },
  });
}

/** Public API logo on the ordinary login (VAY-2056): the same request-bound protocol as the
 * private service, with a per-request pool on the API connection and the parameterised Owner
 * authority of platform.hotel_setup_logo_authority (0468) re-locked in every write transaction.
 * Mounted on the shared media routes, it claims only property.logo requests. */
export function createOrdinaryHotelSetupLogoRuntime(input: {
  connectionString: string;
  lookup: Pick<pg.Pool, "query">;
  serving: PlatformMediaServingConfig;
  /** The shared routes' own persistence, returned unchanged for every non-logo request. */
  defaults: Pick<PlatformMediaRoutesOptions, "repository" | "targetResolver" | "finalizer">;
}) {
  return buildHotelSetupLogoRuntime({
    lookup: input.lookup,
    serving: input.serving,
    allowedOrigins: [],
    shared: input.defaults,
    async connect(scope) {
      return {
        pool: new pg.Pool({ connectionString: input.connectionString, max: 1 }),
        connectionString: input.connectionString,
        async authorize(client) {
          if (!(await lockHotelSetupOwnerAuthority(client, scope, LOGO_PERMISSIONS)))
            throw new AuthorizationError();
        },
      };
    },
    syncReadModels: syncPropertyOfferReadModels,
  });
}

/** The private service's logo gate (hotelSetupCommandService.ts), for the shared public routes. */
function assertLogoOwnerSession(context: RequestContext) {
  if (
    !context.actor.providerIdentity.sessionId ||
    context.selectedOrganization.kind !== "hotel_group" ||
    context.membership.roleKey !== "hotel_owner" ||
    !context.membership.permissions.includes("hotel_catalog.setup.manage")
  )
    throw new AuthorizationError();
}

function buildHotelSetupLogoRuntime(input: {
  lookup: Pick<pg.Pool, "query">;
  serving: PlatformMediaServingConfig;
  allowedOrigins: string[];
  shared?: Pick<PlatformMediaRoutesOptions, "repository" | "targetResolver" | "finalizer">;
  connect(scope: LogoScope): Promise<LogoConnection>;
  syncReadModels: PropertyMediaReadModelSync;
}) {
  const { serving, allowedOrigins, shared } = input;
  // Non-logo requests on the shared public routes keep the routes' default persistence.
  const defaults = shared && { ...shared, close: async () => {} };
  const adapter = createS3PlatformMediaAdapter({
    bucketName: serving.bucketName,
    cdnBaseUrl: serving.cdnBaseUrl,
    publicPathPrefix: serving.publicPathPrefix,
    publicCacheControl: serving.publicCacheControl,
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("Private logo request persistence required");
  };
  async function acquire(scope: LogoScope) {
    const { pool, connectionString, authorize } = await input.connect(scope);
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
    async resolveRequestPersistence(request) {
      const organizationId = request.context.selectedOrganization.organizationId;
      const actorUserId = request.context.actor.internalUserId;
      let propertyId: string;
      if (request.operation === "create") {
        // On the shared public routes every other purpose keeps the default persistence.
        if (defaults && request.request.purpose !== "property.logo") return defaults;
        const resource = request.request.resource;
        if (
          request.request.purpose !== "property.logo" ||
          resource.product !== "hotel_catalog" ||
          resource.resourceType !== "property" ||
          resource.targetResourceId ||
          (resource.propertyId && resource.propertyId !== resource.resourceId)
        )
          throw new Error("Invalid logo target");
        propertyId = resource.resourceId;
      } else {
        // A malformed id is never a logo session; the shared route answers 404 for it.
        if (defaults && !UUID.test(request.sessionId)) return defaults;
        const result = await input.lookup.query<{ propertyId: string }>(
          `SELECT property_id::text AS "propertyId" FROM platform.media_upload_sessions
           WHERE id=$1::uuid AND actor_user_id=$2::uuid AND owner_organization_id=$3::uuid
             AND requested_purpose='property.logo' AND resource_product='hotel_catalog'
             AND resource_type='property' AND resource_id=property_id::text`,
          [request.sessionId, actorUserId, organizationId],
        );
        if (result.rows.length === 0 && defaults) {
          // Fail closed: a logo session that is not this actor's never falls back to the shared
          // media path, which would skip the Owner re-check.
          const logo = await input.lookup.query<{ logo: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM platform.media_upload_sessions
               WHERE id=$1::uuid AND requested_purpose='property.logo') AS logo`,
            [request.sessionId],
          );
          if (logo.rows[0]?.logo !== false) throw new AuthorizationError();
          return defaults;
        }
        if (result.rows.length !== 1) throw new Error("Missing logo session");
        propertyId = result.rows[0]!.propertyId;
      }
      if (shared) assertLogoOwnerSession(request.context);
      const native = await acquire({ propertyId, organizationId, actorUserId });
      try {
        const repository = createPgPlatformMediaRepository({
          ...native,
          publicCdnBaseUrl: serving.cdnBaseUrl,
          mediaPathPrefix: serving.publicPathPrefix,
          authorizeWriteTransaction: native.authorize,
        });
        async function recordArtifact(
          session: PlatformMediaSessionRecord,
          mediaId: string,
          variant: PlatformMediaVariantRecord,
        ) {
          const artifact = JSON.stringify({ mediaId, ...variant });
          const client = await native.pool.connect();
          let commitAttempted = false;
          try {
            await client.query("BEGIN");
            await native.authorize(client);
            const persisted = await client.query(
              `UPDATE platform.media_upload_sessions
               SET private_artifact_manifest=private_artifact_manifest || jsonb_build_array($2::jsonb)
               WHERE id=$1::uuid AND session_status='signed' AND requested_purpose='property.logo'
                 AND NOT private_artifact_manifest @> jsonb_build_array($2::jsonb)
               RETURNING id`,
              [session.sessionId, artifact],
            );
            if (persisted.rowCount !== 1) {
              const existing = await client.query(
                `SELECT id FROM platform.media_upload_sessions
                WHERE id=$1::uuid AND session_status='signed' AND private_artifact_manifest @> jsonb_build_array($2::jsonb)`,
                [session.sessionId, artifact],
              );
              if (existing.rows.length !== 1)
                throw new Error("Private logo artifact receipt missing");
            }
            commitAttempted = true;
            await client.query("COMMIT");
          } catch (error) {
            if (!commitAttempted) {
              await client.query("ROLLBACK");
              throw error;
            }
            // No private PUT until an unknown COMMIT is reconciled against the exact persisted receipt.
            await client.query("ROLLBACK").catch(() => undefined);
            await client.query("BEGIN");
            try {
              await native.authorize(client);
              const existing = await client.query(
                `SELECT id FROM platform.media_upload_sessions
                WHERE id=$1::uuid AND session_status='signed' AND private_artifact_manifest @> jsonb_build_array($2::jsonb)`,
                [session.sessionId, artifact],
              );
              if (existing.rows.length !== 1)
                throw new Error("Private logo artifact commit requires inspection");
              await client.query("COMMIT");
            } catch (inspectionError) {
              await client.query("ROLLBACK").catch(() => undefined);
              throw inspectionError;
            }
          } finally {
            client.release();
          }
        }
        return {
          repository,
          targetResolver: repository,
          finalizer: {
            ...adapter,
            generateVariants: (input) =>
              adapter.generateVariants({
                ...input,
                beforeWriteVariant: (variant) =>
                  recordArtifact(input.session, input.file.sessionFile.mediaId, variant),
              }),
          },
          close: () => native.pool.end(),
        };
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
          syncReadModels: input.syncReadModels,
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
