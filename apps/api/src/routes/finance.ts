import {
  cancellationPolicyFromRefundPolicy,
  setupIncompletePaymentSettings,
  toFinanceCancellationPolicyResponse,
  toFinancePaymentSettingsResponse,
  toPublicPaymentCapabilityProjection,
  type CancellationPolicy,
  type FinanceJsonPolicy,
  type FinancePaymentSettingsReadModel,
  type FinancePropertySettingsReadRepository,
  type FinanceProviderAccountStatus,
  type FinanceProviderOnboardingStatus,
  type FinanceRoutePaymentMethod,
  type FinanceRoutePaymentProvider,
} from "@vayada/domain-finance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type { PublicHotelProfileRepository } from "./aiHotels.js";
import { enforceRoutePolicy, type RouteAuthorizationPolicy } from "./policy.js";

export type FinancePropertySettingsReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

export type FinanceRoutesOptions = {
  repository: FinancePropertySettingsReadRepository;
  publicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  publicHotelProfileRepository?: PublicHotelProfileRepository;
  closePublicHotelProfileRepository?: boolean;
};

export type FinancePublicHotelPropertyResolver = {
  findPropertyIdBySlug(slug: string): Promise<string | null>;
  close?(): Promise<void>;
};

type FinancePublicHotelPropertyRow = {
  propertyId: string;
};

type FinancePropertyParams = {
  propertyId: string;
};

type BookingWebHotelParams = {
  slug: string;
};

type FinancePaymentSettingsRow = {
  propertyId: string;
  paymentsEnabled: boolean | null;
  acceptedMethods: unknown;
  defaultCurrency: string | null;
  depositPolicy: unknown;
  refundPolicy: unknown;
  taxPolicy: unknown;
  statementDescriptor: string | null;
  requiresManualReview: boolean | null;
  updatedAt: Date | string | null;
  providerAccountId: string | null;
  provider: string | null;
  providerStatus: string | null;
  providerOnboardingStatus: string | null;
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  providerCapabilities: unknown;
};

type FinanceAccessError = {
  statusCode: 401 | 403;
  code:
    | "unauthenticated"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "missing_resource_access";
  category: "authentication" | "authorization";
  message: string;
};

export async function registerFinanceRoutes(
  app: FastifyInstance,
  options: FinanceRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.repository.close?.();
    await options.publicHotelPropertyResolver?.close?.();
    if (options.closePublicHotelProfileRepository) {
      await options.publicHotelProfileRepository?.close?.();
    }
  });

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/payment-settings",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const settings =
        (await options.repository.getPaymentSettings(propertyId)) ??
        setupIncompletePaymentSettings(propertyId, new Date().toISOString());
      return toFinancePaymentSettingsResponse(settings);
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/cancellation-policy",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const policy =
        (await options.repository.getCancellationPolicy(propertyId)) ??
        cancellationPolicyFromRefundPolicy({}, new Date().toISOString());
      return toFinanceCancellationPolicyResponse(propertyId, policy);
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/invoices",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      reply.code(501);
      return {
        code: "not_implemented",
        message: "Finance invoice reads are outside this migration slice.",
      };
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/pms/properties/:propertyId/payment-settings",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const settings =
        (await options.repository.getPaymentSettings(propertyId)) ??
        setupIncompletePaymentSettings(propertyId, new Date().toISOString());
      const policy =
        (await options.repository.getCancellationPolicy(propertyId)) ??
        cancellationPolicyFromRefundPolicy(settings.refundPolicy, settings.updatedAt);
      return toPmsPaymentSettingsFacade(settings, policy);
    },
  );

  app.get<{ Params: BookingWebHotelParams }>(
    "/booking-web/hotels/:slug/payment-settings",
    async (request, reply) => {
      const propertyId = await resolvePublicFinancePropertyId(options, request.params.slug);
      if (!propertyId) {
        reply.code(404);
        return {
          code: "hotel_not_found",
          message: "Booking Web hotel profile not found.",
        };
      }

      const settings =
        (await options.repository.getPaymentSettings(propertyId)) ??
        setupIncompletePaymentSettings(propertyId, new Date().toISOString());
      const policy =
        (await options.repository.getCancellationPolicy(propertyId)) ??
        cancellationPolicyFromRefundPolicy(settings.refundPolicy, settings.updatedAt);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-payment-settings");
      reply.header("X-Robots-Tag", "noindex");
      return toPublicPaymentCapabilityProjection(settings, policy);
    },
  );
}

