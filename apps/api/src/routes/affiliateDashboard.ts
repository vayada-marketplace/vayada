import {
  FINANCE_PAYOUT_STATUSES,
  FINANCE_ROUTE_CONTRACT_VERSION,
  FINANCE_ROUTE_PAYMENT_PROVIDERS,
  type FinanceAffiliatePayoutListResponse,
  type FinanceAffiliatePayoutSettingsPatchCommand,
  type FinanceAffiliatePayoutSettingsPatchPayload,
  type FinanceAffiliatePayoutSettingsReadModel,
  type FinanceAffiliatePayoutSettingsResponse,
  type FinanceJsonObject,
  type FinancePayoutListQuery,
  type FinancePropertyReadRepository,
} from "@vayada/domain-finance";
import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export const AFFILIATE_DASHBOARD_CONTRACT_VERSION = "affiliate-dashboard.v1" as const;

export type AffiliateDashboardContractVersion = typeof AFFILIATE_DASHBOARD_CONTRACT_VERSION;
export type AffiliateEarningsPeriod = "1m" | "3m" | "6m" | "12m";

export type AffiliateDashboardSummary = {
  affiliateId: string;
  currency: string;
  totalCommissionAmount: string;
  bookingCount: number;
  clickCount: number;
  conversionRate: number;
  propertyCount: number;
  outstandingBalanceAmount: string;
  sourceFreshness: FinanceJsonObject;
};

export type AffiliateDashboardProperty = {
  affiliateId: string;
  propertyId: string;
  displayName: string;
  slug: string;
  referralCode: string;
  commissionPercent: number;
  status: "active" | "pending" | "suspended";
  metrics: {
    bookingCount: number;
    clickCount: number;
    conversionRate: number;
    totalRevenueAmount: string;
    totalCommissionAmount: string;
  };
};

export type AffiliateEarningsBucket = {
  bucketStart: string;
  label: string;
  commissionAmount: string;
};

export type AffiliateActivity = {
  activityType: "click" | "booking" | "signup";
  occurredAt: string;
  propertyName: string;
  count: number;
};

export type AffiliateDashboardSummaryResponse = {
  contractVersion: AffiliateDashboardContractVersion;
  affiliateId: string;
  summary: Omit<AffiliateDashboardSummary, "affiliateId">;
};

export type AffiliateDashboardPropertiesResponse = {
  contractVersion: AffiliateDashboardContractVersion;
  affiliateId: string;
  properties: AffiliateDashboardProperty[];
};

export type AffiliateDashboardEarningsResponse = {
  contractVersion: AffiliateDashboardContractVersion;
  affiliateId: string;
  period: AffiliateEarningsPeriod;
  currency: string;
  buckets: AffiliateEarningsBucket[];
  sourceFreshness: FinanceJsonObject;
};

export type AffiliateDashboardActivityResponse = {
  contractVersion: AffiliateDashboardContractVersion;
  affiliateId: string;
  activities: AffiliateActivity[];
};

export type AffiliateDashboardMeResponse = {
  contractVersion: AffiliateDashboardContractVersion;
  affiliate: {
    affiliateId: string;
    organizationId: string;
    userId: string;
    email: string;
    currency: string;
    status: "active";
  };
};

export type AffiliateDashboardReadRepository = {
  getSummary(
    affiliateId: string,
    context: RequestContext,
  ): Promise<AffiliateDashboardSummary | null>;
  listProperties(
    affiliateId: string,
    context: RequestContext,
  ): Promise<AffiliateDashboardProperty[] | null>;
  listEarnings(
    affiliateId: string,
    period: AffiliateEarningsPeriod,
    context: RequestContext,
  ): Promise<{
    currency: string;
    buckets: AffiliateEarningsBucket[];
    sourceFreshness: FinanceJsonObject;
  } | null>;
  listActivity(
    affiliateId: string,
    query: { limit: number },
    context: RequestContext,
  ): Promise<AffiliateActivity[] | null>;
};

export type AffiliateDashboardRoutesOptions = {
  repository?: Partial<AffiliateDashboardReadRepository>;
  financeRepository?: FinancePropertyReadRepository;
};

type AffiliateRouteContext = {
  context: RequestContext;
  affiliateId: string;
};

