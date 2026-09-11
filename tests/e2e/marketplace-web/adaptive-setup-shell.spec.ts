import { mockAdaptiveSetupOwnerReads } from "../support/adaptiveSetupOwnerReads";
import { mockSetupExitHandoff } from "../support/setupExitHandoff";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  createProductReadinessResult,
  READINESS_GROUP_IDS_BY_PRODUCT,
  type PropertySetupStepId,
  type SetupTrack,
} from "@vayada/domain-hotels";
import {
  createPropertySetupRouteMock,
  mockPropertySetupRoute,
} from "../support/propertySetupRouteMocks";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const routeScenarios: Array<{
  name: string;
  selectedTracks: SetupTrack[];
  resumeStepId: PropertySetupStepId;
  expectedStep: number;
  expectedTotal: number;
  expectedHeading: string;
}> = [
  {
    name: "Marketplace-only",
    selectedTracks: ["creator_marketplace"],
    resumeStepId: "marketplace_preferences",
    expectedStep: 2,
    expectedTotal: 3,
    expectedHeading: "Tell creators what you are open to",
  },
  {
    name: "Hotel Operations-only",
    selectedTracks: ["hotel_operations"],
    resumeStepId: "calendar",
    expectedStep: 5,
    expectedTotal: 8,
    expectedHeading: "Open your calendar",
  },
  {
    name: "combined",
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    resumeStepId: "guest_experience",
    expectedStep: 7,
    expectedTotal: 9,
    expectedHeading: "Configure the guest experience",
  },
];

