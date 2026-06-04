import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { registerRouteGroups } from "./routes/groups.js";
import { registerHealthRoutes } from "./routes/health.js";

type BuildAppOptions = Pick<FastifyServerOptions, "logger">;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  app.register(registerHealthRoutes);
  app.register(registerRouteGroups, { prefix: "/api" });

  return app;
}
