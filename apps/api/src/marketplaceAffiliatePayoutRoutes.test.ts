import type { RequestContext } from "@vayada/backend-auth";
import type { FinancePropertyReadRepository } from "@vayada/domain-finance";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerMarketplaceAffiliatePayoutRoutes } from "./routes/marketplaceAffiliatePayouts.js";

const organizationId = "15150000-0000-4000-8000-000000000001";
const creatorId = "15150000-0000-4000-8000-000000000002";
const affiliateId = "affiliate-1515";
const payoutId = "15150000-0000-4000-8000-000000000003";
const apps: ReturnType<typeof Fastify>[] = [];

describe("Marketplace affiliate payouts", () => {
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("returns only the authenticated creator scope and masks references", async () => {
    const { app, repository } = await setup(context());
    const response = await app.inject({ method: "GET", url: "/affiliate-payouts" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(repository.getAffiliatePayoutSettings).toHaveBeenCalledWith(affiliateId, organizationId);
    expect(repository.listAffiliatePayouts).toHaveBeenCalledWith(
      affiliateId,
      { limit: 25, offset: 0 },
      organizationId,
    );
    expect(response.json()).toMatchObject({
      affiliateId,
      payoutSettings: { providerAccount: { maskedReference: "••••1515" } },
    });
    expect(response.body).not.toContain("acct_creator_1515");
    expect(response.body).not.toContain("provider-secret");
  });

  it("scopes detail and CSV exports by organization, affiliate, payout, and currency", async () => {
    const { app, repository } = await setup(context());
    const detail = await app.inject({
      method: "GET",
      url: `/affiliate-payouts/${payoutId}?currency=EUR`,
    });
    expect(detail.statusCode).toBe(200);
    expect(repository.getAffiliatePayoutDetail).toHaveBeenCalledWith(
      affiliateId,
      organizationId,
      payoutId,
      "EUR",
    );
    expect(detail.json()).toMatchObject({
      payout: { payoutStatus: "paid", includedEarnings: [{ appliedMinor: "1200" }] },
    });

    const statement = await app.inject({
      method: "GET",
      url: `/affiliate-payouts/${payoutId}/statement?currency=EUR`,
    });
    expect(statement.statusCode).toBe(200);
    expect(statement.headers["content-type"]).toContain("text/csv");
    expect(statement.body).toContain('"earning_entry_id"');
    expect(statement.body).toContain('"••••king"');
    expect(statement.body).not.toContain("provider-secret");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/affiliate-payouts/${payoutId}/statement?currency=USD`,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("uses Finance idempotency commands without accepting browser-selected scope", async () => {
    const { app, repository } = await setup(context());
    const settings = await app.inject({
      method: "PATCH",
      url: "/affiliate-payouts/settings",
      payload: {
        commandId: "settings-1515",
        idempotencyKey: "settings-key-1515",
        payoutProvider: "stripe",
        payoutCurrency: "EUR",
        payoutSchedule: "monthly",
        payoutThresholdAmount: null,
        organizationId: "attacker",
        affiliateId: "attacker",
      },
    });
    expect(settings.statusCode).toBe(200);
    expect(repository.updateAffiliatePayoutSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateId,
        idempotencyKey: "settings-key-1515",
        audit: expect.objectContaining({
          actor: expect.objectContaining({ organizationId }),
        }),
      }),
    );

    const stripe = await app.inject({
      method: "POST",
      url: "/affiliate-payouts/stripe",
      payload: {
        commandId: "stripe-1515",
        idempotencyKey: "stripe-key-1515",
        country: "DE",
      },
    });
    expect(stripe.statusCode).toBe(200);
    expect(repository.createStripeProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({ affiliateId, organizationId, idempotencyKey: "stripe-key-1515" }),
    );
    expect(stripe.body).not.toContain("acct_creator_1515");

    vi.mocked(repository.createStripeProviderAccount!).mockResolvedValueOnce({
      ok: true,
      status: "created",
      response: {
        contractVersion: "finance-route-contracts.v1",
        providerAccountId: "provider-account-1515",
        provider: "stripe",
        providerAccountRef: "id",
        status: "pending",
        onboardingStatus: "invited",
        onboardingUrl: "https://connect.stripe.test/setup",
        commandMeta: {
          commandId: "retry-1515",
          idempotencyKey: "retry-1515",
          sideEffects: [],
          outboxEvents: [],
          jobs: [],
        },
      },
    });
    const shortReference = await app.inject({
      method: "POST",
      url: "/affiliate-payouts/stripe",
      payload: { commandId: "retry-1515", idempotencyKey: "retry-1515", country: "DE" },
    });
    expect(shortReference.json().providerAccount.maskedReference).toBe("••••");
    expect(shortReference.body).not.toContain('"id"');
  });

  it("fails closed for missing or ambiguous creator scope and invalid currency", async () => {
    const unauthenticated = await setup(null);
    expect(
      (await unauthenticated.app.inject({ method: "GET", url: "/affiliate-payouts" })).statusCode,
    ).toBe(401);
    const ambiguous = context();
    ambiguous.linkedResources.push({
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: "other",
      relationship: "owner",
      status: "active",
    });
    expect(
      (await (await setup(ambiguous)).app.inject({ method: "GET", url: "/affiliate-payouts" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await (
          await setup(context())
        ).app.inject({ method: "GET", url: `/affiliate-payouts/${payoutId}?currency=EURO` })
      ).statusCode,
    ).toBe(400);
  });
});

async function setup(authContext: RequestContext | null) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", (request, _reply, done) => {
    request.authContext = authContext;
    done();
  });
  const repository = financeRepository();
  await app.register(registerMarketplaceAffiliatePayoutRoutes, { repository });
  return { app, repository };
}

function financeRepository() {
  const detail = {
    payoutId,
    ownerScope: "organization" as const,
    propertyId: null,
    organizationId,
    relatedPropertyId: "property-1",
    guestBookingId: null,
    paymentId: null,
    payoutStatus: "paid" as const,
    amount: "12.00",
    feeAmount: "0.00",
    netAmount: "12.00",
    currency: "EUR",
    provider: "stripe" as const,
    providerPayoutId: "provider-secret",
    scheduledAt: null,
    paidAt: "2026-09-27T10:00:00.000Z",
    failedAt: null,
    failureCode: null,
    retryCount: 0,
    maskedDestination: "Destination ••••",
    maskedProviderReference: "••••1515",
    includedEarnings: [
      {
        earningEntryId: "entry-1",
        propertyId: "property-1",
        bookingReference: "••••king",
        agreementId: "agreement-1",
        recordedAt: "2026-09-26T10:00:00.000Z",
        currency: "EUR",
        currencyMinorUnit: 2,
        commissionMinor: "1200",
        adjustmentMinor: "1200",
        appliedMinor: "1200",
      },
    ],
  };
  return {
    getAffiliatePayoutSettings: vi.fn().mockResolvedValue({
      affiliateId,
      marketplaceOrganizationId: organizationId,
      payoutsEnabled: true,
      payoutProvider: "stripe",
      payoutCurrency: "EUR",
      payoutSchedule: "monthly",
      payoutThresholdAmount: null,
      providerAccount: {
        providerAccountId: "acct_creator_1515",
        provider: "stripe",
        status: "active",
        onboardingStatus: "completed",
        payoutsEnabled: true,
      },
      sourceFreshness: {},
      updatedAt: "2026-09-27T10:00:00.000Z",
    }),
    listAffiliatePayouts: vi.fn().mockResolvedValue({
      payouts: [detail],
      total: 1,
      limit: 25,
      offset: 0,
      sourceFreshness: {},
    }),
    getAffiliatePayoutDetail: vi.fn(async (_affiliate, _organization, _payout, currency) =>
      currency === "EUR" ? detail : null,
    ),
    updateAffiliatePayoutSettings: vi.fn().mockResolvedValue({
      ok: true,
      status: "updated",
      settings: {},
      commandMeta: {
        commandId: "settings-1515",
        idempotencyKey: "settings-key-1515",
        sideEffects: [],
        outboxEvents: [],
        jobs: [],
      },
    }),
    createStripeProviderAccount: vi.fn().mockResolvedValue({
      ok: true,
      status: "created",
      response: {
        providerAccountId: "id",
        provider: "stripe",
        providerAccountRef: "acct_creator_1515",
        status: "pending",
        onboardingStatus: "invited",
        onboardingUrl: "https://connect.stripe.test/setup",
        commandMeta: {
          commandId: "stripe-1515",
          idempotencyKey: "stripe-key-1515",
          sideEffects: [],
          outboxEvents: [],
          jobs: [],
        },
      },
    }),
  } as unknown as FinancePropertyReadRepository & Record<string, ReturnType<typeof vi.fn>>;
}

function context(): RequestContext {
  return {
    actor: {
      internalUserId: "actor",
      status: "active",
      email: "creator@example.test",
      providerIdentity: { provider: "workos", providerUserId: "workos" },
    },
    selectedOrganization: { organizationId, kind: "creator_workspace", status: "active" },
    membership: {
      membershipId: "membership",
      status: "active",
      roleKey: "creator_owner",
      workosRoleSlugs: [],
      permissions: ["marketplace.collaboration.read", "marketplace.profile.manage"],
    },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorId,
        relationship: "owner",
        status: "active",
      },
      {
        product: "affiliate",
        resourceType: "affiliate",
        resourceId: affiliateId,
        relationship: "owner",
        status: "active",
      },
    ],
    entitlements: [],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request", source: "api", receivedAt: "2026-09-27T10:00:00.000Z" },
  };
}
