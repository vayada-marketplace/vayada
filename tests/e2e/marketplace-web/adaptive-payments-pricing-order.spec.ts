import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  PropertySetupStepId,
} from "@vayada/domain-hotels";
import {
  FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
  createFinancePaymentReadinessSnapshot,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";

import { propertyProfile, roomList } from "../support/adaptiveSetupOwnerReads";
import { watchPageHealth } from "../support/pageHealth";
import { createPropertySetupRouteMock } from "../support/propertySetupRouteMocks";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const acceptedAt = new Date().toISOString();

// VAY-2137: publishing prices needs payment methods, and payment methods need only the hotel
// currency. So a new hotel chooses the currency and how guests pay before it sets prices.
test.describe("adaptive setup asks how guests pay before prices", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test("a new hotel picks its currency and payments, then sets prices without saving payments twice", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockPaymentsPricingApis(page);
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: [
        new RegExp(`/properties/${propertyId}/pricing-v2$`),
        new RegExp(`/properties/${propertyId}/pricing-source$`),
      ],
    });

    // No saved step: setup opens the first unfinished step, which is now Payments.
    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Choose how guests can pay", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Step 4 of 8")).toBeVisible();
    await expect(page).toHaveURL(/[?&]step=payments(?:&|$)/);
    await expect(page.getByText(/in Pricing/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save selection" })).toBeDisabled();

    await page.getByRole("combobox", { name: "Hotel currency" }).selectOption("EUR");
    await page.getByRole("button", { name: "Save currency" }).click();
    await expect(page.getByText(/Prices and payment methods use this currency/)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Hotel currency" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("payments-1-currency.png"), fullPage: true });

    await page.getByRole("checkbox", { name: "Pay at hotel" }).check();
    await page.getByRole("button", { name: "Save selection" }).click();
    await expect(page.getByText("Payment selection saved.")).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();

    // Continue lands on Pricing with the rate form, not a detour back to Payments.
    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]step=pricing(?:&|$)/);
    await expect(page.getByText("Step 5 of 8")).toBeVisible();
    await expect(page.getByText("All prices are in EUR.")).toBeVisible();
    await expect(page.getByText("Choose how guests pay first")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Room type" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("payments-2-pricing.png"), fullPage: true });

    // Going back and continuing with the same selection writes nothing, so prices never go stale.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Choose how guests can pay", level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Pay at hotel" })).toBeChecked();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();

    expect(api.currencyWrites).toEqual([{ expectedPricingCurrencyRevision: 0, currency: "EUR" }]);
    expect(api.paymentWrites).toEqual([
      {
        expectedPaymentMethodsRevision: 0,
        expectedPricingCurrencyRevision: 1,
        selectedMethods: ["pay_at_property"],
      },
    ]);
    expect(api.unexpectedCalls).toEqual([]);
    await assertHealthy();
  });
});

