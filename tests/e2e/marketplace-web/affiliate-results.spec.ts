import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        accessToken: "creator-access",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationKind: "creator_workspace",
        user: {
          id: "creator-user",
          email: "creator@example.test",
          name: "Lina Creator",
          status: "active",
        },
      },
    }),
  );
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        id: "consent-e2e",
        visitor_id: "visitor-e2e",
        user_id: null,
        necessary: true,
        functional: true,
        analytics: false,
        marketing: false,
        created_at: "2026-09-27T08:00:00.000Z",
        updated_at: "2026-09-27T08:00:00.000Z",
      },
    });
  });
  await routePayouts(page, { payouts: [] });
});

test("shows filtered multi-currency results and status explanations", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo);
  const requests: URL[] = [];
  await routePerformance(page, (url) => {
    requests.push(url);
    return performancePage({
      partnerships: [
        partnership({
          commissions: [
            {
              currency: "EUR",
              currencyMinorUnit: 2,
              calculatedMinor: "12345",
              adjustmentMinor: "-100",
            },
            {
              currency: "USD",
              currencyMinorUnit: 2,
              calculatedMinor: "6789",
              adjustmentMinor: "0",
            },
          ],
        }),
      ],
    });
  });

  await page.goto("/earnings");
  await expect(page.getByRole("heading", { name: "Results & earnings" })).toBeVisible();
  await expect(page.getByText("EUR 123.45", { exact: true })).toBeVisible();
  await expect(page.getByText("USD 67.89", { exact: true })).toBeVisible();
  await expect(page.getByText(/EUR -1\.00 latest adjustment/)).toBeVisible();
  for (const state of ["Calculated estimate", "Awaiting verification", "Latest adjustment"])
    await expect(
      page.getByRole("heading", { name: "What each status means" }).locator("..").getByText(state, {
        exact: true,
      }),
    ).toBeVisible();
  await expect(
    page.getByText("Payout status is not available in this results view."),
  ).toBeVisible();
  await expect(page.getByText(/does not infer them from commission calculations/)).toBeVisible();

  await page.getByLabel("Source").selectOption("tiktok");
  await page.getByLabel("Campaign").fill("autumn_launch");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.searchParams.get("source")).toBe("tiktok");
  expect(requests[1]?.searchParams.get("campaign")).toBe("autumn_launch");
  await verify();
});

test("keeps an empty partnership list distinct from zero bookings", async ({ page }, testInfo) => {
  const verify = checks(page, testInfo);
  await routePerformance(page, () => performancePage({ partnerships: [] }));
  await page.goto("/earnings");
  await expect(page.getByText("No affiliate partnerships yet", { exact: true })).toBeVisible();
  await expect(page.getByText("0 bookings", { exact: true })).toHaveCount(0);
  await verify();
});

test("explains stale or missing evidence instead of claiming zero", async ({ page }, testInfo) => {
  const verify = checks(page, testInfo);
  await routePerformance(page, () =>
    performancePage({ partnerships: [partnership({ bookings: 0, freshness: "stale" })] }),
  );
  await page.goto("/earnings");
  await expect(page.getByText("Some evidence is delayed or missing.")).toBeVisible();
  await expect(page.getByText(/not the same as confirmed zero bookings/)).toBeVisible();
  await expect(page.getByText("Evidence is stale", { exact: true })).toBeVisible();
  await expect(page.getByText("Recorded bookings", { exact: true })).toBeVisible();
  await expect(page.getByText("≥0", { exact: true })).toBeVisible();
  await expect(page.getByText("0 bookings", { exact: true })).toHaveCount(0);
  await verify();
});

test("waits for the authorized hotel property before loading results", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo);
  const propertyId = "22222222-2222-4222-8222-222222222222";
  await page.unroute(/\/auth\/session(?:\?|$)/);
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        accessToken: "hotel-access",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationKind: "hotel_group",
        user: {
          id: "hotel-user",
          email: "hotel@example.test",
          name: "Hotel Owner",
          status: "active",
        },
      },
    }),
  );
  await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpine Group",
        propertyId,
      }),
    });
  });
  const requests: URL[] = [];
  await routePerformance(page, (url) => {
    requests.push(url);
    return performancePage({ partnerships: [partnership()] });
  });

  await page.goto("/earnings");
  await expect(page.getByText("Alpine House", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]?.searchParams.get("propertyId")).toBe(propertyId);
  await verify();
});

