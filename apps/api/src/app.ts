import { backendAuthPlugin, type BackendAuthPluginOptions } from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  type RolePermissionRepository,
} from "@vayada/backend-authorization";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";

type ApiAuthOptions = Omit<BackendAuthPluginOptions, "authorizationResolver"> & {
  rolePermissionRepository: RolePermissionRepository;
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
    const { rolePermissionRepository, ...authOptions } = options.auth;
    app.register(backendAuthPlugin, {
      ...authOptions,
      authorizationResolver: createAuthorizationResolver(rolePermissionRepository),
    });
  }

  app.register(registerHealthRoutes);
  app.register(registerRouteGroups, { prefix: "/api" });

  return app;
}
