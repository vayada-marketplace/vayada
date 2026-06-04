import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  type EntitlementRepository,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";

export type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
  entitlementRepository?: EntitlementRepository;
};

type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
  auth?: ApiAuthOptions;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  if (options.auth) {
    const { rolePermissionRepository, entitlementRepository, ...authOptions } = options.auth;
    app.register(backendAuthPlugin, {
      ...authOptions,
      authorizationResolver: createAuthorizationResolver(
        rolePermissionRepository,
        entitlementRepository,
      ),
    });
  }

  app.register(registerHealthRoutes);
  app.register(registerRouteGroups, { prefix: "/api" });

  return app;
}