type AffiliateRouteError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500 | 501;
  code:
    | "unauthenticated"
    | "missing_affiliate_context"
    | "missing_affiliate_payout_access"
    | "invalid_query"
    | "invalid_body"
    | "affiliate_not_found"
    | "read_model_unavailable"
    | "invalid_command"
    | "idempotency_conflict"
    | "write_unavailable";
  category:
    | "authentication"
    | "authorization"
    | "validation"
    | "not_found"
    | "target_contract"
    | "write_model";
  message: string;
  followUpIssues?: string[];
};

type AffiliatePayoutSettingsPatchBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  payoutsEnabled?: unknown;
  payoutProvider?: unknown;
  payoutCurrency?: unknown;
  payoutSchedule?: unknown;
  payoutThresholdAmount?: unknown;
};

export async function registerAffiliateDashboardRoutes(
  app: FastifyInstance,
  options: AffiliateDashboardRoutesOptions,
) {
  app.get("/affiliate/me", async (request, reply) => {
    const resolved = requireAffiliateRouteContext(request, reply);
    if (!resolved) return reply;

    return {
      contractVersion: AFFILIATE_DASHBOARD_CONTRACT_VERSION,
      affiliate: {
        affiliateId: resolved.affiliateId,
        organizationId: resolved.context.selectedOrganization.organizationId,
        userId: resolved.context.actor.internalUserId,
        email: resolved.context.actor.email,
        currency: resolved.context.currency,
        status: "active",
      },
    } satisfies AffiliateDashboardMeResponse;
  });

  app.get("/affiliate/dashboard", async (request, reply) => {
    const resolved = requireAffiliateRouteContext(request, reply);
    if (!resolved) return reply;

    if (!options.repository?.getSummary) {
      return sendRouteError(reply, targetReadUnavailable("affiliate dashboard summary"));
    }

    const summary = await options.repository.getSummary(resolved.affiliateId, resolved.context);
    if (!summary) {
      return sendRouteError(reply, affiliateNotFound());
    }

    const { affiliateId: _affiliateId, ...body } = summary;
    return {
      contractVersion: AFFILIATE_DASHBOARD_CONTRACT_VERSION,
      affiliateId: resolved.affiliateId,
      summary: body,
    } satisfies AffiliateDashboardSummaryResponse;
  });

  app.get("/affiliate/properties", async (request, reply) => {
    const resolved = requireAffiliateRouteContext(request, reply);
    if (!resolved) return reply;

    if (!options.repository?.listProperties) {
      return sendRouteError(reply, targetReadUnavailable("affiliate property read model"));
    }

    const properties = await options.repository.listProperties(
      resolved.affiliateId,
      resolved.context,
    );
    if (!properties) {
      return sendRouteError(reply, affiliateNotFound());
    }

    return {
      contractVersion: AFFILIATE_DASHBOARD_CONTRACT_VERSION,
      affiliateId: resolved.affiliateId,
      properties,
    } satisfies AffiliateDashboardPropertiesResponse;
  });

  app.get("/affiliate/earnings", async (request, reply) => {
    const resolved = requireAffiliateRouteContext(request, reply);
    if (!resolved) return reply;

    const period = parseEarningsPeriod(request.query);
    if (isAffiliateRouteError(period)) {
      return sendRouteError(reply, period);
    }

    if (!options.repository?.listEarnings) {
      return sendRouteError(reply, targetReadUnavailable("affiliate earnings read model"));
    }

    const result = await options.repository.listEarnings(
      resolved.affiliateId,
      period,
      resolved.context,
    );
    if (!result) {
      return sendRouteError(reply, affiliateNotFound());
    }

    return {
      contractVersion: AFFILIATE_DASHBOARD_CONTRACT_VERSION,
      affiliateId: resolved.affiliateId,
      period,
      currency: result.currency,
      buckets: result.buckets,
      sourceFreshness: result.sourceFreshness,
    } satisfies AffiliateDashboardEarningsResponse;
  });

  app.get("/affiliate/activity", async (request, reply) => {
    const resolved = requireAffiliateRouteContext(request, reply);
    if (!resolved) return reply;

    const query = parseActivityQuery(request.query);
    if (isAffiliateRouteError(query)) {
      return sendRouteError(reply, query);
    }

    if (!options.repository?.listActivity) {
      return sendRouteError(reply, targetReadUnavailable("affiliate activity read model"));
    }

    const activities = await options.repository.listActivity(
      resolved.affiliateId,
      query,
      resolved.context,
    );
    if (!activities) {
      return sendRouteError(reply, affiliateNotFound());
    }

    return {
      contractVersion: AFFILIATE_DASHBOARD_CONTRACT_VERSION,
      affiliateId: resolved.affiliateId,
      activities,
    } satisfies AffiliateDashboardActivityResponse;
  });

  app.get("/affiliate/payout-settings", async (request, reply) => {
    const resolved = enforceAffiliatePayoutPolicy(request, reply);
    if (!resolved) return reply;

    if (!options.financeRepository?.getAffiliatePayoutSettings) {
      return sendRouteError(reply, financeReadUnavailable("affiliate payout settings"));
    }

    const settings = await options.financeRepository.getAffiliatePayoutSettings(
      resolved.affiliateId,
    );
    if (!settings) {
      return sendRouteError(reply, affiliateNotFound());
    }

    return toAffiliatePayoutSettingsResponse(settings);
  });

  app.patch<{ Body: AffiliatePayoutSettingsPatchBody }>(
    "/affiliate/payout-settings",
    async (request, reply) => {
      const resolved = enforceAffiliatePayoutPolicy(request, reply);
      if (!resolved) return reply;

      if (!options.financeRepository?.updateAffiliatePayoutSettings) {
        return sendRouteError(reply, financeWriteUnavailable("affiliate payout settings"));
      }

      const command = toAffiliatePayoutSettingsPatchCommand(request, resolved.affiliateId);
      if (isAffiliateRouteError(command)) {
        return sendRouteError(reply, command);
      }

      const result = await options.financeRepository.updateAffiliatePayoutSettings(command);
      if (!result.ok) {
        return sendRouteError(reply, {
          statusCode: result.statusCode,
          code: result.code,
          category: result.statusCode === 404 ? "not_found" : "write_model",
          message: result.message,
        });
      }

      return {
        ...toAffiliatePayoutSettingsResponse(result.settings),
        commandMeta: result.commandMeta,
      };
    },
  );

  app.get("/affiliate/payouts", async (request, reply) => {
    const resolved = enforceAffiliatePayoutPolicy(request, reply);
    if (!resolved) return reply;

    if (!options.financeRepository?.listAffiliatePayouts) {
      return sendRouteError(reply, financeReadUnavailable("affiliate payouts"));
    }

    const query = parsePayoutListQuery(request.query);
    if (isAffiliateRouteError(query)) {
      return sendRouteError(reply, query);
    }

    const result = await options.financeRepository.listAffiliatePayouts(
      resolved.affiliateId,
      query,
    );
    if (!result) {
      return sendRouteError(reply, affiliateNotFound());
    }

    return {
      contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
      affiliateId: resolved.affiliateId,
      ...result,
    } satisfies FinanceAffiliatePayoutListResponse;
  });

  app.post("/affiliate/xendit/validate-bank-account", async (request, reply) => {
    const resolved = enforceAffiliatePayoutPolicy(request, reply);
    if (!resolved) return reply;

    return sendRouteError(reply, {
      statusCode: 501,
      code: "read_model_unavailable",
      category: "target_contract",
      message:
        "Affiliate Xendit bank validation is not available in the target finance contract yet.",
      followUpIssues: ["VAY-795"],
    });
  });
}

