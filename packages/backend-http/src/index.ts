import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpErrorEnvelope<Code extends string = string, Category extends string = string> = {
  statusCode: number;
  code: Code;
  category: Category;
  message: string;
};

export type PaginationRequest = {
  limit?: number;
  offset?: number;
};

export type PageEnvelope<Item> = {
  items: readonly Item[];
  total: number;
  limit: number;
  offset: number;
};

export type IdempotencyMetadata = {
  idempotencyKey: string;
  requestId: string;
  correlationId?: string;
  fingerprint?: string;
};

export type HttpRouteContract<
  Request = unknown,
  Response = unknown,
  Error extends HttpErrorEnvelope = HttpErrorEnvelope,
> = {
  method: HttpMethod;
  path: string;
  request: Request;
  response: Response;
  error: Error;
};

export const routeGroups = ["marketplace", "booking", "pms", "platform", "ai"] as const;

export type RouteGroup = (typeof routeGroups)[number];

export type RouteGroupPluginOptions = FastifyPluginOptions & {
  groups?: readonly RouteGroup[];
};

export type RouteGroupHealth = {
  group: RouteGroup;
  status: "ok";
};

/** Registers placeholder health routes for the selected product route groups. */
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