test.describe("marketplace-web adaptive hotel setup shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
      async (route) => {
        if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
        await route.fulfill({ headers: corsHeaders(route), json: { import: null } });
      },
    );
  });
  for (const tracks of [
    ["creator_marketplace"],
    ["hotel_operations"],
    ["hotel_operations", "creator_marketplace"],
  ] as SetupTrack[][]) {
    test(`review entry, independent commands and reload recovery: ${tracks.join("+")}`, async ({
      page,
      baseURL,
    }) => {
      await primeBrowserState(page);
      await mockAuthSession(page);
      await mockPropertySetupRoute(
        page,
        createPropertySetupRouteMock({
          propertyId,
          selectedTracks: tracks,
          resumeStepId: "review",
        }),
      );
      test.setTimeout(60_000);
      const writes = await mockReviewProducts(page);
      await page.goto(setupUrl(baseURL, { step: "review" }));
      if (tracks.includes("creator_marketplace"))
        await expect(
          page.getByRole("button", { name: "Submit to Marketplace", exact: true }),
        ).toBeEnabled();
      else
        await expect(
          page.getByRole("heading", { name: "Creator Marketplace", exact: true }),
        ).toHaveCount(0);
      if (tracks.includes("hotel_operations"))
        await expect(
          page.getByRole("button", { name: "Publish booking page", exact: true }),
        ).toBeEnabled();
      else
        await expect(
          page.getByRole("heading", { name: "Booking Engine", exact: true }),
        ).toHaveCount(0);
      expect(writes).toHaveLength(0);
      if (tracks.includes("creator_marketplace")) {
        await page.getByRole("button", { name: "Submit to Marketplace", exact: true }).click();
        await expect(page.getByText("Pending review", { exact: true })).toBeVisible();
      }
      if (tracks.includes("hotel_operations")) {
        await page.getByRole("button", { name: "Publish booking page", exact: true }).click();
        await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
      }
      const accepted = [...writes];
      await page.reload({ waitUntil: "domcontentloaded" });
      if (tracks.includes("creator_marketplace"))
        await expect(page.getByText("Pending review", { exact: true })).toBeVisible();
      if (tracks.includes("hotel_operations"))
        await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
      expect(writes).toEqual(accepted);
      await expect(page.getByRole("button", { name: "Finish for now", exact: true })).toBeEnabled();
    });
  }

  test("automatically selects the only hotel before resuming adaptive setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "calendar",
      }),
    );
    const entryUrl = new URL(setupUrl(baseURL));
    entryUrl.searchParams.delete("propertyId");
    await page.goto(entryUrl.toString());
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`propertyId=${propertyId}`));
  });

  test("retries a failed prerequisite read before opening the saved hotel", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId,
      organizationDisplayName: "Hotels",
      propertyId,
    });
    let unavailable = true;
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({
        status: unavailable ? 503 : 200,
        headers: corsHeaders(route),
        json: unavailable ? { detail: "Temporary outage" } : status,
      });
    });
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["creator_marketplace"],
        resumeStepId: "review",
      }),
    );
    await page.goto(setupUrl(baseURL));
    await expect(page.getByRole("heading", { name: "Setup unavailable" })).toBeVisible();
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page).toHaveURL(/step=review/);
  });

  test("selects among existing hotels and clears the previous hotel's step", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId,
      organizationDisplayName: "Hotels",
      propertyId,
    });
    status.propertySelection.state = "multiple_properties";
    status.propertySelection.selectedPropertyId = null;
    status.propertySelection.availableProperties.push({
      ...status.propertySelection.availableProperties[0],
      propertyId: "other-hotel",
      displayName: "Other hotel",
    });
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const selected = new URL(route.request().url()).searchParams.get("propertyId");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          ...status,
          setupPlan: selected === propertyId ? status.setupPlan : null,
          entryDecision:
            selected === propertyId
              ? status.entryDecision
              : {
                  requestedProduct: "marketplace",
                  propertyId: null,
                  decision: "setup_required",
                  destinationRouteKey: "hotel_setup",
                  reasonCode: "property_selection_required",
                },
          propertySelection: {
            ...status.propertySelection,
            selectedPropertyId: selected === propertyId ? propertyId : null,
          },
        },
      });
    });
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["creator_marketplace"],
        resumeStepId: "marketplace_preferences",
      }),
    );
    const url = new URL(setupUrl(baseURL, { step: "payments" }));
    url.searchParams.delete("propertyId");
    await page.goto(url.toString());
    await expect(page.getByRole("heading", { name: "Choose hotel" })).toBeVisible();
    await page.getByRole("button", { name: /Alpenrose Hotel/ }).click();
    await expect(
      page.getByRole("heading", { name: "Tell creators what you are open to", level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/step=marketplace_preferences/);
  });

  test("add mode takes precedence over an existing property and saved step", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await page.route(/\/api\/hotel-setup\/property-types/, (route) =>
      route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "adaptive-hotel-property-types.v1",
          propertyTypes: [{ value: "hotel", label: "Hotel" }],
        },
      }),
    );
    let adaptiveReads = 0;
    page.on("request", (request) => {
      if (/\/route(?:\?|$)/.test(request.url())) adaptiveReads++;
    });
    const url = new URL(setupUrl(baseURL, { step: "calendar" }));
    url.searchParams.set("mode", "add");
    await page.goto(url.toString());
    await expect(page.getByRole("heading", { name: "Let’s get to know this hotel" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Hotel name/ })).toHaveValue("");
    expect(adaptiveReads).toBe(0);
  });

  for (const scenario of routeScenarios) {
    test(`${scenario.name} follows the canonical route and resumes at the server step`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);
      const forbiddenCalls = watchForbiddenSetupCalls(page);
      await primeBrowserState(page);
      await mockAuthSession(page);
      const routeModel = createPropertySetupRouteMock({
        propertyId,
        selectedTracks: scenario.selectedTracks,
        resumeStepId: scenario.resumeStepId,
        stepStates: { present_hotel: "complete" },
      });
      const routeMock = await mockPropertySetupRoute(page, routeModel);

      await page.goto(setupUrl(baseURL));

      await expect(
        page.getByRole("heading", { name: scenario.expectedHeading, level: 1 }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`[?&]step=${scenario.resumeStepId}(?:&|$)`));
      await expect(
        page.getByText(`Step ${scenario.expectedStep} of ${scenario.expectedTotal}`),
      ).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Hotel setup progress" })).toHaveAttribute(
        "aria-valuetext",
        `Step ${scenario.expectedStep} of ${scenario.expectedTotal}`,
      );
      await expect(page.getByTestId("adaptive-setup-content")).toHaveAttribute(
        "data-step-id",
        scenario.resumeStepId,
      );
      expect(routeMock.requestCount).toBe(1);
      expect(forbiddenCalls()).toEqual([]);
      await assertHealthy();
    });
  }

  test("reload resumes the same property session and server-selected step", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        resumeStepId: "calendar",
      }),
    );

    await page.goto(setupUrl(baseURL));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    await page.reload();

    await expect(page).toHaveURL(new RegExp(`propertyId=${propertyId}.*[?&]step=calendar`));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthy();
  });

  test("Back follows the exact previous server position, focuses the heading, and respects browser history", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        resumeStepId: "calendar",
      }),
    );

    await page.goto(setupUrl(baseURL, { step: "calendar" }));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Back", exact: true }).click();

    await expect(page).toHaveURL(/[?&]step=pricing(?:&|$)/);
    const previousHeading = page.getByRole("heading", {
      name: "Set your room prices",
      level: 1,
    });
    await expect(previousHeading).toBeVisible();
    await expect(previousHeading).toBeFocused();
    await expect(page.getByText("Step 5 of 9")).toBeVisible();

    await page.goBack();

    const restoredHeading = page.getByRole("heading", {
      name: "Open your calendar",
      level: 1,
    });
    await expect(restoredHeading).toBeVisible();
    await expect(restoredHeading).toBeFocused();
    await expect(page.getByText("Step 6 of 9")).toBeVisible();
    await assertHealthy();
  });

  test("browser Back leaves setup through the draft-preservation guard", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "pricing",
      }),
    );
    const originUrl = new URL("/setup-history-origin", baseURL).toString();
    await page.route(originUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Setup history origin</title>",
      });
    });

    await page.goto(originUrl);
    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();

    await page.goBack();

    await expect(page).toHaveURL(originUrl);
  });

  test("Exit setup is keyboard accessible and hands a Marketplace entrant to incomplete PMS setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["creator_marketplace"],
        resumeStepId: "marketplace_preferences",
      }),
    );
    const returnTo = "/marketplace?view=creators";
    const destination = await mockSetupExitHandoff(page, baseURL, propertyId);

    await page.goto(setupUrl(baseURL, { returnTo }));
    await expect(
      page.getByRole("heading", {
        name: "Tell creators what you are open to",
        level: 1,
      }),
    ).toBeVisible();

    const exit = page.getByRole("button", { name: "Exit setup", exact: true });
    await exit.focus();
    await expect(exit).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(destination);
  });

  for (const target of [
    {
      product: "booking" as const,
      label: "Booking Admin",
    },
    { product: "pms" as const, label: "PMS" },
  ]) {
    test(`Exit setup hands a ${target.label} entrant to incomplete PMS setup`, async ({
      page,
      baseURL,
    }) => {
      await primeBrowserState(page);
      await mockAuthSession(page);
      await mockPropertySetupRoute(
        page,
        createPropertySetupRouteMock({
          propertyId,
          selectedTracks: ["hotel_operations"],
          resumeStepId: "booking_design",
        }),
      );
      const destination = await mockSetupExitHandoff(page, baseURL, propertyId);

      await page.goto(
        setupUrl(baseURL, {
          returnProduct: target.product,
          returnTo: "/dashboard?from=setup",
        }),
      );
      await expect(
        page.getByRole("heading", { name: "Style your booking page", level: 1 }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Exit setup", exact: true }).click();

      await expect(page).toHaveURL(destination);
    });
  }

  test("Exit setup preserves the PMS calendar recovery destination", async ({ page, baseURL }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "calendar",
      }),
    );
    const destination = await mockSetupExitHandoff(page, baseURL, propertyId, "/settings#calendar");
    const url = new URL(
      setupUrl(baseURL, { returnProduct: "pms", returnTo: "/settings#calendar" }),
    );
    url.searchParams.set("recovery", "pms-calendar");
    await page.goto(url.toString());
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();
    await expect(page).toHaveURL(destination);
  });

  test("shows an accessible Retry action and recovers after an initial 503", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "review",
      }),
      { failuresBeforeSuccess: 1, failureDetail: "Setup is temporarily unavailable." },
    );

    await page.goto(setupUrl(baseURL));

    const recoveryHeading = page.getByRole("heading", { name: "Setup could not be loaded" });
    const recovery = recoveryHeading.locator("..");
    await expect(recoveryHeading).toBeVisible();
    await expect(recovery).toContainText("Setup is temporarily unavailable.");
    const retry = recovery.getByRole("button", { name: "Retry", exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo);
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Review and launch", level: 1 })).toBeVisible();
    await expect(page.getByText("Step 8 of 8")).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthyAfterRecovery();
  });

  test("announces a stale draft and supports keyboard refresh recovery", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "pricing",
      }),
      {
        failuresBeforeSuccess: 1,
        failureStatus: 409,
        failureCode: "draft_revision_conflict",
        failureDetail: "The setup draft changed in another session.",
      },
    );

    await page.goto(setupUrl(baseURL));

    const staleHeading = page.getByRole("heading", { name: "This setup draft is out of date" });
    const staleAlert = staleHeading.locator("..");
    await expect(staleAlert).toHaveAttribute("role", "alert");
    await expect(staleAlert).toContainText(/changed in another tab or session/i);
    const refresh = staleAlert.getByRole("button", { name: "Refresh", exact: true });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo);
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Step 4 of 8")).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthyAfterRecovery();
  });

  test("keeps the shell and step content full-width without horizontal overflow on mobile", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "booking_design",
      }),
    );

    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("adaptive-setup-content")).toBeAttached();

    const layout = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('[data-testid="adaptive-setup-content"]');
      const container = content?.parentElement;
      if (!content || !container) throw new Error("Adaptive setup content was not rendered.");
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        contentWidth: content.getBoundingClientRect().width,
        containerWidth: container.getBoundingClientRect().width,
      };
    });

    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.contentWidth).toBeGreaterThanOrEqual(layout.viewportWidth - 40);
    expect(Math.abs(layout.contentWidth - layout.containerWidth)).toBeLessThanOrEqual(1);
    await assertHealthy();
  });
});

