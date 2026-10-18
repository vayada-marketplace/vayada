// Ported from tests/e2e/marketplace-web/adaptive-setup-shell.spec.ts (VAY-2261): Booking Admin hosts the
// hotel setup wizard. The original stays until the marketplace-web spec folder is deleted.
import {
  mockAdaptiveSetupOwnerReads,
  ownerReadsExpectedMissingUrls,
} from "../support/adaptiveSetupOwnerReads";
import { mockBookingDashboardExit, mockSetupExitHandoff } from "../support/setupExitHandoff";
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
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Booking Admin offers the Hotel Operations track only, so its route is always the 8-step one.
const routeScenarios: Array<{
  name: string;
  selectedTracks: SetupTrack[];
  resumeStepId: PropertySetupStepId;
  expectedStep: number;
  expectedTotal: number;
  expectedHeading: string;
}> = [
  {
    name: "Hotel Operations",
    selectedTracks: ["hotel_operations"],
    resumeStepId: "calendar",
    expectedStep: 6,
    expectedTotal: 8,
    expectedHeading: "Open your calendar",
  },
];

test.describe("adaptive hotel setup shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(
      /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
      async (route) => {
        if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
        await route.fulfill({ headers: corsHeaders(route), json: { import: null } });
      },
    );
  });
  // Guest rules are saved as confirmed owner choices, not as a setup draft (VAY-1543), so
  // leaving with unsaved edits stops on the step instead of saving an incomplete draft.
  test("Exit setup keeps unsaved guest rules on the step and saves no draft", async ({
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
        resumeStepId: "guest_experience",
      }),
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        request.method() !== "GET" &&
        request.method() !== "OPTIONS" &&
        /\/(?:setup-drafts\/|guest-(?:rules|terms)$|auth\/handoff\/create$)/.test(pathname)
      ) {
        writes.push(`${request.method()} ${pathname}`);
      }
    });
    await page.goto(setupUrl(baseURL, { step: "guest_experience" }));
    await page.getByRole("combobox", { name: /Guest language/ }).selectOption("en");
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();

    await expect(page.getByText("Save your guest rules before leaving this step.")).toBeVisible();
    await expect(page).toHaveURL(/[?&]step=guest_experience(?:&|$)/);
    await expect(page.getByRole("combobox", { name: /Guest language/ })).toHaveValue("en");
    expect(writes).toEqual([]);
  });

  test("review entry, independent commands and reload recovery", async ({ page, baseURL }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "review",
      }),
    );
    test.setTimeout(60_000);
    const writes = await mockReviewProducts(page);
    const destination = await mockBookingDashboardExit(page, baseURL, propertyId);
    await page.goto(setupUrl(baseURL, { step: "review" }));
    await expect(
      page.getByRole("heading", { name: "Creator Marketplace", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Publish booking page", exact: true }),
    ).toBeEnabled();
    expect(writes).toHaveLength(0);
    await page.getByRole("button", { name: "Publish booking page", exact: true }).click();
    await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
    const accepted = [...writes];
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
    expect(writes).toEqual(accepted);
    await expect(page.getByRole("button", { name: "Finish for now", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("review.png"), fullPage: true });
    await page.getByRole("button", { name: "Finish for now", exact: true }).click();
    await expect(page).toHaveURL(destination);
    await page.goto(setupUrl(baseURL, { step: "review" }));
    await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
    expect(writes).toEqual(accepted);
  });

  test("Review opens and focuses the exact room without losing return context", async ({
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
        resumeStepId: "review",
      }),
    );
    await mockReviewProducts(page, false, true);
    await page.goto(
      setupUrl(baseURL, { step: "review", returnProduct: "pms", returnTo: "/calendar" }),
    );
    await page.getByRole("button", { name: "Edit rooms", exact: true }).click();
    await expect(page).toHaveURL(/step=rooms/);
    await expect(page).toHaveURL(/entity=33333333-3333-4333-8333-333333333333/);
    await expect(page).toHaveURL(/returnProduct=pms/);
    await expect(page.getByRole("textbox", { name: "Room type name", exact: true })).toBeFocused();
  });

  test("Booking recovers the accepted publish command after an interrupted response", async ({
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
        resumeStepId: "review",
      }),
    );
    const writes = await mockReviewProducts(page, true);
    await page.goto(setupUrl(baseURL, { step: "review" }));
    await page.getByRole("button", { name: "Publish booking page", exact: true }).click();
    await expect(page.getByText("Synthetic response interruption")).toHaveCount(1);
    expect(writes).toHaveLength(1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Publishing booking page…", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
  });

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
      entryProduct: "booking",
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
        selectedTracks: ["hotel_operations"],
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
      entryProduct: "booking",
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
                  requestedProduct: "booking",
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
        selectedTracks: ["hotel_operations"],
        resumeStepId: "booking_design",
      }),
    );
    const url = new URL(setupUrl(baseURL, { step: "payments" }));
    url.searchParams.delete("propertyId");
    await page.goto(url.toString());
    await expect(page.getByRole("heading", { name: "Choose hotel" })).toBeVisible();
    await page.getByRole("button", { name: /Alpenrose Hotel/ }).click();
    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/step=booking_design/);
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
      const assertHealthy = watchPageHealth(page, testInfo, {
        expectedMissingUrls: ownerReadsExpectedMissingUrls,
      });
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
      await expect(page.getByText("Tell creators what you are open to")).toHaveCount(0);
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
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: ownerReadsExpectedMissingUrls,
    });
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
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
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: ownerReadsExpectedMissingUrls,
    });
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
    await expect(page.getByText("Step 5 of 8")).toBeVisible();

    await page.goBack();

    const restoredHeading = page.getByRole("heading", {
      name: "Open your calendar",
      level: 1,
    });
    await expect(restoredHeading).toBeVisible();
    await expect(restoredHeading).toBeFocused();
    await expect(page.getByText("Step 6 of 8")).toBeVisible();
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

  test("Exit setup is keyboard accessible and hands a booking entrant to its own dashboard", async ({
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
    const returnTo = "/dashboard?view=bookings";
    const destination = await mockBookingDashboardExit(page, baseURL, propertyId);

    await page.goto(setupUrl(baseURL, { returnTo }));
    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();

    const exit = page.getByRole("button", { name: "Exit setup", exact: true });
    await exit.focus();
    await expect(exit).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(destination);
  });

  // A hotel that came from the PMS still leaves through the pms-web handoff; a Booking Admin
  // hotel stays on this origin.
  for (const target of [
    { product: "booking" as const, label: "Booking Admin", exit: "its own dashboard" },
    { product: "pms" as const, label: "PMS", exit: "incomplete PMS setup" },
  ]) {
    test(`Exit setup hands a ${target.label} entrant to ${target.exit}`, async ({
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
      const destination =
        target.product === "pms"
          ? await mockSetupExitHandoff(page, baseURL, propertyId, undefined, {
              sourceSurface: "booking-admin",
            })
          : await mockBookingDashboardExit(page, baseURL, propertyId);

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
    const destination = await mockSetupExitHandoff(
      page,
      baseURL,
      propertyId,
      "/settings#calendar",
      { sourceSurface: "booking-admin" },
    );
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
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo, {
      expectedMissingUrls: ownerReadsExpectedMissingUrls,
    });
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
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo, {
      expectedMissingUrls: ownerReadsExpectedMissingUrls,
    });
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Step 5 of 8")).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthyAfterRecovery();
  });

  test("keeps the shell and step content full-width without horizontal overflow on mobile", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo, {
      expectedMissingUrls: ownerReadsExpectedMissingUrls,
    });
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
      entryProduct: "booking",
      organizationId: "11111111-1111-4111-8111-111111111111",
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
    returnProduct?: "booking" | "pms";
    returnTo?: string;
  } = {},
): string {
  const query = new URLSearchParams({
    entryProduct: "booking",
    returnProduct: overrides.returnProduct ?? "booking",
    returnTo: overrides.returnTo ?? "/dashboard",
    propertyId,
  });
  if (overrides.step) query.set("step", overrides.step);
  if (!baseURL) return `/setup?${query.toString()}`;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3003") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

// A hotel that did not come from the PMS leaves setup on this origin, without an auth handoff:
// the host assigns `/dashboard?setup=incomplete&propertyId=…` and the dashboard enters the hotel.
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
    // Any product write from shell navigation is a bug; the Marketplace prefix stays forbidden
    // even though this host has no Marketplace step.
    (writesOwner && /^\/api\/(?:booking|finance|marketplace|pms|distribution)\//.test(pathname))
  );
}