async function resolvePublicFinancePropertyId(
  options: FinanceRoutesOptions,
  slug: string,
): Promise<string | null> {
  const resolvedPropertyId = await options.publicHotelPropertyResolver?.findPropertyIdBySlug(slug);
  if (resolvedPropertyId) return resolvedPropertyId;

  const profile = await options.publicHotelProfileRepository?.findProfileBySlug(slug);
  return profile?.hotel.propertyId ?? null;
}

export function createTargetFinancePublicHotelPropertyResolver(config: {
  connectionString: string;
  max?: number;
  pool?: FinancePropertySettingsReadPool;
}): FinancePublicHotelPropertyResolver {
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async findPropertyIdBySlug(slug) {
      const result = await pool.query<FinancePublicHotelPropertyRow>(
        `SELECT profile.property_id::text AS "propertyId"
         FROM distribution.public_hotel_bookability_profiles profile
         LEFT JOIN hotel_catalog.property_slugs slug_alias
           ON slug_alias.property_id = profile.property_id
          AND slug_alias.slug = lower($1)
          AND slug_alias.purpose = 'redirect'
          AND slug_alias.status = 'redirected'
         WHERE profile.canonical_slug = lower($1)
            OR slug_alias.property_id IS NOT NULL
         ORDER BY CASE WHEN profile.canonical_slug = lower($1) THEN 0 ELSE 1 END
         LIMIT 1`,
        [slug],
      );
      return result.rows[0]?.propertyId ?? null;
    },
    async close() {
      await pool.end();
    },
  };
}

export function createTargetFinancePropertySettingsRepository(config: {
  connectionString: string;
  max?: number;
  pool?: FinancePropertySettingsReadPool;
}): FinancePropertySettingsReadRepository {
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async getPaymentSettings(propertyId) {
      const row = await loadPaymentSettingsRow(pool, propertyId);
      return row ? toFinancePaymentSettingsReadModel(row) : null;
    },
    async getCancellationPolicy(propertyId) {
      const row = await loadPaymentSettingsRow(pool, propertyId);
      return row
        ? cancellationPolicyFromRefundPolicy(
            jsonPolicy(row.refundPolicy),
            utcDateTime(row.updatedAt, new Date().toISOString()),
          )
        : null;
    },
    async close() {
      await pool.end();
    },
  };
}

