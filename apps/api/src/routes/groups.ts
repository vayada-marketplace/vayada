import type { FastifyInstance } from "fastify";

const routeGroups = ["marketplace", "booking", "pms", "platform", "ai"] as const;

export async function registerRouteGroups(app: FastifyInstance): Promise<void> {
  for (const group of routeGroups) {
    app.register(
      async (groupApp) => {
        groupApp.get("/health", async () => ({
          group,
          status: "ok",
        }));
      },
      { prefix: `/${group}` },
    );
  }
}