// Review on this host shows the Booking Engine card only; its publish command is mocked here.
async function mockReviewProducts(page: Page, loseResponse = false, blockedRooms = false) {
  const writes: Array<{ key: string | undefined; body: unknown }> = [];
  const product = "booking" as const;
  const source = {
    ownerDomain: product,
    entityType: "settings",
    entityId: blockedRooms ? "33333333-3333-4333-8333-333333333333" : propertyId,
    revision: "1",
  };
  const readiness = await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product,
    status: blockedRooms ? "blocked" : "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [source],
    },
    groups: READINESS_GROUP_IDS_BY_PRODUCT[product].map((groupId) => {
      const blocked = blockedRooms && groupId === "booking.rooms";
      const status = blocked ? ("blocked" as const) : ("ready" as const);
      const owningStepId = blocked ? ("rooms" as const) : ("booking_design" as const);
      return {
        groupId,
        status,
        steps: [
          {
            owningStepId,
            status,
            entities: [
              {
                source,
                status,
                blockers: blocked
                  ? [
                      {
                        kind: "user_fixable" as const,
                        code: "room_capacity_missing",
                        message: "Add room capacity.",
                        product,
                        groupId,
                        owningStepId,
                        source,
                      },
                    ]
                  : [],
              },
            ],
          },
        ],
      };
    }),
    evaluatedAt: new Date().toISOString(),
  });
  let accepted = false;
  const now = new Date().toISOString();
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
  await page.route(
    /\/api\/hotel-setup\/properties\/[^/]+\/publications\/booking(?:\?|$)/,
    async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (request.method() === "POST") {
        writes.push({ key: request.headers()["idempotency-key"], body: request.postDataJSON() });
        accepted = true;
        if (loseResponse)
          return route.fulfill({
            status: 503,
            headers: corsHeaders(route),
            json: { detail: "Synthetic response interruption" },
          });
        return route.fulfill({ status: 202, headers: corsHeaders(route), json: operation });
      }
      const recovered = accepted && !!request.headers()["idempotency-key"];
      await route.fulfill({
        headers: corsHeaders(route),
        json: {
          contractVersion: "booking-publication-review.v1",
          propertyId,
          activeContentRevisionId: null,
          publishedUrl: null,
          latestOperation: accepted ? operation : null,
          recoveredOperation: recovered ? operation : null,
          readiness,
        },
      });
    },
  );
  return writes;
}