function requireAffiliateRouteContext(
  request: FastifyRequest,
  reply: FastifyReply,
): AffiliateRouteContext | null {
  let context: RequestContext;
  try {
    context = requireAuthContext(request);
  } catch (error) {
    if (isStatusError(error) && error.statusCode === 401) {
      sendRouteError(reply, {
        statusCode: 401,
        code: "unauthenticated",
        category: "authentication",
        message: "A valid access token is required.",
      });
      return null;
    }
    throw error;
  }

  if (context.selectedOrganization.kind !== "affiliate_partner") {
    sendRouteError(reply, {
      statusCode: 403,
      code: "missing_affiliate_context",
      category: "authorization",
      message: "An affiliate partner organization is required.",
    });
    return null;
  }

  const affiliateResource = context.linkedResources.find(
    (resource) =>
      resource.product === "affiliate" &&
      resource.resourceType === "affiliate" &&
      resource.status === "active" &&
      (resource.relationship === "owner" || resource.relationship === "finance_manager"),
  );

  if (!affiliateResource) {
    sendRouteError(reply, {
      statusCode: 403,
      code: "missing_affiliate_context",
      category: "authorization",
      message: "Missing active affiliate resource access.",
    });
    return null;
  }

  return { context, affiliateId: affiliateResource.resourceId };
}

function enforceAffiliatePayoutPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
): AffiliateRouteContext | null {
  const resolved = requireAffiliateRouteContext(request, reply);
  if (!resolved) return null;

  try {
    enforceRoutePolicy(request, {
      permission: "affiliate.payout.manage",
      entitlement: {
        product: "affiliate",
        key: "affiliate-payouts",
        resource: {
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: resolved.affiliateId,
        },
      },
      resource: {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: resolved.affiliateId,
        allowedRelationships: ["owner", "finance_manager"],
      },
    });
    return resolved;
  } catch (error) {
    if (!isStatusError(error)) throw error;
    sendRouteError(reply, {
      statusCode: error.statusCode === 401 ? 401 : 403,
      code: error.statusCode === 401 ? "unauthenticated" : "missing_affiliate_payout_access",
      category: error.statusCode === 401 ? "authentication" : "authorization",
      message:
        error.statusCode === 401
          ? "A valid access token is required."
          : "Missing required affiliate payout permission, entitlement, or resource access.",
    });
    return null;
  }
}

function toAffiliatePayoutSettingsResponse(
  settings: FinanceAffiliatePayoutSettingsReadModel,
): FinanceAffiliatePayoutSettingsResponse {
  const {
    affiliateId,
    marketplaceOrganizationId,
    updatedAt: _updatedAt,
    ...payoutSettings
  } = settings;
  return {
    contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
    affiliateId,
    marketplaceOrganizationId,
    payoutSettings,
  };
}

function toAffiliatePayoutSettingsPatchCommand(
  request: FastifyRequest<{ Body: AffiliatePayoutSettingsPatchBody }>,
  affiliateId: string,
): FinanceAffiliatePayoutSettingsPatchCommand | AffiliateRouteError {
  const body = request.body ?? {};
  const commandId = nonEmptyString(body.commandId);
  const idempotencyKey = nonEmptyString(body.idempotencyKey);

  if (!commandId || !idempotencyKey) {
    return invalidBody("Affiliate payout settings updates require commandId and idempotencyKey.");
  }

  const payload: FinanceAffiliatePayoutSettingsPatchPayload = {};
  if (body.payoutsEnabled !== undefined) {
    if (typeof body.payoutsEnabled !== "boolean") {
      return invalidBody("payoutsEnabled must be a boolean.");
    }
    payload.payoutsEnabled = body.payoutsEnabled;
  }

  if (body.payoutProvider !== undefined) {
    if (
      body.payoutProvider !== "stripe" &&
      body.payoutProvider !== "bank_transfer" &&
      body.payoutProvider !== "manual"
    ) {
      return invalidBody("payoutProvider must be stripe, bank_transfer, or manual.");
    }
    payload.payoutProvider = body.payoutProvider;
  }

  if (body.payoutCurrency !== undefined) {
    const currency = nonEmptyString(body.payoutCurrency)?.toUpperCase();
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      return invalidBody("payoutCurrency must be a three-letter ISO currency code.");
    }
    payload.payoutCurrency = currency;
  }

  if (body.payoutSchedule !== undefined) {
    if (
      body.payoutSchedule !== "manual" &&
      body.payoutSchedule !== "monthly" &&
      body.payoutSchedule !== "threshold"
    ) {
      return invalidBody("payoutSchedule must be manual, monthly, or threshold.");
    }
    payload.payoutSchedule = body.payoutSchedule;
  }

  if (body.payoutThresholdAmount !== undefined) {
    if (body.payoutThresholdAmount === null || body.payoutThresholdAmount === "") {
      payload.payoutThresholdAmount = null;
    } else {
      const amount = nonEmptyString(body.payoutThresholdAmount);
      if (!amount || !/^\d+(\.\d{1,2})?$/.test(amount)) {
        return invalidBody("payoutThresholdAmount must be a decimal amount or null.");
      }
      payload.payoutThresholdAmount = amount;
    }
  }

  if (Object.keys(payload).length === 0) {
    return invalidBody("At least one payout setting field is required.");
  }

  return {
    commandType: "finance.affiliate_payout_settings.update",
    commandId,
    idempotencyKey,
    affiliateId,
    audit: financeCommandAudit(request, "Update affiliate payout settings"),
    payload,
  };
}