async function primeBrowserState(page: Page) {
  await mockReviewProducts(page);
  await mockAdaptiveSetupOwnerReads(page);
  await mockHotelSetupPrerequisites(
    page,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Test hotel group",
      propertyId,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
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
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        workosOrganizationId: "org_workos_hotel_group",
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Owner Example",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "media-owner",
          status: "active",
          workosUserId: "user_workos_hotel_owner",
        },
      },
    });
  });
}

const organizationId = "11111111-1111-4111-8111-111111111111";

function setupUrl(
  baseURL: string | undefined,
  overrides: {
    step?: PropertySetupStepId;
    returnProduct?: "marketplace" | "booking" | "pms";
    returnTo?: string;
  } = {},
): string {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: overrides.returnProduct ?? "marketplace",
    returnTo: overrides.returnTo ?? "/marketplace",
    propertyId,
    _adaptive: "1",
  });
  if (overrides.step) query.set("step", overrides.step);
  if (!baseURL) return `/setup?${query.toString()}`;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

function watchForbiddenSetupCalls(page: Page) {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (isForbiddenSetupCall(request)) calls.push(`${request.method()} ${request.url()}`);
  });
  return () => calls;
}

function isForbiddenSetupCall(request: Request): boolean {
  const pathname = new URL(request.url()).pathname;
  if (request.method() === "OPTIONS") return false;
  const writesOwner = request.method() !== "GET";
  return (
    /^\/api\/hotel-setup\/(?:tracks|property-types|handoffs)(?:\/|$)/.test(pathname) ||
    (writesOwner &&
      /^\/api\/hotel-setup\/properties\/[^/]+\/(?:profile|public-profile)(?:\/|$)/.test(
        pathname,
      )) ||
    (writesOwner && /^\/api\/(?:booking|finance|marketplace|pms|distribution)\//.test(pathname))
  );
}

async function mockReviewProducts(page: Page) {
  const writes: Array<{ product: string; key: string | undefined; body: unknown }> = [];
  for (const product of ["marketplace", "booking"] as const) {
    const source = {
      ownerDomain: product,
      entityType: "settings",
      entityId: propertyId,
      revision: "1",
    };
    const readiness = await createProductReadinessResult({
      contractVersion: "onboarding-product-readiness.v1",
      propertyId,
      product,
      status: "ready",
      sourceManifest: {
        contractVersion: "onboarding-source-manifest.v1",
        propertyId,
        sources: [source],
      },
      groups: READINESS_GROUP_IDS_BY_PRODUCT[product].map((groupId) => ({
        groupId,
        status: "ready",
        steps: [
          {
            owningStepId: product === "booking" ? "booking_design" : "marketplace_preferences",
            status: "ready",
            entities: [{ source, status: "ready", blockers: [] }],
          },
        ],
      })),
      evaluatedAt: new Date().toISOString(),
    });
    let accepted = false;
    const now = new Date().toISOString();
    const receipt = {
      revisionId: "33333333-3333-4333-8333-333333333333",
      propertyId,
      revisionNumber: 1,
      status: "pending",
      decisionReason: null,
      submittedAt: now,
    };
    const operation = {
      operationId: "44444444-4444-4444-8444-444444444444",
      propertyId,
      status: "pending",
      expectedActiveContentRevisionId: null,
      resultContentRevisionId: null,
      failureCode: null,
      requestedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const pattern =
      product === "booking"
        ? /\/api\/hotel-setup\/properties\/[^/]+\/publications\/booking(?:\?|$)/
        : /\/api\/marketplace\/properties\/[^/]+\/(?:submission-review|submissions)(?:\?|$)/;
    await page.route(pattern, async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (request.method() === "POST") {
        writes.push({
          product,
          key: request.headers()["idempotency-key"],
          body: request.postDataJSON(),
        });
        accepted = true;
        return route.fulfill({
          status: 202,
          headers: corsHeaders(route),
          json: product === "booking" ? operation : receipt,
        });
      }
      const recovered = accepted && !!request.headers()["idempotency-key"];
      await route.fulfill({
        headers: corsHeaders(route),
        json:
          product === "booking"
            ? {
                contractVersion: "booking-publication-review.v1",
                propertyId,
                activeContentRevisionId: null,
                publishedUrl: null,
                latestOperation: accepted ? operation : null,
                recoveredOperation: recovered ? operation : null,
                readiness,
              }
            : {
                contractVersion: "marketplace-submission-review.v1",
                propertyId,
                activeSubmission: null,
                latestSubmission: accepted ? receipt : null,
                recoveredSubmission: recovered ? receipt : null,
                readiness,
              },
      });
    });
  }
  return writes;
}
