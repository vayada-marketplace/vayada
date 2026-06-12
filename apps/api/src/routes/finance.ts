import {
  FINANCE_INVOICE_STATUSES,
  FINANCE_PAYMENT_STATUSES,
  FINANCE_RECONCILIATION_STATUSES,
  FINANCE_ROUTE_CONTRACT_VERSION,
  FINANCE_ROUTE_PAYMENT_METHODS,
  FINANCE_ROUTE_PAYMENT_PROVIDERS,
  cancellationPolicyFromRefundPolicy,
  setupIncompletePaymentSettings,
  toFinanceCancellationPolicyResponse,
  toFinancePaymentSettingsResponse,
  toPublicPaymentCapabilityProjection,
  type CancellationPolicy,
  type FinanceFinancialSummaryResponse,
  type FinanceInvoiceCsvExportResponse,
  type FinanceInvoiceDetail,
  type FinanceInvoiceDetailResponse,
  type FinanceInvoiceListItem,
  type FinanceInvoiceListQuery,
  type FinanceInvoiceListResponse,
  type FinanceInvoicePayment,
  type FinanceInvoiceStatus,
  type FinanceInvoiceStatusCounts,
  type FinanceJsonObject,
  type FinanceJsonPolicy,
  type FinancePaymentLedgerItem,
  type FinancePaymentLedgerQuery,
  type FinancePaymentLedgerResponse,
  type FinancePaymentSettingsReadModel,
  type FinancePaymentStatusCounts,
  type FinancePropertyReadRepository,
  type FinanceProviderAccountStatus,
  type FinanceProviderOnboardingStatus,
  type FinanceReconciliationStatus,
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
  repository: FinancePropertyReadRepository;
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

type FinanceInvoiceParams = FinancePropertyParams & {
  invoiceId: string;
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

type FinanceVisibilitySummaryRow = {
  propertyId: string;
  periodStart: Date | string | null;
  periodEnd: Date | string | null;
  currency: string;
  grossPaymentAmount: string;
  netPaymentAmount: string;
  payoutAmount: string;
  commissionAmount: string;
  outstandingBalanceAmount: string;
  paymentCount: number;
  payoutCount: number;
  failedPaymentCount: number;
  statusCounts: unknown;
  sourceFreshness: unknown;
  projectedAt: Date | string | null;
};

type FinanceInvoiceRow = {
  invoiceId: string;
  invoiceNumber: string;
  guestBookingId: string;
  bookingReference: string;
  guestDisplayName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  checkIn: Date | string;
  checkOut: Date | string;
  roomName: string | null;
  roomNumber: string | null;
  currency: string;
  totalAmount: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
  issuedAt: Date | string;
  total: string | number;
  counts: unknown;
  sourceFreshness: unknown;
};

type FinanceInvoicePaymentRow = {
  paymentId: string;
  method: string;
  amount: string;
  currency: string;
  reference: string | null;
  status: string;
  recordedAt: Date | string;
};

type FinancePaymentLedgerRow = {
  paymentId: string;
  method: string;
  amount: string;
  currency: string;
  reference: string | null;
  status: string;
  recordedAt: Date | string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  guestBookingId: string | null;
  bookingReference: string | null;
  checkoutChargeId: string | null;
  provider: string | null;
  providerStatus: string | null;
  reconciliationStatus: string | null;
  total: string | number;
  counts: unknown;
  sourceFreshness: unknown;
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

type FinanceValidationError = {
  statusCode: 400;
  code: "invalid_query" | "invalid_provider" | "invalid_payment_method" | "invalid_date_range";
  category: "validation";
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
    "/finance/properties/:propertyId/summary",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const summary =
        (await options.repository.getFinancialSummary?.(propertyId)) ??
        emptyFinancialSummary(propertyId);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...summary,
      } satisfies FinanceFinancialSummaryResponse;
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/invoices",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      const query = parseInvoiceListQuery(request.query);
      if ("statusCode" in query) {
        reply.code(query.statusCode);
        return query;
      }

      const result =
        (await options.repository.listInvoices?.(propertyId, query)) ?? emptyInvoiceList(query);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...result,
      } satisfies FinanceInvoiceListResponse;
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/invoices/export.csv",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      const query = parseInvoiceListQuery(request.query);
      if ("statusCode" in query) {
        reply.code(query.statusCode);
        return query;
      }

      const result =
        (await options.repository.getInvoiceCsvExportDisposition?.(propertyId, query)) ??
        emptyInvoiceCsvExportDisposition(propertyId);
      if (result.export.status === "queued") reply.code(202);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...result,
      } satisfies FinanceInvoiceCsvExportResponse;
    },
  );

  app.get<{ Params: FinanceInvoiceParams }>(
    "/finance/properties/:propertyId/invoices/:invoiceId",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;

      const result = await options.repository.getInvoice?.(propertyId, request.params.invoiceId);
      if (!result) {
        reply.code(404);
        return {
          code: "invoice_not_found",
          category: "not_found",
          message: "Finance invoice was not found.",
        };
      }

      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...result,
      } satisfies FinanceInvoiceDetailResponse;
    },
  );

  app.get<{ Params: FinancePropertyParams }>(
    "/finance/properties/:propertyId/payments",
    async (request, reply) => {
      const propertyId = request.params.propertyId;
      if (!enforceFinancePropertyReadPolicy(request, reply, propertyId)) return reply;
      const query = parsePaymentLedgerQuery(request.query);
      if ("statusCode" in query) {
        reply.code(query.statusCode);
        return query;
      }

      const result =
        (await options.repository.listPayments?.(propertyId, query)) ?? emptyPaymentLedger(query);
      return {
        contractVersion: FINANCE_ROUTE_CONTRACT_VERSION,
        propertyId,
        ...result,
      } satisfies FinancePaymentLedgerResponse;
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
}): FinancePropertyReadRepository {
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
    async getFinancialSummary(propertyId) {
      const row = await loadFinancialSummaryRow(pool, propertyId);
      return row ? toFinancialSummaryResponseBody(row) : null;
    },
    async listInvoices(propertyId, query) {
      const rows = await loadInvoiceRows(pool, propertyId, query);
      return toInvoiceListResponseBody(rows, query);
    },
    async getInvoice(propertyId, invoiceId) {
      const rows = await loadInvoiceRows(pool, propertyId, {
        sort: "issuedAt",
        limit: 500,
        offset: 0,
        search: invoiceId,
      });
      const invoice = rows.find((row) => row.invoiceId === invoiceId);
      if (!invoice) return null;

      const payments = await loadInvoicePaymentRows(pool, propertyId, invoice.guestBookingId);
      return {
        invoice: {
          ...toInvoiceListItem(invoice),
          guest: {
            displayName: invoice.guestDisplayName ?? "Guest",
            email: invoice.guestEmail,
            phone: invoice.guestPhone,
          },
          nights: nightsBetween(invoice.checkIn, invoice.checkOut),
          charges: [
            {
              description: "Stay",
              detail: `${dateOnly(invoice.checkIn)} to ${dateOnly(invoice.checkOut)}`,
              amount: decimalString(invoice.totalAmount),
            },
          ],
          payments: payments.map(toInvoicePayment),
          subtotal: decimalString(invoice.totalAmount),
        },
        sourceFreshness: financeJsonObject(invoice.sourceFreshness),
      };
    },
    async listPayments(propertyId, query) {
      const rows = await loadPaymentLedgerRows(pool, propertyId, query);
      return toPaymentLedgerResponseBody(rows, query);
    },
    async getInvoiceCsvExportDisposition(propertyId) {
      return {
        export: {
          status: "queued",
          disposition: "durable_export_job",
          filename: `finance-invoices-${propertyId}.csv`,
          contentType: "text/csv",
          downloadUrl: null,
          jobId: null,
          message: "Invoice CSV export runs through the Finance read-model export job.",
        },
        sourceFreshness: {
          finance: {
            status: "fresh",
          },
        },
      };
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

async function loadFinancialSummaryRow(
  pool: FinancePropertySettingsReadPool,
  propertyId: string,
): Promise<FinanceVisibilitySummaryRow | null> {
  const result = await pool.query<FinanceVisibilitySummaryRow>(
    `SELECT
       visibility.property_id::text AS "propertyId",
       visibility.period_start AS "periodStart",
       visibility.period_end AS "periodEnd",
       visibility.currency,
       visibility.gross_payment_amount::text AS "grossPaymentAmount",
       visibility.net_payment_amount::text AS "netPaymentAmount",
       visibility.payout_amount::text AS "payoutAmount",
       visibility.commission_amount::text AS "commissionAmount",
       visibility.outstanding_balance_amount::text AS "outstandingBalanceAmount",
       visibility.payment_count AS "paymentCount",
       visibility.payout_count AS "payoutCount",
       visibility.failed_payment_count AS "failedPaymentCount",
       visibility.status_counts AS "statusCounts",
       visibility.source_freshness AS "sourceFreshness",
       visibility.projected_at AS "projectedAt"
     FROM finance.finance_visibility_read_model visibility
     WHERE visibility.property_id = $1::uuid
       AND visibility.visibility_scope = 'property_finance'
       AND visibility.required_permission_key = 'pms.finance.read'
     ORDER BY visibility.projected_at DESC
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

async function loadInvoiceRows(
  pool: FinancePropertySettingsReadPool,
  propertyId: string,
  query: FinanceInvoiceListQuery,
): Promise<FinanceInvoiceRow[]> {
  const result = await pool.query<FinanceInvoiceRow>(
    `WITH invoice_base AS (
       SELECT
         COALESCE(booking.booking_metadata ->> 'invoiceId', booking.id::text) AS "invoiceId",
         COALESCE(booking.booking_metadata ->> 'invoiceNumber', booking.public_reference) AS "invoiceNumber",
         booking.id::text AS "guestBookingId",
         booking.public_reference AS "bookingReference",
         NULLIF(concat_ws(' ', guest.first_name, guest.last_name), '') AS "guestDisplayName",
         guest.email AS "guestEmail",
         guest.phone AS "guestPhone",
         booking.check_in AS "checkIn",
         booking.check_out AS "checkOut",
         COALESCE(assignment.assignment_payload ->> 'roomName', room_type.name) AS "roomName",
         room.room_number AS "roomNumber",
         booking.currency,
         booking.total_amount::text AS "totalAmount",
         COALESCE(payment_totals.amount_paid, 0)::text AS "amountPaid",
         booking.balance_amount::text AS "balanceDue",
         CASE
           WHEN booking.lifecycle_status IN ('draft') THEN 'draft'
           WHEN booking.lifecycle_status IN ('declined', 'canceled', 'expired') THEN 'voided'
           WHEN booking.balance_amount = 0 OR booking.payment_status = 'paid' THEN 'paid'
           WHEN COALESCE(payment_totals.amount_paid, 0) > 0 THEN 'partial'
           WHEN booking.check_in < current_date THEN 'overdue'
           ELSE 'sent'
         END AS status,
         booking.created_at AS "issuedAt",
         COALESCE(visibility.source_freshness, '{}'::jsonb) AS "sourceFreshness"
       FROM booking.guest_bookings booking
       LEFT JOIN booking.booking_guests guest
         ON guest.guest_booking_id = booking.id
        AND guest.guest_role = 'booker'
       LEFT JOIN pms.operational_booking_assignments assignment
         ON assignment.property_id = booking.property_id
        AND assignment.guest_booking_id = booking.id
        AND assignment.position = 1
       LEFT JOIN pms.rooms room
         ON room.id = assignment.room_id
        AND room.property_id = assignment.property_id
       LEFT JOIN pms.room_types room_type
         ON room_type.id = assignment.room_type_id
        AND room_type.property_id = assignment.property_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(payment.amount - payment.refunded_amount), 0) AS amount_paid
         FROM finance.payments payment
         WHERE payment.property_id = booking.property_id
           AND payment.guest_booking_id = booking.id
           AND payment.status IN ('authorized', 'pending', 'paid', 'partially_refunded')
           AND payment.visibility_class IN ('pms_finance', 'migration')
       ) payment_totals ON TRUE
       LEFT JOIN LATERAL (
         SELECT source_freshness
         FROM finance.finance_visibility_read_model visibility
         WHERE visibility.property_id = booking.property_id
           AND visibility.visibility_scope = 'property_finance'
           AND visibility.required_permission_key = 'pms.finance.read'
         ORDER BY visibility.projected_at DESC
         LIMIT 1
       ) visibility ON TRUE
       WHERE booking.property_id = $1::uuid
     ),
     filtered AS (
       SELECT *
       FROM invoice_base
       WHERE ($2::text IS NULL OR status = $2::text)
         AND (
           $3::text IS NULL
           OR lower("invoiceId") LIKE lower($3::text)
           OR lower("invoiceNumber") LIKE lower($3::text)
           OR lower("bookingReference") LIKE lower($3::text)
           OR lower(COALESCE("guestDisplayName", '')) LIKE lower($3::text)
           OR lower(COALESCE("guestEmail", '')) LIKE lower($3::text)
         )
     ),
     counts AS (
       SELECT jsonb_object_agg(status, count) AS counts
       FROM (
         SELECT status, count(*) AS count
         FROM invoice_base
         GROUP BY status
       ) status_counts
     )
     SELECT
       filtered.*,
       count(*) OVER () AS total,
       COALESCE(counts.counts, '{}'::jsonb) AS counts
     FROM filtered
     CROSS JOIN counts
     ORDER BY
       CASE WHEN $4::text = 'guest' THEN lower(COALESCE("guestDisplayName", '')) END ASC,
       CASE WHEN $4::text = 'amount' THEN "totalAmount"::numeric END DESC,
       CASE WHEN $4::text IN ('issuedAt', 'guest', 'amount') THEN "issuedAt" END DESC,
       "invoiceNumber" ASC
     LIMIT $5::integer OFFSET $6::integer`,
    [
      propertyId,
      query.status ?? null,
      likeSearch(query.search),
      query.sort,
      query.limit,
      query.offset,
    ],
  );
  return result.rows;
}

async function loadInvoicePaymentRows(
  pool: FinancePropertySettingsReadPool,
  propertyId: string,
  guestBookingId: string,
): Promise<FinanceInvoicePaymentRow[]> {
  const result = await pool.query<FinanceInvoicePaymentRow>(
    `SELECT
       payment.id::text AS "paymentId",
       payment.payment_method AS method,
       payment.amount::text AS amount,
       payment.currency,
       COALESCE(payment.payment_metadata ->> 'reference', payment.source_payment_id) AS reference,
       payment.status,
       COALESCE(payment.paid_at, payment.authorized_at, payment.created_at) AS "recordedAt"
     FROM finance.payments payment
     WHERE payment.property_id = $1::uuid
       AND payment.guest_booking_id = $2::uuid
       AND payment.visibility_class IN ('pms_finance', 'migration')
     ORDER BY COALESCE(payment.paid_at, payment.authorized_at, payment.created_at) DESC,
       payment.id ASC`,
    [propertyId, guestBookingId],
  );
  return result.rows;
}

async function loadPaymentLedgerRows(
  pool: FinancePropertySettingsReadPool,
  propertyId: string,
  query: FinancePaymentLedgerQuery,
): Promise<FinancePaymentLedgerRow[]> {
  const result = await pool.query<FinancePaymentLedgerRow>(
    `WITH payment_base AS (
       SELECT
         payment.id::text AS "paymentId",
         payment.payment_method AS method,
         payment.amount::text AS amount,
         payment.currency,
         COALESCE(payment.payment_metadata ->> 'reference', payment.source_payment_id) AS reference,
         payment.status,
         COALESCE(payment.paid_at, payment.authorized_at, payment.failed_at, payment.created_at) AS "recordedAt",
         COALESCE(booking.booking_metadata ->> 'invoiceId', booking.id::text) AS "invoiceId",
         COALESCE(booking.booking_metadata ->> 'invoiceNumber', booking.public_reference) AS "invoiceNumber",
         booking.id::text AS "guestBookingId",
         booking.public_reference AS "bookingReference",
         payment.payment_metadata ->> 'checkoutChargeId' AS "checkoutChargeId",
         COALESCE(
           account.provider,
           CASE
             WHEN payment.payment_method = 'bank_transfer' THEN 'bank_transfer'
             WHEN payment.payment_method IN ('cash', 'manual_card', 'other', 'unknown') THEN 'manual'
             ELSE 'vayada'
           END
         ) AS provider,
         COALESCE(payment.payment_metadata ->> 'providerStatus', payment.status) AS "providerStatus",
         COALESCE(payment.payment_metadata ->> 'reconciliationStatus', 'pending') AS "reconciliationStatus",
         NULLIF(concat_ws(' ', guest.first_name, guest.last_name), '') AS "guestDisplayName",
         guest.email AS "guestEmail",
         COALESCE(visibility.source_freshness, '{}'::jsonb) AS "sourceFreshness"
       FROM finance.payments payment
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payment.provider_account_id
        AND account.property_id = payment.property_id
       LEFT JOIN booking.guest_bookings booking
         ON booking.id = payment.guest_booking_id
        AND booking.property_id = payment.property_id
       LEFT JOIN booking.booking_guests guest
         ON guest.guest_booking_id = booking.id
        AND guest.guest_role = 'booker'
       LEFT JOIN LATERAL (
         SELECT source_freshness
         FROM finance.finance_visibility_read_model visibility
         WHERE visibility.property_id = payment.property_id
           AND visibility.visibility_scope = 'property_finance'
           AND visibility.required_permission_key = 'pms.finance.read'
         ORDER BY visibility.projected_at DESC
         LIMIT 1
       ) visibility ON TRUE
       WHERE payment.property_id = $1::uuid
         AND payment.visibility_class IN ('pms_finance', 'migration')
     ),
     filtered AS (
       SELECT *
       FROM payment_base
       WHERE ($2::text IS NULL OR status = $2::text)
         AND ($3::text IS NULL OR provider = $3::text)
         AND ($4::text IS NULL OR method = $4::text)
         AND ($5::timestamptz IS NULL OR "recordedAt" >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR "recordedAt" <= $6::timestamptz)
         AND (
           $7::text IS NULL
           OR lower(COALESCE("invoiceId", '')) LIKE lower($7::text)
           OR lower(COALESCE("invoiceNumber", '')) LIKE lower($7::text)
           OR lower(COALESCE("bookingReference", '')) LIKE lower($7::text)
           OR lower(COALESCE(reference, '')) LIKE lower($7::text)
           OR lower(COALESCE("guestDisplayName", '')) LIKE lower($7::text)
           OR lower(COALESCE("guestEmail", '')) LIKE lower($7::text)
         )
     ),
     counts AS (
       SELECT jsonb_object_agg(status, count) AS counts
       FROM (
         SELECT status, count(*) AS count
         FROM payment_base
         GROUP BY status
       ) status_counts
     )
     SELECT
       filtered.*,
       count(*) OVER () AS total,
       COALESCE(counts.counts, '{}'::jsonb) AS counts
     FROM filtered
     CROSS JOIN counts
     ORDER BY "recordedAt" DESC, "paymentId" ASC
     LIMIT $8::integer OFFSET $9::integer`,
    [
      propertyId,
      query.status ?? null,
      query.provider ?? null,
      query.method ?? null,
      query.from ?? null,
      query.to ?? null,
      likeSearch(query.search),
      query.limit,
      query.offset,
    ],
  );
  return result.rows;
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

function toFinancialSummaryResponseBody(
  row: FinanceVisibilitySummaryRow,
): Omit<FinanceFinancialSummaryResponse, "contractVersion" | "propertyId"> {
  const statusCounts = financeJsonObject(row.statusCounts);
  return {
    summary: {
      currency: currencyCode(row.currency),
      periodStart: row.periodStart ? dateOnly(row.periodStart) : null,
      periodEnd: row.periodEnd ? dateOnly(row.periodEnd) : null,
      grossPaymentAmount: decimalString(row.grossPaymentAmount),
      netPaymentAmount: decimalString(row.netPaymentAmount),
      payoutAmount: decimalString(row.payoutAmount),
      commissionAmount: decimalString(row.commissionAmount),
      outstandingBalanceAmount: decimalString(row.outstandingBalanceAmount),
      paymentCount: row.paymentCount,
      payoutCount: row.payoutCount,
      failedPaymentCount: row.failedPaymentCount,
      invoiceCounts: invoiceStatusCounts(statusCounts["invoices"] ?? statusCounts),
      paymentCounts: paymentStatusCounts(statusCounts["payments"] ?? statusCounts),
      projectedAt: row.projectedAt ? utcDateTime(row.projectedAt, "") : null,
    },
    sourceFreshness: financeJsonObject(row.sourceFreshness),
  };
}

function toInvoiceListResponseBody(
  rows: FinanceInvoiceRow[],
  query: FinanceInvoiceListQuery,
): Omit<FinanceInvoiceListResponse, "contractVersion" | "propertyId"> {
  return {
    invoices: rows.map(toInvoiceListItem),
    total: totalFromRows(rows),
    counts: invoiceStatusCounts(rows[0]?.counts),
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: financeJsonObject(rows[0]?.sourceFreshness),
  };
}

function toInvoiceListItem(row: FinanceInvoiceRow): FinanceInvoiceListItem {
  return {
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    guestBookingId: row.guestBookingId,
    bookingReference: row.bookingReference,
    guest: {
      displayName: row.guestDisplayName ?? "Guest",
      email: row.guestEmail,
    },
    stay: {
      checkIn: dateOnly(row.checkIn),
      checkOut: dateOnly(row.checkOut),
      roomName: row.roomName,
      roomNumber: row.roomNumber,
    },
    currency: currencyCode(row.currency),
    totalAmount: decimalString(row.totalAmount),
    amountPaid: decimalString(row.amountPaid),
    balanceDue: decimalString(row.balanceDue),
    status: invoiceStatus(row.status),
    issuedAt: utcDateTime(row.issuedAt, new Date().toISOString()),
  };
}

function toInvoicePayment(row: FinanceInvoicePaymentRow): FinanceInvoicePayment {
  const method = invoicePaymentMethod(row.method);
  return {
    paymentId: row.paymentId,
    method,
    methodLabel: paymentMethodLabel(method),
    amount: decimalString(row.amount),
    currency: currencyCode(row.currency),
    reference: row.reference,
    status: paymentStatus(row.status),
    recordedAt: utcDateTime(row.recordedAt, new Date().toISOString()),
  };
}

function toPaymentLedgerResponseBody(
  rows: FinancePaymentLedgerRow[],
  query: FinancePaymentLedgerQuery,
): Omit<FinancePaymentLedgerResponse, "contractVersion" | "propertyId"> {
  return {
    payments: rows.map(toPaymentLedgerItem),
    total: totalFromRows(rows),
    counts: paymentStatusCounts(rows[0]?.counts),
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: financeJsonObject(rows[0]?.sourceFreshness),
  };
}

function toPaymentLedgerItem(row: FinancePaymentLedgerRow): FinancePaymentLedgerItem {
  const invoicePayment = toInvoicePayment(row);
  return {
    ...invoicePayment,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    guestBookingId: row.guestBookingId,
    bookingReference: row.bookingReference,
    checkoutChargeId: row.checkoutChargeId,
    provider: paymentProvider(row.provider),
    providerStatus: row.providerStatus,
    reconciliationStatus: reconciliationStatus(row.reconciliationStatus),
  };
}

function emptyFinancialSummary(
  propertyId: string,
): Omit<FinanceFinancialSummaryResponse, "contractVersion" | "propertyId"> {
  return {
    summary: {
      currency: "EUR",
      periodStart: null,
      periodEnd: null,
      grossPaymentAmount: "0.00",
      netPaymentAmount: "0.00",
      payoutAmount: "0.00",
      commissionAmount: "0.00",
      outstandingBalanceAmount: "0.00",
      paymentCount: 0,
      payoutCount: 0,
      failedPaymentCount: 0,
      invoiceCounts: invoiceStatusCounts(),
      paymentCounts: paymentStatusCounts(),
      projectedAt: null,
    },
    sourceFreshness: {
      finance: {
        status: "empty",
        propertyId,
      },
    },
  };
}

function emptyInvoiceList(
  query: FinanceInvoiceListQuery,
): Omit<FinanceInvoiceListResponse, "contractVersion" | "propertyId"> {
  return {
    invoices: [],
    total: 0,
    counts: invoiceStatusCounts(),
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: { finance: { status: "empty" } },
  };
}

function emptyPaymentLedger(
  query: FinancePaymentLedgerQuery,
): Omit<FinancePaymentLedgerResponse, "contractVersion" | "propertyId"> {
  return {
    payments: [],
    total: 0,
    counts: paymentStatusCounts(),
    limit: query.limit,
    offset: query.offset,
    sourceFreshness: { finance: { status: "empty" } },
  };
}

function emptyInvoiceCsvExportDisposition(
  propertyId: string,
): Omit<FinanceInvoiceCsvExportResponse, "contractVersion" | "propertyId"> {
  return {
    export: {
      status: "unsupported",
      disposition: "not_available",
      filename: `finance-invoices-${propertyId}.csv`,
      contentType: "text/csv",
      downloadUrl: null,
      jobId: null,
      message: "No Finance invoice read model is available to export yet.",
    },
    sourceFreshness: { finance: { status: "empty" } },
  };
}

function parseInvoiceListQuery(query: unknown): FinanceInvoiceListQuery | FinanceValidationError {
  const params = queryRecord(query);
  const status = optionalEnum(params.status, FINANCE_INVOICE_STATUSES);
  if (params.status && !status) {
    return invalidQuery("invalid_query", "Invalid invoice status filter.");
  }
  const sort = optionalEnum(params.sort, ["issuedAt", "guest", "amount"] as const) ?? "issuedAt";
  return {
    status,
    search: cleanSearch(params.search),
    sort,
    limit: clampLimit(params.limit),
    offset: parseOffset(params.offset),
  };
}

function parsePaymentLedgerQuery(
  query: unknown,
): FinancePaymentLedgerQuery | FinanceValidationError {
  const params = queryRecord(query);
  const status = optionalEnum(params.status, FINANCE_PAYMENT_STATUSES);
  if (params.status && !status) {
    return invalidQuery("invalid_query", "Invalid payment status filter.");
  }
  const provider = optionalEnum(params.provider, FINANCE_ROUTE_PAYMENT_PROVIDERS);
  if (params.provider && !provider) {
    return invalidQuery("invalid_provider", "Invalid payment provider filter.");
  }
  const rawMethod = optionalEnum(params.method, FINANCE_ROUTE_PAYMENT_METHODS);
  if (params.method && (!rawMethod || rawMethod === "wallet")) {
    return invalidQuery("invalid_payment_method", "Invalid payment method filter.");
  }
  const method: FinancePaymentLedgerQuery["method"] =
    rawMethod && rawMethod !== "wallet" ? rawMethod : undefined;
  const from = parseUtcBound(params.from);
  const to = parseUtcBound(params.to);
  if ((params.from && !from) || (params.to && !to) || (from && to && from > to)) {
    return invalidQuery("invalid_date_range", "Invalid payment ledger date range.");
  }
  return {
    status,
    provider,
    method,
    from,
    to,
    search: cleanSearch(params.search),
    limit: clampLimit(params.limit),
    offset: parseOffset(params.offset),
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

function financeJsonObject(value: unknown): FinanceJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const jsonValue = toFinanceJsonValue(entry);
      return jsonValue === undefined ? [] : [[key, jsonValue]];
    }),
  );
}

function toFinanceJsonValue(value: unknown): FinanceJsonObject[string] | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const jsonValue = toFinanceJsonValue(entry);
      return jsonValue === undefined ? [] : [jsonValue];
    });
  }
  if (typeof value === "object") return financeJsonObject(value);
  return undefined;
}

function utcDateTime(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function dateOnly(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function decimalString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && value.trim()) return value;
  return "0.00";
}

function invoiceStatus(value: unknown): FinanceInvoiceStatus {
  return optionalEnum(value, FINANCE_INVOICE_STATUSES) ?? "sent";
}

function paymentStatus(value: unknown): FinanceInvoicePayment["status"] {
  return optionalEnum(value, FINANCE_PAYMENT_STATUSES) ?? "pending";
}

function invoicePaymentMethod(value: unknown): FinanceInvoicePayment["method"] {
  const method = optionalEnum(value, FINANCE_ROUTE_PAYMENT_METHODS);
  if (method && method !== "wallet") return method;
  return "other";
}

function reconciliationStatus(value: unknown): FinanceReconciliationStatus {
  return optionalEnum(value, FINANCE_RECONCILIATION_STATUSES) ?? "pending";
}

function invoiceStatusCounts(value: unknown = {}): FinanceInvoiceStatusCounts {
  const counts = countRecord(value);
  return Object.fromEntries(
    FINANCE_INVOICE_STATUSES.map((status) => [status, counts[status] ?? 0]),
  ) as FinanceInvoiceStatusCounts;
}

function paymentStatusCounts(value: unknown = {}): FinancePaymentStatusCounts {
  const counts = countRecord(value);
  return Object.fromEntries(
    FINANCE_PAYMENT_STATUSES.map((status) => [status, counts[status] ?? 0]),
  ) as FinancePaymentStatusCounts;
}

function countRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      const numberValue = typeof entry === "number" ? entry : Number(entry);
      return Number.isFinite(numberValue) ? [[key, numberValue]] : [];
    }),
  );
}

function totalFromRows(rows: Array<{ total: string | number }>): number {
  if (rows.length === 0) return 0;
  const total = Number(rows[0]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

function nightsBetween(checkIn: Date | string, checkOut: Date | string): number {
  const start = new Date(dateOnly(checkIn));
  const end = new Date(dateOnly(checkOut));
  const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return Math.max(0, nights);
}

function paymentMethodLabel(method: FinanceInvoicePayment["method"]): string {
  switch (method) {
    case "pay_at_property":
      return "Pay at property";
    case "bank_transfer":
      return "Bank transfer";
    case "manual_card":
      return "Manual card";
    case "xendit":
      return "Xendit";
    case "card":
      return "Card";
    case "cash":
      return "Cash";
    case "other":
      return "Other";
  }
}

function queryRecord(query: unknown): Record<string, string | undefined> {
  if (!query || typeof query !== "object") return {};
  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).flatMap(([key, value]) => {
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number") return [[key, String(value)]];
      return [];
    }),
  );
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function cleanSearch(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
}

function likeSearch(value: string | undefined): string | null {
  return value ? `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%` : null;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed)) return 50;
  return Math.min(500, Math.max(1, parsed));
}

function parseOffset(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseUtcBound(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function invalidQuery(
  code: FinanceValidationError["code"],
  message: string,
): FinanceValidationError {
  return {
    statusCode: 400,
    code,
    category: "validation",
    message,
  };
}
