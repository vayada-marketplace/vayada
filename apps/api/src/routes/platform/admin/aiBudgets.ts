import type { PermissionKey } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { MAX_MONTHLY_LIMIT_MICRO_USD, type AiBudgetAdmin } from "../../../ai/usage/budgetAdmin.js";
import { usdToMicroUsd } from "../../../ai/usage/budgetGate.js";
import { enforceRoutePolicy } from "../../policy.js";

export type PlatformAiBudgetRoutesOptions = { admin: AiBudgetAdmin };

const PLATFORM_RESOURCE = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  allowedRelationships: ["operator"],
} as const;
/** The platform admin write permission, as for invite codes and hotel media. */
const MANAGE: PermissionKey = "platform.user.suspend";
const READ: PermissionKey = "platform.admin.read";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * vayada staff see each hotel account's AI use this month and set its monthly AI budget
 * (VAY-2504). Only staff: hotel owners can not raise their own, and /api/platform/admin is on the
 * AI never-list, so no AI can either.
 */
export async function registerPlatformAiBudgetRoutes(
  app: FastifyInstance,
  options: PlatformAiBudgetRoutesOptions,
): Promise<void> {
  app.get("/ai-budgets", async (request, reply) => {
    authorize(request, READ);
    reply.header("Cache-Control", "private, no-store");
    return options.admin.overview();
  });

  app.put("/ai-budgets/:organizationId", async (request, reply) => {
    const context = authorize(request, MANAGE);
    const organizationId = record(request.params)?.["organizationId"];
    if (typeof organizationId !== "string" || !UUID_PATTERN.test(organizationId))
      return reply
        .status(400)
        .send({ code: "invalid_organization_id", detail: "Organization ID must be a UUID." });
    const body = record(request.body);
    const reason = typeof body?.["reason"] === "string" ? body["reason"].trim() : "";
    const limit = body?.["monthlyLimitUsd"];
    const monthlyLimitMicroUsd =
      limit === null ? null : typeof limit === "string" ? usdToMicroUsd(limit.trim()) : undefined;
    if (
      !reason ||
      reason.length > 500 ||
      monthlyLimitMicroUsd === undefined ||
      (limit !== null && monthlyLimitMicroUsd === null) ||
      (monthlyLimitMicroUsd !== null && monthlyLimitMicroUsd > MAX_MONTHLY_LIMIT_MICRO_USD)
    )
      return reply.status(400).send({
        code: "invalid_ai_budget",
        detail:
          'Provide a reason and monthlyLimitUsd as dollars up to 100000 (e.g. "25" or "12.50"), or null for the default.',
      });
    const account = await options.admin.setBudget({
      organizationId: organizationId.toLowerCase(),
      monthlyLimitMicroUsd,
      reason,
      audit: {
        actorUserId: context.actor.internalUserId,
        requestId: context.audit.requestId,
        correlationId: context.audit.correlationId ?? context.audit.requestId,
        requestedAt: context.audit.receivedAt,
      },
    });
    if (!account) return reply.status(404).send({ code: "hotel_account_not_found" });
    return account;
  });
}

/** vayada staff only: the permission, the Vayada operator resource and vayada's own organization. */
function authorize(request: FastifyRequest, permission: PermissionKey) {
  const context = enforceRoutePolicy(request, { permission, resource: PLATFORM_RESOURCE });
  if (
    context.selectedOrganization.kind !== "platform" ||
    context.selectedOrganization.status !== "active"
  )
    throw Object.assign(new Error("vayada staff access is required."), { statusCode: 403 });
  return context;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
