import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  CancellationPolicy,
  FinanceCommandMeta,
  FinanceFinancialSummary,
  FinanceInvoiceDetail,
  FinanceInvoiceListItem,
  FinanceInvoiceListQuery,
  FinanceInvoicePayment,
  FinanceInvoiceStatusCounts,
  FinanceManualPaymentRecordCommand,
  FinanceManualPaymentRecordResult,
  FinancePaymentLedgerItem,
  FinancePaymentLedgerQuery,
  FinancePaymentSettingsReadModel,
  FinancePropertyReadRepository,
} from "@vayada/domain-finance";
import { buildManualPaymentProjectionJobIdempotencyKey } from "@vayada/domain-finance";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { PublicHotelProfileRepository } from "./routes/aiHotels.js";
import {
  createTargetFinancePropertySettingsRepository,
  type FinancePublicHotelPropertyResolver,
} from "./routes/finance.js";

const propertyId = "f3000000-0000-0000-0000-000000000686";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const financeContractCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/finance-route-contracts/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    request: {
      path: string;
      method?: string;
      query?: Record<string, string | number>;
      body?: Record<string, unknown>;
    };
    expected: {
      status: number;
      itemCount?: number;
      stableOrdering?: string;
      mustInclude?: string[];
      mustExclude?: string[];
      errorCode?: string;
      commandMeta?: { sideEffects?: string[] };
      enums?: Record<string, string[]>;
    };
  }>;
};

const session: VerifiedSession = {
  workosUserId: "workos_finance_user",
  workosOrgId: "workos_finance_org",
  sessionId: "session_finance",
  expiresAt: futureExpiry,
};

