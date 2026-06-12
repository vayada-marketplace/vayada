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
  FinancePaymentSettingsReadModel,
  FinancePropertySettingsReadRepository,
} from "@vayada/domain-finance";
import type { PublicBookabilityProfileProjection } from "@vayada/domain-distribution";
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
    request: { path: string; method?: string };
    expected: {
      status: number;
      mustInclude?: string[];
      mustExclude?: string[];
      errorCode?: string;
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
    repository?: FinancePropertySettingsReadRepository;
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

const financeRepository: FinancePropertySettingsReadRepository = {
  async getPaymentSettings(requestedPropertyId) {
    return requestedPropertyId === propertyId ? paymentSettings : null;
  },
  async getCancellationPolicy(requestedPropertyId) {
    return requestedPropertyId === propertyId ? cancellationPolicy : null;
  },
};

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