function parseEarningsPeriod(query: unknown): AffiliateEarningsPeriod | AffiliateRouteError {
  const period =
    query && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>).period
      : undefined;
  if (period === undefined) return "6m";
  if (period === "1m" || period === "3m" || period === "6m" || period === "12m") return period;
  return invalidQuery("period must be one of 1m, 3m, 6m, or 12m.");
}

function parseActivityQuery(query: unknown): { limit: number } | AffiliateRouteError {
  const limit = numberQueryValue(query, "limit", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return invalidQuery("limit must be an integer from 1 to 100.");
  }
  return { limit };
}

function parsePayoutListQuery(query: unknown): FinancePayoutListQuery | AffiliateRouteError {
  const limit = numberQueryValue(query, "limit", 50);
  const offset = numberQueryValue(query, "offset", 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return invalidQuery("limit must be an integer from 1 to 500.");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return invalidQuery("offset must be a non-negative integer.");
  }

  const status = stringQueryValue(query, "status");
  if (
    status &&
    !FINANCE_PAYOUT_STATUSES.includes(status as (typeof FINANCE_PAYOUT_STATUSES)[number])
  ) {
    return invalidQuery("status is not a supported payout status.");
  }

  const provider = stringQueryValue(query, "provider");
  if (
    provider &&
    !FINANCE_ROUTE_PAYMENT_PROVIDERS.includes(
      provider as (typeof FINANCE_ROUTE_PAYMENT_PROVIDERS)[number],
    )
  ) {
    return invalidQuery("provider is not a supported payment provider.");
  }

  return {
    limit,
    offset,
    ...(status && { status: status as FinancePayoutListQuery["status"] }),
    ...(provider && { provider: provider as FinancePayoutListQuery["provider"] }),
  };
}

function financeCommandAudit(request: FastifyRequest, reason: string) {
  const now = new Date().toISOString();
  const authContext = request.authContext;
  return {
    actor: authContext
      ? {
          kind: "user" as const,
          userId: authContext.actor.internalUserId,
          organizationId: authContext.selectedOrganization.organizationId,
        }
      : { kind: "system" as const, service: "apps/api" },
    requestId: authContext?.audit.requestId ?? `req_${Date.now()}`,
    correlationId: authContext?.audit.correlationId,
    reason,
    requestedAt: authContext?.audit.receivedAt ?? now,
  };
}

function numberQueryValue(query: unknown, key: string, fallback: number): number {
  const value =
    query && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>)[key]
      : undefined;
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return Number.NaN;
}

function stringQueryValue(query: unknown, key: string): string | undefined {
  const value =
    query && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function invalidQuery(message: string): AffiliateRouteError {
  return {
    statusCode: 400,
    code: "invalid_query",
    category: "validation",
    message,
  };
}

function invalidBody(message: string): AffiliateRouteError {
  return {
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  };
}

function affiliateNotFound(): AffiliateRouteError {
  return {
    statusCode: 404,
    code: "affiliate_not_found",
    category: "not_found",
    message: "Affiliate target resource was not found.",
  };
}

function targetReadUnavailable(readModel: string): AffiliateRouteError {
  return {
    statusCode: 501,
    code: "read_model_unavailable",
    category: "target_contract",
    message: `Target ${readModel} is not configured.`,
  };
}

function financeReadUnavailable(readModel: string): AffiliateRouteError {
  return {
    statusCode: 501,
    code: "read_model_unavailable",
    category: "target_contract",
    message: `Finance ${readModel} read model is not configured.`,
    followUpIssues: ["VAY-795"],
  };
}

function financeWriteUnavailable(readModel: string): AffiliateRouteError {
  return {
    statusCode: 501,
    code: "write_unavailable",
    category: "write_model",
    message: `Finance ${readModel} writes are not configured.`,
    followUpIssues: ["VAY-795"],
  };
}

function sendRouteError(reply: FastifyReply, error: AffiliateRouteError) {
  reply.code(error.statusCode);
  return error;
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function isAffiliateRouteError(value: unknown): value is AffiliateRouteError {
  return (
    typeof value === "object" &&
    value !== null &&
    "statusCode" in value &&
    typeof (value as { statusCode?: unknown }).statusCode === "number"
  );
}