async function mockPaymentsPricingApis(page: Page) {
  let sessionRevision = 7;
  let currencyRevision = 0;
  let paymentMethodsRevision = 0;
  let selectedMethods: ("pay_at_property" | "card")[] = [];
  const drafts = new Map<PropertySetupStepId, PropertySetupStepDraft>();
  const currencyWrites: unknown[] = [];
  const paymentWrites: unknown[] = [];
  const unexpectedCalls: string[] = [];

  const pricingEvidence = () =>
    currencyRevision
      ? {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          currency: "EUR",
          pricingCurrencyRevision: currencyRevision,
        }
      : null;
  const pricingCurrency = () => ({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency: "EUR",
    pricingCurrencyRevision: currencyRevision,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  const readiness = () =>
    createFinancePaymentReadinessSnapshot({
      propertyId,
      selectedMethods,
      paymentMethodsRevision,
      committedPricing: paymentMethodsRevision ? pricingEvidence() : null,
      currentPricing: pricingEvidence(),
      onlineCardReadiness: "execution_unavailable",
      updatedAt: paymentMethodsRevision ? acceptedAt : null,
    });

  await page.route(
    /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({ headers: corsHeaders(route), json: { import: null } });
    },
  );

  await page.route(
    new RegExp(
      `/api/hotel-setup/properties/${propertyId}/(?:route|profile|setup-drafts/[^/?]+(?:/reset)?)(?:\\?|$)`,
    ),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/route") && request.method() === "GET") {
        const base = createPropertySetupRouteMock({
          propertyId,
          selectedTracks: ["hotel_operations"],
          stepStates: {
            present_hotel: "complete",
            booking_design: "complete",
            rooms: "complete",
            ...(selectedMethods.length ? { payments: "complete" as const } : {}),
          },
        });
        const steps = base.steps.map((step) => ({
          ...step,
          currentBaseRevisions:
            step.stepId === "payments"
              ? {
                  "finance.payment_methods": `payment-methods:${paymentMethodsRevision}`,
                  "pms.pricing_settings": `pricing:${currencyRevision}`,
                }
              : step.currentBaseRevisions,
          state: drafts.has(step.stepId) ? ("draft" as const) : step.state,
          draft: drafts.get(step.stepId) ?? null,
        }));
        const model = {
          ...base,
          sessionRevision,
          steps,
          progress: {
            complete: steps.filter(({ state }) => state === "complete").length,
            total: steps.length,
          },
        } satisfies PropertySetupRouteReadModel;
        await ok(route, model);
        return;
      }
      if (pathname.endsWith("/profile") && request.method() === "GET") {
        await ok(route, propertyProfile());
        return;
      }
      if (pathname.endsWith("/setup-drafts/payments") && request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const revision = (drafts.get("payments")?.revision ?? 0) + 1;
        sessionRevision += 1;
        drafts.set("payments", {
          stepId: "payments",
          payload: body.payload as PropertySetupStepDraft["payload"],
          dirtyFields: body.dirtyFields as PropertySetupStepDraft["dirtyFields"],
          baseRevisions: body.expectedBaseRevisions as PropertySetupStepDraft["baseRevisions"],
          piiClassification: "potential_incidental_pii",
          retentionExpiresAt: "2026-11-01T00:00:00.000Z",
          revision,
          updatedAt: acceptedAt,
        } as PropertySetupStepDraft);
        await ok(route, {
          contractVersion: "property-setup-draft.v1",
          sessionId,
          stepId: "payments",
          selectedTracks: ["hotel_operations"],
          trackRevision: 3,
          sessionRevision,
          draftRevision: revision,
          retentionExpiresAt: "2026-11-01T00:00:00.000Z",
          updatedAt: acceptedAt,
          replayed: false,
        });
        return;
      }
      if (pathname.endsWith("/setup-drafts/payments/reset") && request.method() === "POST") {
        const body = request.postDataJSON() as { expectedDraftRevision: number };
        const draft = drafts.get("payments");
        if (!draft || body.expectedDraftRevision !== draft.revision) {
          await route.fulfill({
            status: 409,
            headers: corsHeaders(route),
            json: { code: "draft_revision_conflict" },
          });
          return;
        }
        drafts.delete("payments");
        sessionRevision += 1;
        await ok(route, {
          contractVersion: "property-setup-draft-reset.v1",
          operation: "reset_step_draft",
          sessionId,
          stepId: "payments",
          trackRevision: 3,
          sessionRevision,
          discardedDraftRevision: draft.revision,
          resetAt: acceptedAt,
          nextRead: { method: "GET", href: `/api/hotel-setup/properties/${propertyId}/route` },
        });
        return;
      }
      await unexpected(route, unexpectedCalls);
    },
  );

  await page.route(new RegExp(`/api/finance/properties/${propertyId}/.*`), async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/payment-readiness") && request.method() === "GET") {
      await ok(route, readiness());
      return;
    }
    // Bank-transfer and PayPal acceptance is off, as in production today (VAY-2139).
    if (pathname.endsWith("/manual-payment-methods") && request.method() === "GET") {
      await ok(route, { acceptanceEnabled: false, readyMethods: [] });
      return;
    }
    if (pathname.endsWith("/payment-methods") && request.method() === "PUT") {
      const body = request.postDataJSON() as {
        expectedPaymentMethodsRevision: number;
        selectedMethods: typeof selectedMethods;
      };
      paymentWrites.push(body);
      const created = paymentMethodsRevision === 0;
      paymentMethodsRevision = body.expectedPaymentMethodsRevision + 1;
      selectedMethods = body.selectedMethods;
      await ok(route, {
        contractVersion: FINANCE_PAYMENT_READINESS_CONTRACT_VERSION,
        outcome: created ? "created" : "updated",
        paymentReadiness: readiness(),
        acceptedAt,
      });
      return;
    }
    await unexpected(route, unexpectedCalls);
  });

  await page.route(new RegExp(`/api/pms/(?:setup/)?properties/${propertyId}/.*`), async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname.endsWith("/pricing-source/currency-capabilities") && method === "GET") {
      await ok(route, {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: [
          { code: "EUR", scale: 2 },
          { code: "USD", scale: 2 },
        ],
      });
      return;
    }
    if (pathname.endsWith("/room-types") && method === "GET") {
      await ok(route, roomList());
      return;
    }
    if (pathname.endsWith("/pricing-source") && method === "GET") {
      if (!currencyRevision) {
        await route.fulfill({
          status: 404,
          headers: corsHeaders(route),
          json: { code: "pricing_currency_not_configured" },
        });
        return;
      }
      await ok(route, {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        propertyId,
        pricingCurrency: pricingCurrency(),
        flexibleRatePlans: [],
        capturedAt: acceptedAt,
      });
      return;
    }
    if (pathname.endsWith("/pricing-source/currency") && method === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      currencyWrites.push(body);
      currencyRevision = 1;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          outcome: "created",
          pricingCurrency: pricingCurrency(),
          acceptedAt,
        },
      });
      return;
    }
    if (pathname.endsWith("/pricing-v2/payment-methods") && method === "GET") {
      await ok(route, { acceptanceEnabled: false, readyMethods: [] });
      return;
    }
    if (pathname.endsWith("/pricing-v2") && method === "GET") {
      await route.fulfill({
        status: 404,
        headers: corsHeaders(route),
        json: { code: "not_found" },
      });
      return;
    }
    await unexpected(route, unexpectedCalls);
  });

  return { currencyWrites, paymentWrites, unexpectedCalls };
}

async function primeBrowserState(page: Page) {
  await mockHotelSetupPrerequisites(
    page,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId,
      organizationDisplayName: "Test hotel group",
      propertyId,
      selectedTracks: ["hotel_operations"],
    }),
  );
  await page.addInitScript(
    ({ selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
    },
    { selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@example.com",
          name: "Hotel Owner",
          phone: "+49 89 123456",
          profilePictureUrl: null,
          profilePictureMediaObjectId: null,
          status: "active",
        },
      },
    });
  });
}

function setupUrl(baseURL: string | undefined) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    _adaptive: "1",
  });
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

async function ok(route: Route, json: unknown) {
  await route.fulfill({ status: 200, headers: corsHeaders(route), json });
}

async function unexpected(route: Route, calls: string[]) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  calls.push(`${request.method()} ${pathname}`);
  await route.fulfill({
    status: 404,
    headers: corsHeaders(route),
    json: { code: "unexpected_e2e_request" },
  });
}