async function loadPaymentSettingsRow(
  pool: FinancePropertySettingsReadPool,
  propertyId: string,
): Promise<FinancePaymentSettingsRow | null> {
  const result = await pool.query<FinancePaymentSettingsRow>(
    `SELECT
       settings.property_id::text AS "propertyId",
       settings.payments_enabled AS "paymentsEnabled",
       settings.accepted_methods AS "acceptedMethods",
       settings.default_currency AS "defaultCurrency",
       COALESCE(settings.deposit_policy, '{}'::jsonb) AS "depositPolicy",
       COALESCE(settings.refund_policy, '{}'::jsonb) AS "refundPolicy",
       COALESCE(settings.tax_policy, '{}'::jsonb) AS "taxPolicy",
       settings.statement_descriptor AS "statementDescriptor",
       settings.requires_manual_review AS "requiresManualReview",
       settings.updated_at AS "updatedAt",
       account.provider_account_id AS "providerAccountId",
       account.provider,
       account.status AS "providerStatus",
       account.onboarding_status AS "providerOnboardingStatus",
       account.charges_enabled AS "chargesEnabled",
       account.payouts_enabled AS "payoutsEnabled",
       account.capabilities AS "providerCapabilities"
     FROM finance.payment_settings settings
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = settings.provider_account_id
      AND account.property_id = settings.property_id
      AND account.account_scope = 'property'
     WHERE settings.property_id = $1::uuid
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function toFinancePaymentSettingsReadModel(
  row: FinancePaymentSettingsRow,
): FinancePaymentSettingsReadModel {
  const acceptedMethods = paymentMethods(row.acceptedMethods);
  const defaultCurrency = currencyCode(row.defaultCurrency);
  const providerStatus = providerAccountStatus(row.providerStatus);
  return {
    propertyId: row.propertyId,
    paymentsEnabled: row.paymentsEnabled ?? false,
    paymentProvider: paymentProvider(row.provider),
    acceptedMethods,
    defaultCurrency,
    supportedCurrencies: [defaultCurrency],
    depositPolicy: jsonPolicy(row.depositPolicy),
    refundPolicy: jsonPolicy(row.refundPolicy),
    taxPolicy: jsonPolicy(row.taxPolicy),
    statementDescriptor: row.statementDescriptor,
    requiresManualReview: (row.requiresManualReview ?? false) || providerStatus !== "active",
    providerAccount: {
      providerAccountId: row.providerAccountId,
      provider: row.provider ? paymentProvider(row.provider) : null,
      status: providerStatus,
      onboardingStatus: providerOnboardingStatus(row.providerOnboardingStatus),
      chargesEnabled: row.chargesEnabled ?? false,
      payoutsEnabled: row.payoutsEnabled ?? false,
      capabilities: stringArray(row.providerCapabilities),
    },
    sourceFreshness: {
      finance: "target",
      status: "fresh",
    },
    updatedAt: utcDateTime(row.updatedAt, new Date().toISOString()),
  };
}

function enforceFinancePropertyReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  const policies = financePropertyReadPolicies(propertyId);
  try {
    enforceAnyFinancePropertyReadPolicy(request, policies);
    return true;
  } catch (error) {
    const accessError = toFinanceAccessError(error, request, propertyId);
    if (!accessError) throw error;
    reply.code(accessError.statusCode).send(accessError);
    return false;
  }
}

function financePropertyReadPolicies(propertyId: string): RouteAuthorizationPolicy[] {
  const resourceTypes = ["pms_property", "property"] as const;
  return resourceTypes.flatMap((resourceType) => [
    {
      permission: "pms.finance.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "finance_manager"],
      },
    },
    {
      permission: "pms.finance.read",
      entitlement: {
        product: "booking",
        key: "direct-booking-finance",
        resource: {
          product: "pms",
          resourceType,
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType,
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "finance_manager"],
      },
    },
  ]);
}

function enforceAnyFinancePropertyReadPolicy(
  request: FastifyRequest,
  policies: RouteAuthorizationPolicy[],
): void {
  const errors: unknown[] = [];
  for (const policy of policies) {
    try {
      enforceRoutePolicy(request, policy);
      return;
    } catch (error) {
      errors.push(error);
      if (isStatusError(error) && error.statusCode === 401) throw error;
    }
  }
  throw errors[0] ?? new Error("Finance property read policy denied.");
}

function toFinanceAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): FinanceAccessError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toFinanceAuthorizationCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toFinanceAuthorizationMessage(code),
  };
}

function toFinanceAuthorizationCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
): Exclude<FinanceAccessError["code"], "unauthenticated"> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (hasActiveFinanceEntitlement(request, propertyId)) return "missing_resource_access";
  if (hasInactiveFinanceEntitlement(request, propertyId)) return "inactive_entitlement";
  return "missing_entitlement";
}

function toFinanceAuthorizationMessage(
  code: Exclude<FinanceAccessError["code"], "unauthenticated">,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required finance read permission.";
    case "inactive_entitlement":
      return "Finance property-management entitlement is not active.";
    case "missing_entitlement":
      return "Missing active finance property-management entitlement.";
    case "missing_resource_access":
      return "Missing finance property access.";
  }
}

function hasInactiveFinanceEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinancePropertyReadEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status === "active") return false;
      return entitlementAppliesToFinanceProperty(entitlement.resource, propertyId);
    }) ?? false
  );
}

function hasActiveFinanceEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (!isFinancePropertyReadEntitlement(entitlement.product, entitlement.key)) return false;
      if (entitlement.status !== "active") return false;
      return entitlementAppliesToFinanceProperty(entitlement.resource, propertyId);
    }) ?? false
  );
}

function isFinancePropertyReadEntitlement(product: string, key: string): boolean {
  return (
    (product === "pms" && key === "property-management") ||
    (product === "booking" && key === "direct-booking-finance")
  );
}

function entitlementAppliesToFinanceProperty(
  resource: { product: string; resourceType: string; resourceId: string } | undefined,
  propertyId: string,
): boolean {
  if (!resource) return true;
  return (
    resource.product === "pms" &&
    (resource.resourceType === "pms_property" || resource.resourceType === "property") &&
    resource.resourceId === propertyId
  );
}

function toPmsPaymentSettingsFacade(
  settings: FinancePaymentSettingsReadModel,
  policy: CancellationPolicy,
): {
  paymentSettings: {
    stripeConnectAccountId: null;
    stripeConnectOnboarded: boolean;
    platformFeeType: "none";
    platformFeeValue: 0;
    platformFeeWithAffiliate: 0;
    payAtPropertyEnabled: boolean;
    onlineCardPayment: boolean;
    bankTransfer: boolean;
    xenditPaymentsEnabled: boolean;
    paymentProvider: "stripe" | "xendit";
    xenditChannelCode: null;
    xenditAccountNumber: null;
    xenditAccountHolderName: null;
    defaultCurrency: string;
  };
  cancellationPolicy: {
    freeCancellationDays: number;
    partialRefundPct: number;
  };
} {
  const enabledMethods = settings.paymentsEnabled ? settings.acceptedMethods : [];
  return {
    paymentSettings: {
      stripeConnectAccountId: null,
      stripeConnectOnboarded:
        settings.providerAccount.provider === "stripe" &&
        settings.providerAccount.onboardingStatus === "completed",
      platformFeeType: "none",
      platformFeeValue: 0,
      platformFeeWithAffiliate: 0,
      payAtPropertyEnabled: enabledMethods.includes("pay_at_property"),
      onlineCardPayment: enabledMethods.includes("card"),
      bankTransfer: enabledMethods.includes("bank_transfer"),
      xenditPaymentsEnabled:
        settings.paymentsEnabled &&
        (settings.paymentProvider === "xendit" || enabledMethods.includes("xendit")),
      paymentProvider: settings.paymentProvider === "xendit" ? "xendit" : "stripe",
      xenditChannelCode: null,
      xenditAccountNumber: null,
      xenditAccountHolderName: null,
      defaultCurrency: settings.defaultCurrency,
    },
    cancellationPolicy: {
      freeCancellationDays: policy.freeCancellationDays,
      partialRefundPct: policy.partialRefundPercent,
    },
  };
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

function paymentProvider(value: unknown): FinanceRoutePaymentProvider {
  if (
    value === "stripe" ||
    value === "xendit" ||
    value === "vayada" ||
    value === "manual" ||
    value === "bank_transfer"
  ) {
    return value;
  }
  return "manual";
}

function paymentMethods(value: unknown): FinanceRoutePaymentMethod[] {
  return stringArray(value).map((method) => {
    switch (method) {
      case "card":
      case "pay_at_property":
      case "xendit":
      case "cash":
      case "bank_transfer":
      case "manual_card":
      case "wallet":
        return method;
      case "paypal":
        return "wallet";
      default:
        return "other";
    }
  });
}

function providerAccountStatus(value: unknown): FinanceProviderAccountStatus {
  if (
    value === "pending" ||
    value === "active" ||
    value === "restricted" ||
    value === "suspended" ||
    value === "disabled"
  ) {
    return value;
  }
  return "setup_incomplete";
}

function providerOnboardingStatus(value: unknown): FinanceProviderOnboardingStatus {
  if (
    value === "invited" ||
    value === "in_review" ||
    value === "completed" ||
    value === "requires_action"
  ) {
    return value;
  }
  return "not_started";
}

function currencyCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : "EUR";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function jsonPolicy(value: unknown): FinanceJsonPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string | number | boolean | null] => {
        const [, policyValue] = entry;
        return (
          policyValue === null ||
          typeof policyValue === "string" ||
          typeof policyValue === "number" ||
          typeof policyValue === "boolean"
        );
      },
    ),
  );
}

function utcDateTime(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}