test("does not append an old pagination response after filters change", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo);
  let pendingPage: Route | undefined;
  await page.route(/\/api\/marketplace\/affiliate-performance(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      pendingPage = route;
      return;
    }
    const filtered = url.searchParams.get("source") === "tiktok";
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      ...performancePage({
        partnerships: [partnership({ propertyName: filtered ? "Filtered Hotel" : "First Hotel" })],
        nextCursor: filtered ? null : "old-page",
      }),
    });
  });

  await page.goto("/earnings");
  await expect(
    page.getByText("Totals for partnerships shown; load more to expand them."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more partnerships" }).click();
  await expect.poll(() => Boolean(pendingPage)).toBe(true);
  await page.getByLabel("Source").selectOption("tiktok");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("Filtered Hotel", { exact: true })).toBeVisible();
  if (pendingPage)
    await pendingPage
      .fulfill({
        status: 200,
        headers: corsHeaders(pendingPage),
        ...performancePage({ partnerships: [partnership({ propertyName: "Old Page Hotel" })] }),
      })
      .catch(() => undefined);
  await expect(page.getByText("Old Page Hotel", { exact: true })).toHaveCount(0);
  await verify();
});

test("shows a retryable target read error without changing account data", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo, false);
  await routePerformance(page, () => ({ status: 503, json: { code: "read_model_unavailable" } }));
  await page.goto("/earnings");
  const alert = page.getByText("Could not load affiliate results").locator("..");
  await expect(alert).toContainText("Could not load affiliate results");
  await expect(alert).toContainText("Your existing partnerships and earnings are unchanged.");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await verify();
});

test("reconciles a paid payout to included commissions and downloads its scoped statement", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo);
  await routePerformance(page, () => performancePage({ partnerships: [partnership()] }));
  await page.unroute(/\/api\/marketplace\/affiliate-payouts(?:[/?]|$)/);
  await routePayouts(page, { payouts: [payout()] });
  await page.goto("/earnings");
  await expect(page.getByRole("heading", { name: "Payouts & statements" })).toBeVisible();
  await expect(page.getByText("EUR 12.00 · Paid", { exact: true })).toBeVisible();
  await expect(page.getByText(/Only Finance-confirmed payouts appear as paid/)).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).click();
  await expect(page.getByRole("heading", { name: "Included commissions" })).toBeVisible();
  await expect(page.getByText(/EUR 12.00 applied · booking ••••1515/)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download statement" }).click();
  expect((await download).suggestedFilename()).toBe(`payout-${payout().payoutId}.csv`);
  await verify();
});

