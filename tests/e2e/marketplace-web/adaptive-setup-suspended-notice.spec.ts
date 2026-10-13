import { expect, test, type Page } from "@playwright/test";
import type { SetupTrack } from "@vayada/domain-hotels";
import { mockAdaptiveSetupOwnerReads } from "../support/adaptiveSetupOwnerReads";
import {
  createPropertySetupRouteMock,
  mockPropertySetupRoute,
} from "../support/propertySetupRouteMocks";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const notice = "Your Creator Marketplace profile is suspended";

// VAY-2177: a hotel with a suspended Marketplace profile learns it at the start of setup.
test.describe("adaptive setup Marketplace suspension notice", () => {
  test("shows the notice during setup, with the booking page still possible", async ({
    page,
    baseURL,
  }, testInfo) => {
    await openSetup(page, baseURL, ["hotel_operations", "creator_marketplace"]);
    const status = page.getByRole("note").filter({ hasText: notice });
    await expect(status).toBeVisible();
    await expect(status).toContainText(
      "Creators can't find your hotel on the Marketplace right now, and finishing setup won't change that. You can still finish setup and publish your booking page. To ask about your Marketplace profile, contact support@vayada.com.",
    );
    await expect(status.getByRole("link", { name: "support@vayada.com" })).toHaveAttribute(
      "href",
      "mailto:support@vayada.com",
    );
    await page.screenshot({ path: testInfo.outputPath("suspended-notice.png"), fullPage: true });
  });

  test("leaves out the booking page for a Marketplace-only hotel", async ({ page, baseURL }) => {
    await openSetup(page, baseURL, ["creator_marketplace"]);
    const status = page.getByRole("note").filter({ hasText: notice });
    await expect(status).toContainText("You can still finish setup. To ask about");
    await expect(status).not.toContainText("booking page");
  });
});

async function openSetup(page: Page, baseURL: string | undefined, selectedTracks: SetupTrack[]) {
  await mockAdaptiveSetupOwnerReads(page);
  await mockHotelSetupPrerequisites(
    page,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId,
      organizationDisplayName: "Test hotel group",
      propertyId,
      selectedTracks,
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
  await mockAuthSession(page);
  await page.route(
    /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      await route.fulfill({ headers: corsHeaders(route), json: { import: null } });
    },
  );
  const model = createPropertySetupRouteMock({
    propertyId,
    selectedTracks,
    resumeStepId: "marketplace_preferences",
    stepStates: { present_hotel: "complete" },
  });
  // The Review step carries the suspension blocker the API sends for a suspended listing.
  const review = model.steps.find(({ stepId }) => stepId === "review")!;
  review.state = "blocked";
  review.blockers = [
    {
      code: "marketplace_profile_suspended",
      product: "marketplace",
      ownerDomain: "marketplace",
      owningStepId: "review",
      owningStepPosition: review.position,
      message:
        "The Marketplace profile is suspended. Contact support for the available next action.",
      kind: "external_pending",
      sourceRevision: "marketplace:suspended:e2e:1",
    },
  ];
  await mockPropertySetupRoute(page, model);
  await page.goto(setupUrl(baseURL));
  await expect(
    page.getByRole("heading", { name: "Tell creators what you are open to", level: 1 }),
  ).toBeVisible();
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

function setupUrl(baseURL: string | undefined) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    step: "marketplace_preferences",
  });
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}
