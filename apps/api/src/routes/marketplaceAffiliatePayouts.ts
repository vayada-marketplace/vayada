import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import {
  FINANCE_ROUTE_CONTRACT_VERSION,
  type FinanceAffiliatePayoutSettingsPatchCommand,
  type FinancePropertyReadRepository,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type Body = Record<string, unknown>;

export async function registerMarketplaceAffiliatePayoutRoutes(
  app: FastifyInstance,
  options: { repository?: FinancePropertyReadRepository },
) {
  app.get("/affiliate-payouts", async (request, reply) => {
    const scope = creatorPayoutScope(request, reply, "read");
    if (!scope) return reply;
    const query = pageQuery(request.query);
    if (!query) return error(reply, 400, "invalid_query");
    const settings = await options.repository?.getAffiliatePayoutSettings?.(
      scope.affiliateId,
      scope.organizationId,
    );
    const payouts = await options.repository?.listAffiliatePayouts?.(
      scope.affiliateId,
      query,
      scope.organizationId,
    );
    if (!settings || !payouts) return error(reply, 404, "payout_scope_not_found");
    reply.header("Cache-Control", "private, no-store");
    return {
      contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
      affiliateId: scope.affiliateId,
      payoutSettings: {
        payoutsEnabled: settings.payoutsEnabled,
        payoutProvider: settings.payoutProvider,
        payoutCurrency: settings.payoutCurrency,
        payoutSchedule: settings.payoutSchedule,
        payoutThresholdAmount: settings.payoutThresholdAmount,
        providerAccount: {
          status: settings.providerAccount.status,
          onboardingStatus: settings.providerAccount.onboardingStatus,
          payoutsEnabled: settings.providerAccount.payoutsEnabled,
          maskedReference: mask(settings.providerAccount.providerAccountId),
        },
      },
      ...payouts,
      payouts: payouts.payouts.map((payout) => ({
        ...payout,
        guestBookingId: null,
        paymentId: null,
        providerPayoutId: null,
      })),
    };
  });

  app.get<{ Params: { payoutId: string } }>(
    "/affiliate-payouts/:payoutId",
    async (request, reply) => {
      const scope = creatorPayoutScope(request, reply, "read");
      if (!scope) return reply;
      const currency = queryCurrency(request.query);
      if (!currency || !uuid(request.params.payoutId)) return error(reply, 400, "invalid_query");
      const payout = await options.repository?.getAffiliatePayoutDetail?.(
        scope.affiliateId,
        scope.organizationId,
        request.params.payoutId,
        currency,
      );
      if (!payout) return error(reply, 404, "payout_not_found");
      reply.header("Cache-Control", "private, no-store");
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        affiliateId: scope.affiliateId,
        payout: {
          ...payout,
          guestBookingId: null,
          paymentId: null,
          providerPayoutId: null,
        },
      };
    },
  );

  app.get<{ Params: { payoutId: string } }>(
    "/affiliate-payouts/:payoutId/statement",
    async (request, reply) => {
      const scope = creatorPayoutScope(request, reply, "read");
      if (!scope) return reply;
      const currency = queryCurrency(request.query);
      if (!currency || !uuid(request.params.payoutId)) return error(reply, 400, "invalid_query");
      const payout = await options.repository?.getAffiliatePayoutDetail?.(
        scope.affiliateId,
        scope.organizationId,
        request.params.payoutId,
        currency,
      );
      if (!payout) return error(reply, 404, "payout_not_found");
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="payout-${payout.payoutId}.csv"`);
      return csv(payout);
    },
  );

  app.patch<{ Body: Body }>("/affiliate-payouts/settings", async (request, reply) => {
    const scope = creatorPayoutScope(request, reply, "write");
    if (!scope) return reply;
    const command = settingsCommand(request, scope);
    if (!command) return error(reply, 400, "invalid_body");
    const result = await options.repository?.updateAffiliatePayoutSettings?.(command);
    if (!result) return error(reply, 503, "write_unavailable");
    if (!result.ok) return error(reply, result.statusCode, result.code);
    return { status: result.status, commandMeta: result.commandMeta };
  });

  app.post<{ Body: Body }>("/affiliate-payouts/stripe", async (request, reply) => {
    const scope = creatorPayoutScope(request, reply, "write");
    if (!scope) return reply;
    const commandId = string(request.body?.commandId);
    const idempotencyKey = string(request.body?.idempotencyKey);
    const country = string(request.body?.country)?.toUpperCase();
    if (!commandId || !idempotencyKey || !country || !/^[A-Z]{2}$/.test(country))
      return error(reply, 400, "invalid_body");
    const result = await options.repository?.createStripeProviderAccount?.({
      commandType: "finance.provider_account.stripe.create",
      commandId,
      idempotencyKey,
      affiliateId: scope.affiliateId,
      organizationId: scope.organizationId,
      audit: audit(request, scope.context, "Start creator payout onboarding"),
      payload: {
        email: scope.context.actor.email,
        country,
        returnSurface: "marketplace",
      },
    });
    if (!result) return error(reply, 503, "write_unavailable");
    if (!result.ok) return error(reply, result.statusCode, result.code);
    return {
      status: result.status,
      onboardingUrl: result.response.onboardingUrl,
      providerAccount: {
        status: result.response.status,
        onboardingStatus: result.response.onboardingStatus,
        maskedReference: mask(result.response.providerAccountRef),
      },
    };
  });
}

function creatorPayoutScope(
  request: FastifyRequest,
  reply: FastifyReply,
  access: "read" | "write",
) {
  try {
    const context = requireAuthContext(request);
    if (context.selectedOrganization.kind !== "creator_workspace") throw new Error("scope");
    const creator = context.linkedResources.filter(
      (item) =>
        item.product === "marketplace" &&
        item.resourceType === "creator_profile" &&
        item.relationship === "owner" &&
        item.status === "active",
    );
    const affiliate = context.linkedResources.filter(
      (item) =>
        item.product === "affiliate" &&
        item.resourceType === "affiliate" &&
        item.relationship === "owner" &&
        item.status === "active",
    );
    if (creator.length !== 1 || affiliate.length !== 1) throw new Error("scope");
    enforceRoutePolicy(request, {
      permission:
        access === "read" ? "marketplace.collaboration.read" : "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creator[0]!.resourceId,
        allowedRelationships: ["owner"],
      },
    });
    return {
      context,
      organizationId: context.selectedOrganization.organizationId,
      affiliateId: affiliate[0]!.resourceId,
    };
  } catch (caught) {
    const status = hasStatus(caught) && caught.statusCode === 401 ? 401 : 403;
    error(reply, status, status === 401 ? "unauthenticated" : "scope_unavailable");
    return null;
  }
}

function settingsCommand(
  request: FastifyRequest<{ Body: Body }>,
  scope: NonNullable<ReturnType<typeof creatorPayoutScope>>,
): FinanceAffiliatePayoutSettingsPatchCommand | null {
  const body = request.body ?? {};
  const commandId = string(body.commandId);
  const idempotencyKey = string(body.idempotencyKey);
  const provider = body.payoutProvider;
  const schedule = body.payoutSchedule;
  const currency = string(body.payoutCurrency)?.toUpperCase();
  const threshold = body.payoutThresholdAmount;
  if (
    !commandId ||
    !idempotencyKey ||
    !["stripe", "manual", "bank_transfer"].includes(String(provider)) ||
    !["manual", "monthly", "threshold"].includes(String(schedule)) ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency) ||
    (threshold !== null && (typeof threshold !== "string" || !/^\d+(\.\d{1,2})?$/.test(threshold)))
  )
    return null;
  return {
    commandType: "finance.affiliate_payout_settings.update",
    commandId,
    idempotencyKey,
    affiliateId: scope.affiliateId,
    audit: audit(request, scope.context, "Update creator payout settings"),
    payload: {
      payoutsEnabled: true,
      payoutProvider: provider as "stripe" | "manual" | "bank_transfer",
      payoutCurrency: currency,
      payoutSchedule: schedule as "manual" | "monthly" | "threshold",
      payoutThresholdAmount: threshold as string | null,
    },
  };
}

function csv(
  payout: NonNullable<
    Awaited<ReturnType<NonNullable<FinancePropertyReadRepository["getAffiliatePayoutDetail"]>>>
  >,
) {
  const rows = [
    ["payout_id", "status", "currency", "gross", "fee", "net", "paid_at", "provider_reference"],
    [
      payout.payoutId,
      payout.payoutStatus,
      payout.currency,
      payout.amount,
      payout.feeAmount,
      payout.netAmount,
      payout.paidAt ?? "",
      payout.maskedProviderReference ?? "",
    ],
    [],
    [
      "earning_entry_id",
      "property_id",
      "booking_reference",
      "agreement_id",
      "recorded_at",
      "currency",
      "commission_minor",
      "adjustment_minor",
      "applied_minor",
    ],
    ...payout.includedEarnings.map((item) => [
      item.earningEntryId,
      item.propertyId,
      item.bookingReference,
      item.agreementId,
      item.recordedAt,
      item.currency,
      item.commissionMinor,
      item.adjustmentMinor,
      item.appliedMinor,
    ]),
  ];
  return `${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n")}\r\n`;
}

function pageQuery(value: unknown) {
  const query = value && typeof value === "object" ? (value as Body) : {};
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  return Number.isInteger(limit) &&
    limit > 0 &&
    limit <= 100 &&
    Number.isInteger(offset) &&
    offset >= 0
    ? { limit, offset }
    : null;
}
function queryCurrency(value: unknown) {
  const currency =
    value && typeof value === "object"
      ? string((value as Body).currency)?.toUpperCase()
      : undefined;
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
}
function audit(request: FastifyRequest, context: RequestContext, reason: string) {
  return {
    actor: {
      kind: "user" as const,
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    requestId: request.id,
    correlationId: string(request.headers["x-correlation-id"]) ?? request.id,
    reason,
    requestedAt: new Date().toISOString(),
  };
}
function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function mask(value: string | null) {
  if (!value) return null;
  return value.length > 4 ? `••••${value.slice(-4)}` : "••••";
}
function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function hasStatus(value: unknown): value is { statusCode: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { statusCode?: unknown }).statusCode === "number"
  );
}
function error(reply: FastifyReply, statusCode: number, code: string) {
  return reply.code(statusCode).send({ code });
}
