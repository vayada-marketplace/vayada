import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export const routeGroups = ["marketplace", "booking", "pms", "platform", "ai"] as const;

export type RouteGroup = (typeof routeGroups)[number];

export type RouteGroupPluginOptions = FastifyPluginOptions & {
  groups?: readonly RouteGroup[];
};

export type RouteGroupHealth = {
  group: RouteGroup;
  status: "ok";
};

export async function registerRouteGroupHealthRoutes(
  app: FastifyInstance,
  options: RouteGroupPluginOptions = {},
): Promise<void> {
  const groups = options.groups ?? routeGroups;

  for (const group of groups) {
    app.register(
      async (groupApp) => {
        groupApp.get(
          "/health",
          async (): Promise<RouteGroupHealth> => ({
            group,
            status: "ok",
          }),
        );
      },
      { prefix: `/${group}` },
    );
  }
}