const paymentSettings: FinancePaymentSettingsReadModel = {
  propertyId,
  paymentsEnabled: true,
  paymentProvider: "stripe",
  acceptedMethods: ["card", "pay_at_property", "bank_transfer"],
  defaultCurrency: "EUR",
  supportedCurrencies: ["EUR"],
  depositPolicy: {
    depositPercent: 25,
    summary: "25% deposit due at checkout.",
  },
  refundPolicy: {
    freeCancellationDays: 7,
    partialRefundPercent: 50,
    refundMethod: "original_payment",
    appliesTo: "direct_booking",
  },
  taxPolicy: { taxIncluded: true },
  statementDescriptor: "ALPENROSE",
  requiresManualReview: false,
  providerAccount: {
    providerAccountId: "acct_target_alpenrose",
    provider: "stripe",
    status: "active",
    onboardingStatus: "completed",
    chargesEnabled: true,
    payoutsEnabled: true,
    capabilities: ["card_payments", "transfers"],
  },
  sourceFreshness: {
    finance: "target",
    status: "fresh",
  },
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const cancellationPolicy: CancellationPolicy = {
  freeCancellationDays: 7,
  partialRefundPercent: 50,
  refundMethod: "original_payment",
  appliesTo: "direct_booking",
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const sourceFreshness = {
  finance: {
    status: "fresh",
    projectedAt: "2026-06-12T10:00:00.000Z",
  },
};

const invoicePayments: FinanceInvoicePayment[] = [
  {
    paymentId: "pay_manual_002",
    method: "cash",
    methodLabel: "Cash",
    amount: "100.00",
    currency: "EUR",
    reference: "front desk receipt 8814",
    status: "paid",
    recordedAt: "2026-06-12T10:08:00.000Z",
  },
  {
    paymentId: "pay_manual_001",
    method: "cash",
    methodLabel: "Cash",
    amount: "250.00",
    currency: "EUR",
    reference: "front desk receipt 8812",
    status: "paid",
    recordedAt: "2026-06-12T10:05:00.000Z",
  },
];

const invoiceListItems: FinanceInvoiceListItem[] = [
  {
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    guest: { displayName: "Fi Guest", email: "finance.guest@example.test" },
    stay: {
      checkIn: "2026-08-01",
      checkOut: "2026-08-05",
      roomName: "Alpine Suite",
      roomNumber: "201",
    },
    currency: "EUR",
    totalAmount: "1200.00",
    amountPaid: "350.00",
    balanceDue: "850.00",
    status: "partial",
    issuedAt: "2026-06-12T10:00:00.000Z",
  },
  {
    invoiceId: "inv_2026_wxyz",
    invoiceNumber: "INV-2026-0001",
    guestBookingId: "f6000000-0000-0000-0000-000000000687",
    bookingReference: "B-FIN-687",
    guest: { displayName: "Ana Ledger", email: "ledger@example.test" },
    stay: {
      checkIn: "2026-08-10",
      checkOut: "2026-08-12",
      roomName: "Garden Room",
      roomNumber: "102",
    },
    currency: "EUR",
    totalAmount: "500.00",
    amountPaid: "200.00",
    balanceDue: "300.00",
    status: "partial",
    issuedAt: "2026-06-12T09:00:00.000Z",
  },
];

const invoiceDetails: FinanceInvoiceDetail[] = [
  {
    ...invoiceListItems[0]!,
    guest: {
      ...invoiceListItems[0]!.guest,
      phone: "+15555550123",
    },
    nights: 4,
    charges: [{ description: "Stay", detail: "4 nights in Alpine Suite", amount: "1200.00" }],
    payments: invoicePayments,
    subtotal: "1200.00",
  },
  {
    ...invoiceListItems[1]!,
    guest: {
      ...invoiceListItems[1]!.guest,
      phone: null,
    },
    nights: 2,
    charges: [{ description: "Stay", detail: "2 nights in Garden Room", amount: "500.00" }],
    payments: [invoicePayments[1]!],
    subtotal: "500.00",
  },
];

const paymentLedgerItems: FinancePaymentLedgerItem[] = [
  {
    ...invoicePayments[0]!,
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    checkoutChargeId: "charge_checkout_002",
    provider: "manual",
    providerStatus: "paid",
    reconciliationStatus: "matched",
  },
  {
    ...invoicePayments[1]!,
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    checkoutChargeId: "charge_checkout_001",
    provider: "manual",
    providerStatus: "paid",
    reconciliationStatus: "matched",
  },
];

const financialSummary: FinanceFinancialSummary = {
  currency: "EUR",
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  grossPaymentAmount: "1700.00",
  netPaymentAmount: "1650.00",
  payoutAmount: "1400.00",
  commissionAmount: "50.00",
  outstandingBalanceAmount: "1150.00",
  paymentCount: 2,
  payoutCount: 1,
  failedPaymentCount: 0,
  invoiceCounts: {
    draft: 0,
    sent: 0,
    paid: 0,
    partial: 2,
    overdue: 0,
    voided: 0,
  },
  paymentCounts: {
    requires_action: 0,
    authorized: 0,
    pending: 0,
    paid: 2,
    partially_refunded: 0,
    refunded: 0,
    failed: 0,
    canceled: 0,
    disputed: 0,
  },
  projectedAt: "2026-06-12T10:00:00.000Z",
};

let app: ReturnType<typeof buildApp> | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("finance route contracts", () => {
  it("passes F1b payment-settings read and public projection fixture cases in target mode", async () => {
    app = buildFinanceApp();

    for (const caseId of ["payment-settings-read", "public-payment-capability-projection"]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        headers: caseId === "payment-settings-read" ? { authorization: "Bearer valid-token" } : {},
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], caseId);
      assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], caseId);
      assertEnums(response.body, contractCase!.expected.enums ?? {}, caseId);
    }
  });

  it("passes F1c invoice and payment ledger fixture cases in target mode", async () => {
    app = buildFinanceApp();

    for (const caseId of ["invoice-list-read", "invoice-detail-read", "payment-ledger-read"]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        query: queryStrings(contractCase!.request.query),
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      if (contractCase!.expected.itemCount !== undefined) {
        const list =
          caseId === "payment-ledger-read" ? response.body.payments : response.body.invoices;
        expect(list, caseId).toHaveLength(contractCase!.expected.itemCount);
      }
      assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], caseId);
      assertExcludes(response.body, contractCase!.expected.mustExclude ?? [], caseId);
      expect(JSON.stringify(response.body), caseId).not.toMatch(
        /providerPayloadRaw|providerPaymentIntentSecret|cardFingerprint|processorFeeBreakdown|guestBirthDate|privatePmsNotes|providerPaymentIntentId|booking_guests/,
      );
    }
  });

  it("passes the F1d manual payment record fixture in target mode", async () => {
    const repository = manualPaymentRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });
    const contractCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "manual-payment-record-command",
    );
    expect(contractCase).toBeDefined();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(contractCase!.expected.status);
    assertIncludes(response.body, contractCase!.expected.mustInclude ?? [], contractCase!.caseId);
    expect(response.body.commandMeta).toMatchObject({
      idempotencyKey: "finance-manual-payment-inv-2026-abcd-001",
      sideEffects: ["audit_event", "booking_projection_refresh", "pms_projection_refresh"],
      jobs: [
        {
          jobType: "booking.projection-refresh",
          status: "queued",
        },
        {
          jobType: "pms.projection-refresh",
          status: "queued",
        },
      ],
    });
    expect(repository.writeCount).toBe(1);
    expect(repository.outboxEnqueueCount).toBe(2);
    expect(JSON.stringify(response.body)).not.toMatch(/Stripe API|Xendit API|Channex API/);
  });

  it("replays the F1d manual payment idempotency key without duplicate side effects", async () => {
    const repository = manualPaymentRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });
    const contractCase = financeContractCases.cases.find(
      (candidate) => candidate.caseId === "manual-payment-record-command-idempotency-replay",
    );
    expect(contractCase).toBeDefined();

    const first = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });
    const replay = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: contractCase!.request.path,
      payload: contractCase!.request.body,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(contractCase!.expected.status);
    expect(readContractPath(first.body, "invoice.payments[0].paymentId")).toBe(
      readContractPath(replay.body, "invoice.payments[0].paymentId"),
    );
    expect(readContractPath(replay.body, "commandMeta.jobs[0].status")).toBe("idempotent_replay");
    expect(repository.writeCount).toBe(1);
    expect(repository.outboxEnqueueCount).toBe(2);
  });

  it("passes the contracted F1d manual payment validation error cases", async () => {
    const repository = manualPaymentValidationRepository();
    app = buildFinanceApp({
      repository,
      permissions: financeManagePermissions(),
    });

    for (const caseId of [
      "manual-payment-record-command-currency-mismatch",
      "manual-payment-record-command-overpayment",
      "manual-payment-record-command-no-balance",
      "manual-payment-record-command-paid-invoice",
      "manual-payment-record-command-voided-invoice",
      "manual-payment-record-command-amount-out-of-range",
    ]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "POST",
        url: contractCase!.request.path,
        payload: contractCase!.request.body,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      expect(response.body.code, caseId).toBe(contractCase!.expected.errorCode);
    }

    expect(repository.writeCount).toBe(0);
    expect(repository.recordAttempts).toBe(5);
  });

  it("validates target manual payment invoices before reserving or inserting rows", async () => {
    const cases: Array<{
      name: string;
      command?: Partial<FinanceManualPaymentRecordCommand["payload"]>;
      invoice?: Partial<TargetFinanceInvoiceRow>;
      message: string;
    }> = [
      {
        name: "currency mismatch",
        command: { currency: "USD" },
        message: "currency must match",
      },
      {
        name: "overpayment",
        command: { amount: "900.00" },
        message: "cannot exceed invoice balance",
      },
      {
        name: "no balance",
        invoice: { balanceDue: "0.00" },
        message: "no balance due",
      },
      {
        name: "paid invoice",
        invoice: { status: "paid", balanceDue: "0.00" },
        message: "paid or voided",
      },
      {
        name: "voided invoice",
        invoice: { status: "voided" },
        message: "paid or voided",
      },
      {
        name: "out-of-range amount",
        command: { amount: "10000000000000.00" },
        message: "NUMERIC(15,2)",
      },
    ];

    for (const validationCase of cases) {
      const { pool, queries } = targetManualPaymentPool({
        invoice: targetInvoiceRow(validationCase.invoice),
      });
      const repository = createTargetFinancePropertySettingsRepository({
        connectionString: "postgresql://finance-target",
        pool,
      });

      const result = await repository.recordManualPayment!(
        manualPaymentCommand({ payload: validationCase.command }),
      );

      expect(result.ok, validationCase.name).toBe(false);
      if (!result.ok) {
        expect(result.statusCode, validationCase.name).toBe(400);
        expect(result.code, validationCase.name).toBe("invalid_command");
        expect(result.message, validationCase.name).toContain(validationCase.message);
      }
      const dataQueries = queries.filter(
        (query) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(query.text),
      );
      expect(dataQueries, validationCase.name).toHaveLength(2);
      expect(
        queries.some((query) => query.text.includes("INSERT INTO")),
        validationCase.name,
      ).toBe(false);
      expect(
        queries.some((query) => query.text.includes("INSERT INTO platform.idempotency_keys")),
        validationCase.name,
      ).toBe(false);
    }
  });

  it("persists tenant-safe manual payment keys and schema-valid property platform rows", async () => {
    const clientIdempotencyKey = "shared-front-desk-key";
    const first = await recordTargetManualPayment({
      propertyId,
      idempotencyKey: clientIdempotencyKey,
    });
    const second = await recordTargetManualPayment({
      propertyId: "f3000000-0000-0000-0000-000000000999",
      idempotencyKey: clientIdempotencyKey,
    });

    expect(first.result.ok).toBe(true);
    expect(second.result.ok).toBe(true);

    const firstKeys = successfulManualPaymentKeys(first.queries);
    const secondKeys = successfulManualPaymentKeys(second.queries);

    expect(firstKeys.paymentKey).not.toBe(secondKeys.paymentKey);
    expect(firstKeys.paymentKey).toContain(`property:${propertyId}:payment:`);
    expect(secondKeys.paymentKey).toContain(
      "property:f3000000-0000-0000-0000-000000000999:payment:",
    );

    for (const key of Object.values(firstKeys)) {
      expect(String(key)).not.toContain(clientIdempotencyKey);
      expect(String(key)).toContain(`property:${propertyId}`);
    }

    expect(first.result.ok && first.result.commandMeta.idempotencyKey).toBe(clientIdempotencyKey);
    expect(first.result.ok && first.result.commandMeta.outboxEvents).toEqual([
      firstKeys.bookingOutboxKey,
      firstKeys.pmsOutboxKey,
    ]);

    const idempotencyInsert = findQuery(first.queries, "INSERT INTO platform.idempotency_keys");
    const domainEventInsert = findQuery(first.queries, "INSERT INTO platform.domain_events");
    const outboxInsert = findQuery(first.queries, "INSERT INTO platform.outbox_events");
    const jobsInsert = findQuery(first.queries, "INSERT INTO platform.jobs");
    const auditInsert = findQuery(first.queries, "INSERT INTO platform.product_audit_events");
    const paymentInsert = findQuery(first.queries, "INSERT INTO finance.payments");
    const idempotencyUpdate = findQuery(first.queries, "UPDATE platform.idempotency_keys");
    const idempotencyReplayLookup = findQuery(
      first.queries,
      "FROM platform.idempotency_keys idempotency",
    );

    expect(idempotencyInsert.values[2]).toBeNull();
    expect(domainEventInsert.values[2]).toBeNull();
    expect(outboxInsert.values[2]).toBeNull();
    expect(jobsInsert.values[3]).toBeNull();
    expect(auditInsert.values[2]).toBeNull();

    for (const query of [
      idempotencyInsert,
      domainEventInsert,
      outboxInsert,
      jobsInsert,
      auditInsert,
    ]) {
      expect(query.text).toContain("'property'");
    }

    expect(paymentInsert.text).toContain("WHERE property_id = $1::uuid");
    expect(paymentInsert.text).toContain("AND idempotency_key = $4");
    expect(idempotencyReplayLookup.text).toContain("AND payment.idempotency_key = $3");
    expect(idempotencyReplayLookup.text).toContain("AND idempotency.tenant_scope = 'property'");
    expect(idempotencyReplayLookup.text).toContain("AND idempotency.property_id = $2::uuid");
    expect(idempotencyUpdate.text).toContain("AND tenant_scope = 'property'");
    expect(idempotencyUpdate.text).toContain("AND property_id = $7::uuid");
  });

  it("returns financial summary with source freshness from the Finance read model", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/summary`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      propertyId,
      summary: {
        currency: "EUR",
        grossPaymentAmount: "1700.00",
        outstandingBalanceAmount: "1150.00",
        invoiceCounts: { partial: 2 },
        paymentCounts: { paid: 2 },
      },
      sourceFreshness,
    });
  });

  it("returns a CSV export disposition instead of streaming a legacy export", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/invoices/export.csv`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      propertyId,
      export: {
        status: "queued",
        disposition: "durable_export_job",
        filename: `finance-invoices-${propertyId}.csv`,
        contentType: "text/csv",
      },
    });
  });

  it("supports invoice search, sort, and pagination over the target read model", async () => {
    app = buildFinanceApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/invoices`,
      query: { search: "ledger", sort: "guest", limit: "1", offset: "0" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      limit: 1,
      offset: 0,
      invoices: [{ invoiceId: "inv_2026_wxyz", guest: { displayName: "Ana Ledger" } }],
    });
  });

  it("returns empty states for finance ledger reads without treating setup as an error", async () => {
    app = buildFinanceApp({ repository: emptyFinanceRepository });

    const [summary, invoices, payments] = await Promise.all([
      injectJson(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/summary`,
        headers: { authorization: "Bearer valid-token" },
      }),
      injectJson(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/invoices`,
        headers: { authorization: "Bearer valid-token" },
      }),
      injectJson(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/payments`,
        headers: { authorization: "Bearer valid-token" },
      }),
    ]);

    expect(summary.body).toMatchObject({
      summary: { grossPaymentAmount: "0.00", invoiceCounts: { partial: 0 } },
    });
    expect(invoices.body).toMatchObject({ invoices: [], total: 0, counts: { partial: 0 } });
    expect(payments.body).toMatchObject({ payments: [], total: 0, counts: { paid: 0 } });
  });

  it("returns cancellation policy reads from the Finance repository", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/finance/properties/${propertyId}/cancellation-policy`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      propertyId,
      policy: {
        freeCancellationDays: 7,
        partialRefundPercent: 50,
        refundMethod: "original_payment",
        appliesTo: "direct_booking",
      },
    });
  });

  it("serves the public projection from the finance-specific target profile repository", async () => {
    app = buildFinanceApp({
      publicHotelProfileRepository: null,
      financePublicHotelProfileRepository: publicHotelProfileRepository,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentMethods: ["card", "pay_at_property", "bank_transfer"],
      defaultCurrency: "EUR",
    });
  });

  it("uses the canonical target property id for public finance settings reads", async () => {
    const requestedPropertyIds: string[] = [];
    app = buildFinanceApp({
      publicHotelProfileRepository: null,
      financePublicHotelProfileRepository: {
        async findProfileBySlug(slug) {
          if (slug !== "hotel-alpenrose") return null;
          return {
            hotel: {
              propertyId: "prop_distribution_alpenrose",
              slug: "hotel-alpenrose",
            },
          } as PublicBookabilityProfileProjection;
        },
      },
      financePublicHotelPropertyResolver: {
        async findPropertyIdBySlug(slug) {
          return slug === "hotel-alpenrose" ? propertyId : null;
        },
      },
      repository: {
        async getPaymentSettings(requestedPropertyId) {
          requestedPropertyIds.push(requestedPropertyId);
          return requestedPropertyId === propertyId ? paymentSettings : null;
        },
        async getCancellationPolicy(requestedPropertyId) {
          requestedPropertyIds.push(requestedPropertyId);
          return requestedPropertyId === propertyId ? cancellationPolicy : null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(requestedPropertyIds).toEqual([propertyId, propertyId]);
    expect(JSON.stringify(response.body)).not.toContain("prop_distribution_alpenrose");
  });

  it("removes sensitive policy keys from the unauthenticated public projection", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            depositPolicy: {
              depositPercent: 25,
              summary: "25% deposit due at checkout.",
              bankTransferInstructions: "IBAN PRIVATE",
              internalNotes: "Call finance before accepting.",
              providerSecret: "secret_ref",
            },
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/payment-settings",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      depositPolicy: {
        depositPercent: 25,
        summary: "25% deposit due at checkout.",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /bankTransferInstructions|IBAN PRIVATE|internalNotes|providerSecret|secret_ref/,
    );
  });

  it("serves the PMS compatibility payment-settings facade without bank secrets", async () => {
    app = buildFinanceApp();

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        payAtPropertyEnabled: true,
        onlineCardPayment: true,
        bankTransfer: true,
        xenditPaymentsEnabled: false,
        defaultCurrency: "EUR",
      },
      cancellationPolicy: {
        freeCancellationDays: 7,
        partialRefundPct: 50,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("acct_target_alpenrose");
  });

  it("does not expose PMS compatibility payment methods when payments are disabled", async () => {
    app = buildFinanceApp({
      repository: {
        async getPaymentSettings() {
          return {
            ...paymentSettings,
            paymentsEnabled: false,
          };
        },
        async getCancellationPolicy() {
          return cancellationPolicy;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${propertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        payAtPropertyEnabled: false,
        onlineCardPayment: false,
        bankTransfer: false,
        xenditPaymentsEnabled: false,
      },
    });
  });

  it("reads requires_manual_review from the target payment settings row", async () => {
    const repository = createTargetFinancePropertySettingsRepository({
      connectionString: "postgresql://finance-target",
      pool: {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          expect(text).toContain('settings.requires_manual_review AS "requiresManualReview"');
          expect(values).toEqual([propertyId]);
          return {
            rows: [
              {
                propertyId,
                paymentsEnabled: true,
                acceptedMethods: ["card"],
                defaultCurrency: "EUR",
                depositPolicy: {},
                refundPolicy: {},
                taxPolicy: {},
                statementDescriptor: "ALPENROSE",
                requiresManualReview: true,
                updatedAt: "2026-06-12T10:00:00.000Z",
                providerAccountId: "acct_target_alpenrose",
                provider: "stripe",
                providerStatus: "active",
                providerOnboardingStatus: "completed",
                chargesEnabled: true,
                payoutsEnabled: true,
                providerCapabilities: ["card_payments"],
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
    });

    await expect(repository.getPaymentSettings(propertyId)).resolves.toMatchObject({
      requiresManualReview: true,
      providerAccount: { status: "active" },
    });
  });

  it("passes the Finance property read denial matrix", async () => {
    const cases: Array<{
      name: string;
      auth?: string;
      permissions?: PermissionKey[];
      entitlements?: ProductEntitlement[];
      linkedPropertyId?: string | null;
      linkedResourceType?: "pms_property" | "property";
      expectedStatus: number;
      expectedCode: string;
    }> = [
      {
        name: "missing auth",
        auth: undefined,
        expectedStatus: 401,
        expectedCode: "unauthenticated",
      },
      {
        name: "invalid auth",
        auth: "Bearer invalid-token",
        expectedStatus: 401,
        expectedCode: "unauthenticated",
      },
      {
        name: "missing permission",
        auth: "Bearer valid-token",
        permissions: ["pms.operations.read"],
        expectedStatus: 403,
        expectedCode: "missing_permission",
      },
      {
        name: "missing entitlement",
        auth: "Bearer valid-token",
        entitlements: [],
        expectedStatus: 403,
        expectedCode: "missing_entitlement",
      },
      {
        name: "inactive entitlement",
        auth: "Bearer valid-token",
        entitlements: [{ ...pmsFinanceEntitlement(), status: "suspended" }],
        expectedStatus: 403,
        expectedCode: "inactive_entitlement",
      },
      {
        name: "missing linked resource",
        auth: "Bearer valid-token",
        linkedPropertyId: null,
        expectedStatus: 403,
        expectedCode: "missing_resource_access",
      },
      {
        name: "allowed access",
        auth: "Bearer valid-token",
        expectedStatus: 200,
        expectedCode: "",
      },
      {
        name: "allowed canonical property access",
        auth: "Bearer valid-token",
        entitlements: [pmsFinanceEntitlement("property")],
        linkedResourceType: "property",
        expectedStatus: 200,
        expectedCode: "",
      },
      {
        name: "allowed direct-booking finance access",
        auth: "Bearer valid-token",
        entitlements: [directBookingFinanceEntitlement("property")],
        linkedResourceType: "property",
        expectedStatus: 200,
        expectedCode: "",
      },
    ];

    for (const matrixCase of cases) {
      app = buildFinanceApp({
        permissions: matrixCase.permissions,
        entitlements: matrixCase.entitlements,
        linkedPropertyId: matrixCase.linkedPropertyId,
        linkedResourceType: matrixCase.linkedResourceType,
      });
      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: `/api/finance/properties/${propertyId}/payment-settings`,
        headers: matrixCase.auth ? { authorization: matrixCase.auth } : {},
      });
      await app.close();
      app = null;

      expect(response.statusCode, matrixCase.name).toBe(matrixCase.expectedStatus);
      if (matrixCase.expectedCode) {
        expect(response.body.code, matrixCase.name).toBe(matrixCase.expectedCode);
      }
    }
  });

  it("keeps the existing finance fixture authorization cases aligned", async () => {
    for (const caseId of [
      "authorization-denial-matrix-missing-permission",
      "authorization-denial-matrix-missing-resource",
    ]) {
      const contractCase = financeContractCases.cases.find(
        (candidate) => candidate.caseId === caseId,
      );
      expect(contractCase, caseId).toBeDefined();

      app = buildFinanceApp(
        caseId.endsWith("missing-permission")
          ? { permissions: ["pms.operations.read"] }
          : { linkedPropertyId: null },
      );
      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url: contractCase!.request.path,
        headers: { authorization: "Bearer valid-token" },
      });
      await app.close();
      app = null;

      expect(response.statusCode, caseId).toBe(contractCase!.expected.status);
      expect(response.body.code, caseId).toBe(contractCase!.expected.errorCode);
    }
  });
});

function buildFinanceApp(
  options: {
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    linkedPropertyId?: string | null;
    linkedResourceType?: "pms_property" | "property";
    repository?: FinancePropertyReadRepository;
    publicHotelProfileRepository?: PublicHotelProfileRepository | null;
    financePublicHotelProfileRepository?: PublicHotelProfileRepository;
    financePublicHotelPropertyResolver?: FinancePublicHotelPropertyResolver;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    publicHotelProfileRepository:
      options.publicHotelProfileRepository === null
        ? undefined
        : (options.publicHotelProfileRepository ?? publicHotelProfileRepository),
    financePublicHotelProfileRepository: options.financePublicHotelProfileRepository,
    financePublicHotelPropertyResolver: options.financePublicHotelPropertyResolver,
    financeRepository: options.repository ?? financeRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linkedPropertyId, options.linkedResourceType),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["pms.finance.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [pmsFinanceEntitlement()];
        },
      },
    },
  });
}

const publicHotelProfileRepository: PublicHotelProfileRepository = {
  async findProfileBySlug(slug) {
    if (slug !== "hotel-alpenrose") return null;
    return {
      hotel: {
        propertyId,
        slug: "hotel-alpenrose",
      },
    } as PublicBookabilityProfileProjection;
  },
};

const financeRepository: FinancePropertyReadRepository = {
  async getPaymentSettings(requestedPropertyId) {
    return requestedPropertyId === propertyId ? paymentSettings : null;
  },
  async getCancellationPolicy(requestedPropertyId) {
    return requestedPropertyId === propertyId ? cancellationPolicy : null;
  },
  async getFinancialSummary(requestedPropertyId) {
    if (requestedPropertyId !== propertyId) return null;
    return {
      summary: financialSummary,
      sourceFreshness,
    };
  },
  async listInvoices(requestedPropertyId, query) {
    const filtered = requestedPropertyId === propertyId ? filterInvoices(query) : [];
    return {
      invoices: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      counts: invoiceCounts(invoiceListItems),
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async getInvoice(requestedPropertyId, invoiceId) {
    if (requestedPropertyId !== propertyId) return null;
    const invoice = invoiceDetails.find((candidate) => candidate.invoiceId === invoiceId);
    return invoice ? { invoice, sourceFreshness } : null;
  },
  async listPayments(requestedPropertyId, query) {
    const filtered = requestedPropertyId === propertyId ? filterPayments(query) : [];
    return {
      payments: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
      counts: {
        requires_action: 0,
        authorized: 0,
        pending: 0,
        paid: paymentLedgerItems.filter((item) => item.status === "paid").length,
        partially_refunded: 0,
        refunded: 0,
        failed: 0,
        canceled: 0,
        disputed: 0,
      },
      limit: query.limit,
      offset: query.offset,
      sourceFreshness,
    };
  },
  async getInvoiceCsvExportDisposition(requestedPropertyId) {
    return {
      export: {
        status: "queued",
        disposition: "durable_export_job",
        filename: `finance-invoices-${requestedPropertyId}.csv`,
        contentType: "text/csv",
        downloadUrl: null,
        jobId: "job_finance_invoice_export_686",
        message: "Invoice CSV export runs through the Finance read-model export job.",
      },
      sourceFreshness,
    };
  },
};

function manualPaymentRepository(): FinancePropertyReadRepository & {
  writeCount: number;
  outboxEnqueueCount: number;
} {
  const records = new Map<string, FinanceManualPaymentRecordResult & { ok: true }>();
  const repository: FinancePropertyReadRepository & {
    writeCount: number;
    outboxEnqueueCount: number;
  } = {
    ...financeRepository,
    writeCount: 0,
    outboxEnqueueCount: 0,
    async recordManualPayment(command) {
      if (command.propertyId !== propertyId || command.payload.invoiceId !== "inv_2026_abcd") {
        return {
          ok: false,
          statusCode: 404,
          code: "invoice_not_found",
          message: "Finance invoice was not found.",
        };
      }

      const existing = records.get(command.idempotencyKey);
      if (existing) {
        return {
          ...existing,
          status: "idempotent_replay",
          commandMeta: {
            ...existing.commandMeta,
            jobs: existing.commandMeta.jobs.map((job) => ({
              ...job,
              status: "idempotent_replay",
            })),
          },
        };
      }

      repository.writeCount += 1;
      repository.outboxEnqueueCount += 2;
      const commandMeta = manualPaymentCommandMeta(command, "queued");
      const result = {
        ok: true,
        status: "created",
        invoice: invoiceDetails[0]!,
        commandMeta,
      } satisfies FinanceManualPaymentRecordResult & { ok: true };
      records.set(command.idempotencyKey, result);
      return result;
    },
  };
  return repository;
}

function manualPaymentValidationRepository(): FinancePropertyReadRepository & {
  writeCount: number;
  recordAttempts: number;
} {
  const repository: FinancePropertyReadRepository & {
    writeCount: number;
    recordAttempts: number;
  } = {
    ...financeRepository,
    writeCount: 0,
    recordAttempts: 0,
    async recordManualPayment(command) {
      repository.recordAttempts += 1;
      const invoice = validationInvoice(command.payload.invoiceId);
      if (!invoice) {
        return {
          ok: false,
          statusCode: 404,
          code: "invoice_not_found",
          message: "Finance invoice was not found.",
        };
      }
      if (command.payload.currency !== invoice.currency) {
        return invalidManualPaymentResult("Manual payment currency must match invoice currency.");
      }
      if (invoice.status === "paid" || invoice.status === "voided") {
        return invalidManualPaymentResult(
          "Manual payment cannot be recorded for paid or voided invoices.",
        );
      }
      if (Number(invoice.balanceDue) === 0) {
        return invalidManualPaymentResult(
          "Manual payment cannot be recorded when the invoice has no balance due.",
        );
      }
      if (Number(command.payload.amount) > Number(invoice.balanceDue)) {
        return invalidManualPaymentResult("Manual payment amount cannot exceed invoice balance.");
      }
      return invalidManualPaymentResult("Validation fixture unexpectedly reached write path.");
    },
  };
  return repository;
}

function validationInvoice(
  invoiceId: string,
): { currency: string; balanceDue: string; status: "partial" | "paid" | "voided" } | null {
  if (invoiceId === "inv_2026_abcd") {
    return { currency: "EUR", balanceDue: "850.00", status: "partial" };
  }
  if (invoiceId === "inv_2026_no_balance") {
    return { currency: "EUR", balanceDue: "0.00", status: "partial" };
  }
  if (invoiceId === "inv_2026_paid") {
    return { currency: "EUR", balanceDue: "0.00", status: "paid" };
  }
  if (invoiceId === "inv_2026_voided") {
    return { currency: "EUR", balanceDue: "850.00", status: "voided" };
  }
  return null;
}

function invalidManualPaymentResult(message: string): FinanceManualPaymentRecordResult {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_command",
    message,
  };
}

type RecordedFinanceQuery = {
  text: string;
  values: unknown[];
};

type TargetFinanceInvoiceRow = {
  invoiceId: string;
  invoiceNumber: string;
  guestBookingId: string;
  bookingReference: string;
  guestDisplayName: string;
  guestEmail: string;
  guestPhone: string | null;
  checkIn: string;
  checkOut: string;
  roomName: string;
  roomNumber: string;
  currency: string;
  totalAmount: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
  issuedAt: string;
  total: string;
  counts: Record<string, number>;
  sourceFreshness: typeof sourceFreshness;
};

function targetInvoiceRow(
  overrides: Partial<TargetFinanceInvoiceRow> = {},
): TargetFinanceInvoiceRow {
  return {
    invoiceId: "inv_2026_abcd",
    invoiceNumber: "INV-2026-0002",
    guestBookingId: "f6000000-0000-0000-0000-000000000686",
    bookingReference: "B-FIN-686",
    guestDisplayName: "Fi Guest",
    guestEmail: "finance.guest@example.test",
    guestPhone: "+15555550123",
    checkIn: "2026-08-01",
    checkOut: "2026-08-05",
    roomName: "Alpine Suite",
    roomNumber: "201",
    currency: "EUR",
    totalAmount: "1200.00",
    amountPaid: "350.00",
    balanceDue: "850.00",
    status: "partial",
    issuedAt: "2026-06-12T10:00:00.000Z",
    total: "1",
    counts: { partial: 1 },
    sourceFreshness,
    ...overrides,
  };
}

function manualPaymentCommand(
  options: {
    propertyId?: string;
    idempotencyKey?: string;
    payload?: Partial<FinanceManualPaymentRecordCommand["payload"]>;
  } = {},
): FinanceManualPaymentRecordCommand {
  return {
    commandType: "finance.manual_payment.record",
    commandId: "cmd-manual-payment-target-test",
    idempotencyKey: options.idempotencyKey ?? "finance-manual-payment-target-test",
    propertyId: options.propertyId ?? propertyId,
    audit: {
      actor: {
        kind: "user",
        userId: "f1000000-0000-0000-0000-000000000686",
        organizationId: "f2000000-0000-0000-0000-000000000686",
      },
      requestId: "req_manual_payment_target_test",
      correlationId: "corr_manual_payment_target_test",
      reason: "Manual payment recorded by property finance user",
      requestedAt: "2026-06-12T12:00:00.000Z",
    },
    payload: {
      invoiceId: "inv_2026_abcd",
      amount: "250.00",
      currency: "EUR",
      paymentMethod: "cash",
      reference: "front desk receipt target test",
      ...options.payload,
    },
  };
}

function targetManualPaymentPool(input: { invoice: TargetFinanceInvoiceRow }): {
  pool: {
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
  queries: RecordedFinanceQuery[];
} {
  const queries: RecordedFinanceQuery[] = [];
  return {
    queries,
    pool: {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        queries.push({ text, values: Array.from(values) });
        if (text.includes("WITH invoice_base AS")) {
          return { rows: [input.invoice as unknown as T] };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return {
            rows: [
              {
                status: "in_progress",
                requestFingerprintHash: values[1],
              } as unknown as T,
            ],
          };
        }
        if (text.includes("INSERT INTO finance.payments")) {
          return { rows: [{ paymentId: "pay_target_manual_001", replay: false } as unknown as T] };
        }
        if (text.includes("INSERT INTO platform.domain_events")) {
          return { rows: [{ eventId: "evt_target_manual_001" } as unknown as T] };
        }
        if (text.includes("INSERT INTO platform.outbox_events")) {
          return {
            rows: [
              {
                destination: "booking.projection-refresh",
                outboxEventId: "outbox_target_booking_001",
              } as unknown as T,
              {
                destination: "pms.projection-refresh",
                outboxEventId: "outbox_target_pms_001",
              } as unknown as T,
            ],
          };
        }
        if (text.includes("FROM platform.idempotency_keys idempotency")) {
          return { rows: [] as T[] };
        }
        if (text.includes("FROM finance.payments payment")) {
          return {
            rows: [
              {
                paymentId: "pay_target_manual_001",
                method: "cash",
                amount: "250.00",
                currency: "EUR",
                reference: "front desk receipt target test",
                status: "paid",
                recordedAt: "2026-06-12T12:00:00.000Z",
              } as unknown as T,
            ],
          };
        }
        return { rows: [] };
      },
      async end() {},
    },
  };
}

async function recordTargetManualPayment(input: {
  propertyId: string;
  idempotencyKey: string;
}): Promise<{
  result: FinanceManualPaymentRecordResult;
  queries: RecordedFinanceQuery[];
}> {
  const { pool, queries } = targetManualPaymentPool({ invoice: targetInvoiceRow() });
  const repository = createTargetFinancePropertySettingsRepository({
    connectionString: "postgresql://finance-target",
    pool,
  });
  const result = await repository.recordManualPayment!(
    manualPaymentCommand({
      propertyId: input.propertyId,
      idempotencyKey: input.idempotencyKey,
    }),
  );
  return { result, queries };
}

function successfulManualPaymentKeys(queries: RecordedFinanceQuery[]): {
  paymentKey: string;
  domainEventKey: string;
  bookingOutboxKey: string;
  pmsOutboxKey: string;
  bookingJobKey: string;
  pmsJobKey: string;
  auditKey: string;
} {
  const paymentInsert = findQuery(queries, "INSERT INTO finance.payments");
  const domainEventInsert = findQuery(queries, "INSERT INTO platform.domain_events");
  const outboxInsert = findQuery(queries, "INSERT INTO platform.outbox_events");
  const jobsInsert = findQuery(queries, "INSERT INTO platform.jobs");
  const auditInsert = findQuery(queries, "INSERT INTO platform.product_audit_events");
  return {
    paymentKey: String(paymentInsert.values[3]),
    domainEventKey: String(domainEventInsert.values[0]),
    bookingOutboxKey: String(outboxInsert.values[1]),
    pmsOutboxKey: String(outboxInsert.values[9]),
    bookingJobKey: String(jobsInsert.values[0]),
    pmsJobKey: String(jobsInsert.values[10]),
    auditKey: String(auditInsert.values[0]),
  };
}

function findQuery(queries: RecordedFinanceQuery[], fragment: string): RecordedFinanceQuery {
  const query = queries.find((candidate) => candidate.text.includes(fragment));
  expect(query, fragment).toBeDefined();
  return query!;
}

function manualPaymentCommandMeta(
  command: FinanceManualPaymentRecordCommand,
  jobStatus: "queued" | "idempotent_replay",
): FinanceCommandMeta {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    sideEffects: ["audit_event", "booking_projection_refresh", "pms_projection_refresh"],
    outboxEvents: [
      manualPaymentScopedKey(command, "booking-outbox"),
      manualPaymentScopedKey(command, "pms-outbox"),
    ],
    jobs: [
      {
        jobType: "booking.projection-refresh",
        idempotencyKey: buildManualPaymentProjectionJobIdempotencyKey({
          jobType: "booking.projection-refresh",
          propertyId: command.propertyId,
          guestBookingId: invoiceDetails[0]!.guestBookingId,
          paymentIdempotencyKey: command.idempotencyKey,
        }),
        status: jobStatus,
      },
      {
        jobType: "pms.projection-refresh",
        idempotencyKey: buildManualPaymentProjectionJobIdempotencyKey({
          jobType: "pms.projection-refresh",
          propertyId: command.propertyId,
          guestBookingId: invoiceDetails[0]!.guestBookingId,
          paymentIdempotencyKey: command.idempotencyKey,
        }),
        status: jobStatus,
      },
    ],
  };
}

function manualPaymentScopedKey(
  command: FinanceManualPaymentRecordCommand,
  kind: "booking-outbox" | "pms-outbox",
): string {
  return `finance.manual-payment:property:${command.propertyId}:${kind}:${sha256(
    command.idempotencyKey,
  )}:v1`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const emptyFinanceRepository: FinancePropertyReadRepository = {
  async getPaymentSettings() {
    return null;
  },
  async getCancellationPolicy() {
    return null;
  },
};

function financeManagePermissions(): PermissionKey[] {
  return ["pms.finance.read", "pms.finance.manage" as PermissionKey];
}

function filterInvoices(query: FinanceInvoiceListQuery): FinanceInvoiceListItem[] {
  const search = query.search?.toLowerCase();
  const filtered = invoiceListItems.filter((invoice) => {
    if (query.status && invoice.status !== query.status) return false;
    if (!search) return true;
    return [
      invoice.invoiceId,
      invoice.invoiceNumber,
      invoice.bookingReference,
      invoice.guest.displayName,
      invoice.guest.email ?? "",
    ].some((value) => value.toLowerCase().includes(search));
  });
  return filtered.toSorted((left, right) => {
    if (query.sort === "guest") {
      return left.guest.displayName.localeCompare(right.guest.displayName);
    }
    if (query.sort === "amount") {
      return Number(right.totalAmount) - Number(left.totalAmount);
    }
    return (
      right.issuedAt.localeCompare(left.issuedAt) ||
      left.invoiceNumber.localeCompare(right.invoiceNumber)
    );
  });
}

function filterPayments(query: FinancePaymentLedgerQuery): FinancePaymentLedgerItem[] {
  const search = query.search?.toLowerCase();
  return paymentLedgerItems.filter((payment) => {
    if (query.status && payment.status !== query.status) return false;
    if (query.provider && payment.provider !== query.provider) return false;
    if (query.method && payment.method !== query.method) return false;
    if (query.from && payment.recordedAt < query.from) return false;
    if (query.to && payment.recordedAt > query.to) return false;
    if (!search) return true;
    return [
      payment.paymentId,
      payment.invoiceId ?? "",
      payment.invoiceNumber ?? "",
      payment.bookingReference ?? "",
      payment.reference ?? "",
    ].some((value) => value.toLowerCase().includes(search));
  });
}

function invoiceCounts(invoices: FinanceInvoiceListItem[]): FinanceInvoiceStatusCounts {
  return {
    draft: invoices.filter((invoice) => invoice.status === "draft").length,
    sent: invoices.filter((invoice) => invoice.status === "sent").length,
    paid: invoices.filter((invoice) => invoice.status === "paid").length,
    partial: invoices.filter((invoice) => invoice.status === "partial").length,
    overdue: invoices.filter((invoice) => invoice.status === "overdue").length,
    voided: invoices.filter((invoice) => invoice.status === "voided").length,
  };
}

function queryStrings(query: unknown): Record<string, string> | undefined {
  if (!query || typeof query !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

function pmsFinanceEntitlement(
  resourceType: "pms_property" | "property" = "pms_property",
): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status: "active",
    resource: {
      product: "pms",
      resourceType,
      resourceId: propertyId,
    },
  };
}

function directBookingFinanceEntitlement(
  resourceType: "pms_property" | "property" = "pms_property",
): ProductEntitlement {
  return {
    product: "booking",
    key: "direct-booking-finance",
    status: "active",
    resource: {
      product: "pms",
      resourceType,
      resourceId: propertyId,
    },
  };
}

function identityRepository(
  linkedPropertyId: string | null | undefined,
  linkedResourceType: "pms_property" | "property" = "pms_property",
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_finance",
        email: "finance@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_finance",
        workosOrgId: "workos_finance_org",
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_finance",
        status: "active",
        roleKey: "finance_manager",
        workosMembershipId: "membership_workos_finance",
        workosRoleSlugs: ["finance_manager"],
      };
    },
    async findLinkedResources() {
      if (linkedPropertyId === null) return [];
      return [
        {
          product: "pms",
          resourceType: linkedResourceType,
          resourceId: linkedPropertyId ?? propertyId,
          relationship: "finance_manager",
          status: "active",
        },
      ];
    },
  };
}

function assertIncludes(body: unknown, paths: string[], caseId: string): void {
  for (const path of paths) {
    expect(readContractPath(body, path), `${caseId}: ${path}`).not.toBeUndefined();
  }
}

function assertExcludes(body: unknown, keys: string[], caseId: string): void {
  const serialized = JSON.stringify(body);
  for (const key of keys) {
    expect(serialized, `${caseId}: ${key}`).not.toContain(key);
  }
}

function assertEnums(body: unknown, enums: Record<string, string[]>, caseId: string): void {
  for (const [path, allowed] of Object.entries(enums)) {
    if (path.endsWith("[]")) {
      const value = readContractPath(body, path.slice(0, -2));
      expect(Array.isArray(value), `${caseId}: ${path}`).toBe(true);
      for (const entry of value as unknown[]) {
        expect(allowed, `${caseId}: ${path}`).toContain(entry);
      }
    }
  }
}

function readContractPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    const arrayMatch = /^(.+)\[(\d+)\]$/.exec(segment);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      const arrayValue = (current as Record<string, unknown>)[key!];
      return Array.isArray(arrayValue) ? arrayValue[Number(index)] : undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}
