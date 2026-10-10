import type { FastifyInstance, FastifyReply } from "fastify";

export type HealthRouteOptions = {
  /** Resolves false while PostgreSQL is unreachable; unset keeps both routes static. */
  databaseHealth?: () => Promise<boolean>;
};

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions = {},
): Promise<void> {
  // The ALB checks /health. ECS replaces the task only after the target group's consecutive
  // failure threshold (3 checks 30s apart), so a short database blip recovers in place.
  const respond = async (reply: FastifyReply, status: "ok" | "ready") => {
    if (!options.databaseHealth || (await options.databaseHealth())) {
      return { service: "vayada-api", status };
    }
    return reply
      .code(503)
      .send({ service: "vayada-api", status: "unavailable", database: "unavailable" });
  };

  app.get("/health", async (_request, reply) => respond(reply, "ok"));
  app.get("/ready", async (_request, reply) => respond(reply, "ready"));
}