test("recovers payout history after a failed read without presenting eligible earnings as paid", async ({
  page,
}, testInfo) => {
  const verify = checks(page, testInfo, false);
  await routePerformance(page, () => performancePage({ partnerships: [partnership()] }));
  await page.unroute(/\/api\/marketplace\/affiliate-payouts(?:[/?]|$)/);
  let attempts = 0;
  await routePayouts(
    page,
    { payouts: [payout({ payoutStatus: "failed", failureCode: "provider_rejected" })] },
    () => ++attempts === 1,
  );
  await page.goto("/earnings");
  await expect(page.getByRole("alert").filter({ hasText: "Payout details are" })).toContainText(
    "Payout details are temporarily unavailable",
  );
  await page.getByRole("button", { name: "Retry" }).last().click();
  await expect(
    page.getByText("EUR 12.00 · Failed — action may be required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("EUR 123.45 · Paid", { exact: true })).toHaveCount(0);
  await verify();
});

function checks(page: Page, testInfo: TestInfo, checkHealth = true) {
  const healthy = checkHealth ? watchPageHealth(page, testInfo) : null;
  const targetOnly = watchNoLegacyCalls(page, testInfo, "marketplace-web-offer-discovery");
  return async () => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await targetOnly();
    await healthy?.();
  };
}

async function routePerformance(
  page: Page,
  response: (url: URL) => { status?: number; json: unknown },
) {
  await page.route(/\/api\/marketplace\/affiliate-performance(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const result = response(new URL(route.request().url()));
    await route.fulfill({
      status: result.status ?? 200,
      headers: corsHeaders(route),
      json: result.json,
    });
  });
}

async function routePayouts(
  page: Page,
  overrides: Record<string, unknown>,
  failList: () => boolean = () => false,
) {
  await page.route(/\/api\/marketplace\/affiliate-payouts(?:[/?]|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/statement"))
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders(route),
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="payout-${payout().payoutId}.csv"`,
        },
        body: '"payout_id"\r\n',
      });
    if (/\/affiliate-payouts\/[^/]+$/.test(url.pathname))
      return route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "finance-route-contracts.v1",
          affiliateId: "affiliate-1515",
          payout: payoutDetail(),
        },
      });
    if (failList())
      return route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { code: "read_model_unavailable" },
      });
    return route.fulfill({ status: 200, headers: corsHeaders(route), json: payoutPage(overrides) });
  });
}

function payoutPage(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "finance-route-contracts.v1",
    affiliateId: "affiliate-1515",
    payoutSettings: {
      payoutsEnabled: true,
      payoutProvider: "stripe",
      payoutCurrency: "EUR",
      payoutSchedule: "monthly",
      payoutThresholdAmount: null,
      providerAccount: {
        status: "active",
        onboardingStatus: "completed",
        payoutsEnabled: true,
        maskedReference: "••••1515",
      },
    },
    payouts: [],
    total: 0,
    limit: 25,
    offset: 0,
    sourceFreshness: {},
    ...overrides,
  };
}
function payout(overrides: Record<string, unknown> = {}) {
  return {
    payoutId: "15150000-0000-4000-8000-000000000003",
    payoutStatus: "paid",
    amount: "12.00",
    feeAmount: "0.00",
    netAmount: "12.00",
    currency: "EUR",
    scheduledAt: null,
    paidAt: "2026-09-27T10:00:00.000Z",
    failedAt: null,
    failureCode: null,
    retryCount: 0,
    ...overrides,
  };
}
function payoutDetail() {
  return {
    ...payout(),
    maskedDestination: "Destination ••••",
    maskedProviderReference: "••••1515",
    includedEarnings: [
      {
        earningEntryId: "entry-1515",
        propertyId: "property-1515",
        bookingReference: "••••1515",
        agreementId: "agreement-1515",
        recordedAt: "2026-09-26T10:00:00.000Z",
        currency: "EUR",
        currencyMinorUnit: 2,
        commissionMinor: "1200",
        adjustmentMinor: "1200",
        appliedMinor: "1200",
      },
    ],
  };
}

function performancePage(overrides: Record<string, unknown> = {}) {
  return {
    json: {
      contractVersion: "affiliate-performance.v1",
      coverage: "available",
      readAt: "2026-09-27T08:00:00.000Z",
      period: { from: "2026-06-27T08:00:00.000Z", to: "2026-09-27T08:00:00.000Z" },
      filters: { propertyId: null, source: null, campaign: null },
      partnerships: [],
      nextCursor: null,
      ...overrides,
    },
  };
}

function partnership(overrides: Record<string, unknown> = {}) {
  return {
    agreementId: "agreement-1",
    propertyId: "22222222-2222-4222-8222-222222222222",
    propertyName: "Alpine House",
    creatorProfileId: "creator-profile-1",
    clicks: 12,
    bookings: 2,
    stays: { total: 2, calculated: 1, pending: 1, needsReview: 0 },
    commissions: [],
    sources: [{ source: "instagram", clicks: 12 }],
    campaigns: [{ campaign: "autumn_launch", clicks: 12 }],
    freshness: "current",
    ...overrides,
  };
}
