import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    service: "vayada-api",
    status: "ok",
  }));

  app.get("/ready", async () => ({
    service: "vayada-api",
    status: "ready",
  }));
}
