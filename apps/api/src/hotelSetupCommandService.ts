import { timingSafeEqual } from "node:crypto";
import {
  registerPlatformMediaRoutes,
  type PlatformMediaRoutesOptions,
} from "./routes/platformMedia.js";
import { registerPropertyMediaRoutes } from "./routes/propertyMedia.js";
import type { PropertyMediaCommandRepository } from "./domains/propertyMediaCommandRepository.js";

import {
  AuthorizationResolutionError,
  UnauthorizedError,
  backendAuthPlugin,
  requireAuthContext,
  type BackendAuthPluginOptions,
} from "@vayada/backend-auth";
import {
  AuthorizationError,
  createAuthorizationResolver,
  type EntitlementRepository,
  type PropertyAccessRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import type { PmsPricingCommandPort } from "@vayada/domain-pms";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import {
  registerPmsModuleActivationRoutes,
  type PmsModuleActivationRepository,
} from "./routes/pmsModuleActivations.js";
import { registerPmsPricingCurrencyCommand } from "./routes/pmsPricing.js";
import {
  registerHotelSetupPropertyProfileUpdate,
  registerSharedHotelSetupPropertyCreation,
  registerSharedHotelSetupLaunchSettings,
  type SharedHotelSetupStatusRepository,
} from "./routes/sharedHotelSetupStatus.js";

type HotelSetupCommandServiceOptions = {
  logger?: FastifyServerOptions["logger"];
  internalToken: string;
  auth: Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
    rolePermissionRepository: RolePermissionRepository;
    entitlementRepository: EntitlementRepository;
    propertyAccessRepository: PropertyAccessRepository;
  };
  logoMedia?: { uploads: PlatformMediaRoutesOptions; assignments: PropertyMediaCommandRepository };
  currencyCommands?: Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency">;
  propertyCreation?: Pick<SharedHotelSetupStatusRepository, "createPropertyProfile">;
  launchSettings?: {
    updateLaunchSettings: Parameters<typeof registerSharedHotelSetupLaunchSettings>[1];
  };
  profileEdit?: {
    updatePropertyProfile: Parameters<typeof registerHotelSetupPropertyProfileUpdate>[1];
  };
  featureHub?: {
    reads: Pick<PmsModuleActivationRepository, "list" | "close">;
    commands: Pick<PmsModuleActivationRepository, "updateFinancials">;
    setupComplete: NonNullable<PmsModuleActivationRepository["isFinancialsSetupComplete"]>;
  };
};

/** Private setup endpoints. Credential selection belongs to its command adapter. */
export function buildHotelSetupCommandService(
  options: HotelSetupCommandServiceOptions,
): FastifyInstance {
  if (Buffer.byteLength(options.internalToken) < 32)
    throw new Error("Hotel setup internal token must contain at least 32 bytes");
  const app = Fastify({ logger: options.logger ?? false, disableRequestLogging: true });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const actual = request.headers["x-vayada-internal-token"];
    const wanted = Buffer.from(options.internalToken);
    const received = typeof actual === "string" ? Buffer.from(actual) : Buffer.alloc(0);
    if (received.length !== wanted.length || !timingSafeEqual(received, wanted))
      return reply.code(401).send({ code: "internal_unauthenticated" });
    if (
      Object.keys(request.headers).some(
        (header) =>
          header === "x-hotel-id" ||
          (header.startsWith("x-vayada-") && header !== "x-vayada-internal-token"),
      )
    )
      return reply.code(400).send({ code: "forwarded_context_rejected" });
    if (Object.keys(request.query as object).length !== 0)
      return reply.code(400).send({ code: "invalid_request" });
  });

  const { rolePermissionRepository, entitlementRepository, propertyAccessRepository, ...auth } =
    options.auth;
  app.register(backendAuthPlugin, {
    ...auth,
    authorizationResolver: createAuthorizationResolver(
      rolePermissionRepository,
      entitlementRepository,
      propertyAccessRepository,
    ),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UnauthorizedError)
      return reply.code(401).send({ code: "unauthenticated" });
    if (error instanceof AuthorizationResolutionError || error instanceof AuthorizationError)
      return reply.code(403).send({ code: "forbidden" });
    if ((error as { statusCode?: number }).statusCode === 400)
      return reply.code(400).send({ code: "invalid_request" });
    return reply.code(503).send({ code: "hotel_setup_unavailable" });
  });
  if (options.logoMedia) {
    const uploads = options.logoMedia.uploads;
    if (
      uploads.enabledPurposes.length !== 1 ||
      uploads.enabledPurposes[0] !== "property.logo" ||
      !uploads.resolveRequestPersistence
    )
      throw new Error("Private hotel logo persistence required");
    // AuthKit verification runs independently here before selecting any native credential.
    app.addHook("preHandler", async (request, reply) => {
      const route = request.routeOptions.url;
      if (!route?.startsWith("/media/") && route !== "/properties/:propertyId/media/logo") return;
      if (
        route?.startsWith("/media/") &&
        route !== "/media/upload-sessions" &&
        route !== "/media/upload-sessions/:sessionId/finalize"
      )
        return reply.code(404).send({ code: "not_found" });
      const context = requireAuthContext(request);
      if (
        !context.actor.providerIdentity.sessionId ||
        context.selectedOrganization.kind !== "hotel_group" ||
        context.membership.roleKey !== "hotel_owner" ||
        !context.membership.permissions.includes("hotel_catalog.setup.manage")
      )
        throw new AuthorizationError();
    });
    app.register(registerPlatformMediaRoutes, { prefix: "/media", ...uploads, logoOnly: true });
    app.addHook("onClose", () => options.logoMedia!.assignments.close());
    app.register(registerPropertyMediaRoutes, {
      repository: options.logoMedia.assignments,
      logoOnly: true,
      propertyAccessRepository,
    });
  }
  if (options.currencyCommands)
    registerPmsPricingCurrencyCommand(app, options.currencyCommands, {
      requireOwnerSession: true,
      propertyAccessRepository,
    });
  if (options.propertyCreation)
    registerSharedHotelSetupPropertyCreation(app, options.propertyCreation, {
      requireOwnerSession: true,
    });
  if (options.launchSettings)
    registerSharedHotelSetupLaunchSettings(app, options.launchSettings.updateLaunchSettings, {
      requireOwnerSession: true,
      propertyAccessRepository,
    });
  if (options.profileEdit)
    registerHotelSetupPropertyProfileUpdate(app, options.profileEdit.updatePropertyProfile, {
      propertyAccessRepository,
    });
  if (options.featureHub)
    app.register(registerPmsModuleActivationRoutes, {
      repository: {
        list: options.featureHub.reads.list,
        close: options.featureHub.reads.close,
        updateFinancials: options.featureHub.commands.updateFinancials,
      },
      requireOwnerSession: true,
      financialsSetupComplete: options.featureHub.setupComplete,
      propertyAccessRepository,
    });
  return app;
}
