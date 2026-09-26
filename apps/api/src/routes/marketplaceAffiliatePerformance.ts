import { requireAuthContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  AffiliatePerformanceQuery,
  AffiliatePerformanceReadModel,
} from "../domains/affiliatePerformanceReadModel.js";
import { affiliatePerformanceCursorPeriod } from "../domains/affiliatePerformanceReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export const AFFILIATE_PERFORMANCE_CONTRACT_VERSION = "affiliate-performance.v1" as const;
const periods = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 } as const;
const sources = ["instagram", "tiktok", "youtube", "facebook", "x", "unknown"] as const;

export type MarketplaceAffiliatePerformanceRoutesOptions = {
  repository?: AffiliatePerformanceReadModel;
  now?: () => Date;
};

export async function registerMarketplaceAffiliatePerformanceRoutes(
  app: FastifyInstance,
  options: MarketplaceAffiliatePerformanceRoutesOptions,
) {
  app.get("/affiliate-performance", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!options.repository) return error(reply, 503, "read_model_unavailable");
    try {
      const parsed = parseQuery(request.query, options.now?.() ?? new Date());
      if (typeof parsed === "string") return error(reply, 400, parsed);
      const context = requireAuthContext(request);
      const creator = context.selectedOrganization.kind === "creator_workspace";
      const resourceId = creator
        ? singleCreatorResource(context)
        : context.selectedOrganization.kind === "hotel_group"
          ? parsed.propertyId
          : undefined;
      if (!resourceId) return error(reply, 403, "scope_unavailable");
      enforceRoutePolicy(request, {
        permission: "marketplace.collaboration.read",
        resource: {
          product: "marketplace",
          resourceType: creator ? "creator_profile" : "hotel_profile",
          resourceId,
          allowedRelationships: creator ? ["owner"] : ["owner", "operator"],
        },
        ...(creator
          ? {}
          : {
              entitlement: {
                product: "marketplace" as const,
                key: "marketplace-hotel-profile",
                resource: {
                  product: "marketplace" as const,
                  resourceType: "hotel_profile" as const,
                  resourceId,
                },
              },
            }),
      });
      return {
        contractVersion: AFFILIATE_PERFORMANCE_CONTRACT_VERSION,
        ...(await options.repository.read(context, parsed)),
      };
    } catch (caught) {
      if (caught instanceof Error && caught.message === "invalid affiliate performance cursor")
        return error(reply, 400, "invalid_cursor");
      if (hasStatus(caught))
        return error(reply, caught.statusCode === 401 ? 401 : 403, "scope_unavailable");
      if (caught instanceof Error && caught.message === "affiliate performance scope unavailable")
        return error(reply, 403, "scope_unavailable");
      throw caught;
    }
  });
  if (options.repository?.close) app.addHook("onClose", () => options.repository!.close!());
}

function parseQuery(value: unknown, now: Date): AffiliatePerformanceQuery | string {
  const query =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const period = typeof query["period"] === "string" ? query["period"] : "3m";
  if (!(period in periods)) return "invalid_period";
  const source = query["source"];
  if (
    source !== undefined &&
    (!sources.includes(source as (typeof sources)[number]) || typeof source !== "string")
  )
    return "invalid_source";
  const campaign = optional(query["campaign"]);
  if (campaign && !/^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(campaign))
    return "invalid_campaign";
  const propertyId = optional(query["propertyId"]);
  if (propertyId && !uuid(propertyId)) return "invalid_property";
  const limit = query["limit"] === undefined ? 25 : Number(query["limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return "invalid_limit";
  const cursor = optional(query["cursor"]);
  const cursorPeriod = cursor ? affiliatePerformanceCursorPeriod(cursor) : null;
  const to = cursorPeriod ? new Date(cursorPeriod.to) : new Date(now);
  const from = cursorPeriod
    ? new Date(cursorPeriod.from)
    : subtractUtcMonths(to, periods[period as keyof typeof periods]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    limit,
    ...(propertyId && { propertyId }),
    ...(source && { source: source as AffiliatePerformanceQuery["source"] }),
    ...(campaign && { campaign }),
    ...(cursor && { cursor }),
  };
}

function subtractUtcMonths(value: Date, months: number) {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function singleCreatorResource(context: ReturnType<typeof requireAuthContext>) {
  const resources = context.linkedResources.filter(
    (resource) =>
      resource.product === "marketplace" &&
      resource.resourceType === "creator_profile" &&
      resource.relationship === "owner" &&
      resource.status === "active",
  );
  return resources.length === 1 ? resources[0]!.resourceId : undefined;
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function error(reply: FastifyReply, statusCode: number, code: string) {
  return reply.code(statusCode).send({ code });
}
function hasStatus(value: unknown): value is Error & { statusCode: number } {
  return (
    value instanceof Error &&
    "statusCode" in value &&
    typeof (value as { statusCode?: unknown }).statusCode === "number"
  );
}
