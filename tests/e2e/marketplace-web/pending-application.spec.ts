import { expect, test, type Page } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test("creator edits a pending request, retries failures, and cancels it", async ({ page }) => {
  await primeCreatorSession(page);
  await mockCreatorProfile(page);
  let collaboration = {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "creator_workspace_resource_link",
    collaborationId: "request-953",
    offerId: "offer-953",
    creatorId: "creator-profile-e2e",
    hotelProfileId: "hotel-953",
    side: "creator",
    initiatorSide: "creator",
    isInitiator: true,
    status: "pending",
    compensationType: "paid",
    propertyTimezone: "Europe/Berlin",
    offerTitle: "Creator stay",
    hotelLocation: "Berlin",
    applicationMessage: "Original pitch",
    selectedCompensationOptionId: "paid-953",
    creator: {
      side: "creator",
      organizationId: "creator-org",
      profileId: "creator-profile-e2e",
      displayName: "Lina Creator",
      avatarUrl: null,
      location: "Berlin",
      portfolioUrl: null,
      creatorType: "travel",
      platforms: [],
    },
    hotel: {
      side: "hotel",
      organizationId: "hotel-org",
      profileId: "hotel-953",
      displayName: "Berlin Hotel",
      avatarUrl: null,
    },
    terms: {
      paidAmount: "900",
      currency: "EUR",
      freeStayMinNights: null,
      freeStayMaxNights: null,
      discountPercentage: null,
      affiliateEnabled: false,
      affiliateCommissionPercentage: null,
      travelDateFrom: "2027-09-01",
      travelDateTo: "2027-09-03",
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredMonths: [],
    },
    deliverables: [
      {
        deliverableId: "d-953",
        platform: "Instagram",
        type: "Reel",
        quantity: 1,
        status: "pending",
        completedAt: null,
      },
      {
        deliverableId: "story-953",
        platform: "Instagram",
        type: "Story",
        quantity: 3,
        status: "pending",
        completedAt: null,
      },
    ],
    createdAt: "2026-09-01T01:00:00.000Z",
    updatedAt: "2026-09-05T01:00:00.000Z",
    lastMessageAt: null,
    cancelledBy: null as string | null,
  };
  await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
    items: [
      {
        offerId: "offer-953",
        offerPublicId: "offer-public-953",
        offerTitle: "Creator stay",
        offerSummary: "A creator visit",
        hotelName: "Berlin Hotel",
        hotelSlug: "berlin-hotel",
        hotelAccommodationType: "hotel",
        hotelLocation: { displayText: "Berlin", countryCode: "DE" },
        hotelCoverImageUrl: null,
        hotelImageUrls: [],
        deliverables: [],
        creatorRequirements: null,
        compensationOptions: [
          {
            compensationOptionId: "paid-953",
            compensationType: "paid",
            availabilityMonths: [],
            platforms: [],
            paidMaxAmount: "900",
            currency: "EUR",
            freeStayMinNights: null,
            freeStayMaxNights: null,
            discountPercentage: null,
            commissionPercentage: null,
          },
        ],
        createdAt: collaboration.createdAt,
        projectedAt: collaboration.updatedAt,
      },
    ],
    pagination: { total: 1, offset: 0, limit: 200 },
  });
  await page.route(/\/api\/marketplace\/collaborations\/me(?:\?|$)/, (route) =>
    route.fulfill({ headers: corsHeaders(route), json: { items: [collaboration] } }),
  );
  await routeJson(page, /\/api\/marketplace\/collaborations\/conversations(?:\?|$)/, {
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  await page.route(/\/api\/marketplace\/collaborations\/request-953(?:\?|$)/, (route) =>
    route.fulfill({ headers: corsHeaders(route), json: collaboration }),
  );
  let edits = 0;
  await page.route(/\/collaborations\/request-953\/application$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    edits++;
    const body = route.request().postDataJSON();
    expect(body.expectedUpdatedAt).toBe("2026-09-05T01:00:00.000Z");
    expect(body.compensationOptionId).toBe("paid-953");
    expect(body.deliverables).toMatchObject([
      { platform: "Instagram", type: "Reel", quantity: 1 },
      { platform: "Instagram", type: "Story", quantity: 3 },
    ]);
    if (edits === 1)
      return route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { message: "Save failed" },
      });
    collaboration = {
      ...collaboration,
      applicationMessage: body.whyGreatFit,
      updatedAt: "2026-09-05T02:00:00.000Z",
    };
    return route.fulfill({ headers: corsHeaders(route), json: { collaboration } });
  });
  let cancels = 0;
  await page.route(/\/collaborations\/request-953\/cancel$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    cancels++;
    expect(route.request().postDataJSON().pendingOnly).toBe(true);
    if (cancels === 1)
      return route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { message: "Cancel failed" },
      });
    collaboration = { ...collaboration, status: "cancelled", cancelledBy: "creator" };
    return route.fulfill({ headers: corsHeaders(route), json: { collaboration } });
  });
  await page.goto("/chat");
  await page.getByRole("button", { name: /^Sent/ }).click();
  await page.getByText("Berlin Hotel", { exact: true }).click();
  await page.getByRole("button", { name: "Edit Request", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Request", exact: true });
  const pitch = dialog.locator("textarea");
  await expect(pitch).toHaveValue("Original pitch");
  await pitch.fill("Updated pitch");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog.getByText("Save failed", { exact: true })).toBeVisible();
  await expect(pitch).toHaveValue("Updated pitch");
  await dialog.getByRole("button", { name: "Save Changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Updated pitch", { exact: true })).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel Request" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Cancel failed" })).toHaveText(
    "Cancel failed",
  );
  await expect(page.getByRole("button", { name: "Edit Request" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Request" }).click();
  await expect(page.getByText("Cancelled by creator", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Request" })).toHaveCount(0);
});

test("creator finds the stable affiliate link after collaboration completion", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "marketplace-web-offer-discovery");
  await page.setViewportSize({ width: 1280, height: 800 });
  await primeCreatorSession(page);
  await mockCreatorProfile(page);
  await routeJson(page, /\/api\/identity\/consent\/cookies(?:\?|$)/, {
    necessary: true,
    functional: true,
    analytics: false,
    marketing: false,
  });
  const collaboration = completedAffiliateCollaboration();
  await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
    items: [],
    pagination: { total: 0, offset: 0, limit: 200 },
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/me(?:\?|$)/, {
    items: [collaboration],
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/conversations(?:\?|$)/, {
    items: [
      {
        contractVersion: "marketplace-collaboration-reads.v1",
        collaborationId: "affiliate-e2e",
        side: "creator",
        partnerName: "Alpine House",
        partnerAvatarUrl: null,
        offerTitle: "Alpine creator partnership",
        collaborationStatus: "completed",
        lastMessageContent: "Partnership complete",
        lastMessageAt: "2026-09-25T01:00:00.000Z",
        unreadCount: 0,
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/affiliate-e2e(?:\?|$)/, collaboration);
  await routeJson(page, /\/collaborations\/affiliate-e2e\/messages(?:\?|$)/, {
    contractVersion: "marketplace-collaboration-reads.v1",
    collaborationId: "affiliate-e2e",
    authorizationMode: "creator_workspace_resource_link",
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  await routeJson(
    page,
    /\/collaborations\/affiliate-e2e\/affiliate-assent$/,
    completedAffiliateAgreement("active"),
  );
  let linkRequests = 0;
  await page.route(/\/collaborations\/affiliate-e2e\/affiliate-link$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    linkRequests++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        ok: true,
        contractVersion: "marketplace-affiliate-link.v1",
        linkId: "link-e2e",
        agreementId: "agreement-e2e",
        propertyId: "property-e2e",
        publicToken: "va_abcdefghijklmnopqrstuv",
        path: "/r/va_abcdefghijklmnopqrstuv",
        createdAt: "2026-09-29T08:00:00.000Z",
        replayed: false,
      },
    });
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await page.getByText("Alpine creator partnership", { exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Affiliate agreement active", { exact: true })).toBeVisible();
  await expect(page.getByText("12.5% of accommodation revenue", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Get affiliate link" }).click();
  await expect(page.getByLabel("Stable affiliate link")).toHaveText(
    "https://api.localhost/r/va_abcdefghijklmnopqrstuv",
  );
  await expect(page.getByRole("link", { name: "View results & earnings" })).toHaveAttribute(
    "href",
    "/earnings?propertyId=property-e2e",
  );
  expect(linkRequests).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await assertNoLegacyCalls();
  await assertHealthy();
});

test("hotel manages the retained affiliate agreement after collaboration completion", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "marketplace-web-offer-discovery");
  await primeHotelSession(page);
  const collaboration = {
    ...completedAffiliateCollaboration(),
    side: "hotel",
    isInitiator: false,
    authorizationMode: "hotel_org_resource_link",
  };
  await routeJson(page, /\/api\/identity\/consent\/cookies(?:\?|$)/, {
    necessary: true,
    functional: true,
    analytics: false,
    marketing: false,
  });
  await routeJson(
    page,
    /\/api\/hotel-setup\/status(?:\?|$)/,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "hotel-org",
      organizationDisplayName: "Alpine Group",
      propertyId: "property-e2e",
      propertyDisplayName: "Alpine House",
    }),
  );
  await routeJson(page, /\/api\/marketplace\/collaborations\/me(?:\?|$)/, {
    items: [collaboration],
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/conversations(?:\?|$)/, {
    items: [
      {
        contractVersion: "marketplace-collaboration-reads.v1",
        collaborationId: "affiliate-e2e",
        side: "hotel",
        partnerName: "Lina Creator",
        partnerAvatarUrl: null,
        offerTitle: "Alpine creator partnership",
        collaborationStatus: "completed",
        lastMessageContent: "Partnership complete",
        lastMessageAt: "2026-09-25T01:00:00.000Z",
        unreadCount: 0,
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  await routeJson(page, /\/api\/marketplace\/collaborations\/affiliate-e2e(?:\?|$)/, collaboration);
  await routeJson(page, /\/collaborations\/affiliate-e2e\/messages(?:\?|$)/, {
    contractVersion: "marketplace-collaboration-reads.v1",
    collaborationId: "affiliate-e2e",
    authorizationMode: "hotel_org_resource_link",
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  let lifecycleStatus: "active" | "paused" = "active";
  await page.route(/\/collaborations\/affiliate-e2e\/affiliate-assent$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      headers: corsHeaders(route),
      json: completedAffiliateAgreement(lifecycleStatus),
    });
  });
  await page.route(/\/collaborations\/affiliate-e2e\/affiliate-lifecycle$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    expect(route.request().postDataJSON()).toMatchObject({ action: "pause", expectedRevision: 0 });
    lifecycleStatus = "paused";
    await route.fulfill({
      headers: corsHeaders(route),
      json: { ok: true, eventId: "event-e2e", revision: 1, replayed: false },
    });
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await page.getByText("Lina Creator", { exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("Affiliate agreement active", { exact: true })).toBeVisible();
  await expect(page.getByText("12.5% of accommodation revenue", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get affiliate link" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View results & earnings" })).toHaveAttribute(
    "href",
    "/earnings?propertyId=property-e2e",
  );
  await page.getByRole("button", { name: "Pause affiliate agreement" }).click();
  await expect(page.getByText("Affiliate agreement paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume affiliate agreement" })).toBeVisible();
  await assertNoLegacyCalls();
  await assertHealthy();
});

async function primeCreatorSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("userName", "Lina Creator");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
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
        accessToken: "creator-authkit-token",
        csrfToken: "creator-csrf-token",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationKind: "creator_workspace",
        user: {
          id: "user-creator-e2e",
          email: "creator@example.test",
          name: "Lina Creator",
          phone: "+49 89 123456",
          status: "active",
        },
      },
    });
  });
}

async function primeHotelSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("userType", "hotel");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("selectedSharedPropertyId", "property-e2e");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      headers: corsHeaders(route),
      json: {
        accessToken: "hotel-authkit-token",
        csrfToken: "hotel-csrf-token",
        organizationId: "hotel-org",
        organizationKind: "hotel_group",
        user: { id: "hotel-user", email: "hotel@example.test", name: "Alpine House" },
      },
    });
  });
}

async function mockCreatorProfile(page: Page) {
  await routeJson(page, /\/api\/marketplace\/creators\/me(?:\?|$)/, {
    creatorProfileId: "creator-profile-e2e",
    displayName: "Lina Creator",
    creatorType: "travel",
    locationText: "Berlin, Germany",
    shortDescription: "I create practical city guides for independent travelers.",
    portfolioUrl: "https://creator.example/portfolio",
    phone: "+49 89 123456",
    profilePictureUrl: "https://media.example/lina.png",
    profilePictureMediaObjectId: "media-lina",
    profileComplete: true,
    profileStatus: "active",
    platforms: [
      {
        platformId: "platform-instagram",
        platform: "instagram",
        handle: "@lina",
        profileUrl: "https://instagram.com/lina",
        followerCount: 1200,
        engagementRate: 4.2,
        audienceCountries: [],
        audienceAgeGroups: [],
        audienceGenderSplit: null,
      },
      {
        platformId: "platform-youtube",
        platform: "youtube",
        handle: "@linatravels",
        profileUrl: "https://youtube.com/@linatravels",
        followerCount: 800,
        engagementRate: 3.8,
        audienceCountries: [],
        audienceAgeGroups: [],
        audienceGenderSplit: null,
      },
    ],
    audienceSize: 2000,
    rating: { averageRating: 0, totalReviews: 0 },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  });
  await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
    profilePhotoRequired: true,
    profileComplete: true,
    missingFields: [],
    missingPlatforms: false,
    completionSteps: [],
  });
}

function completedAffiliateCollaboration() {
  return {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "creator_workspace_resource_link",
    collaborationId: "affiliate-e2e",
    offerId: "offer-e2e",
    creatorId: "creator-profile-e2e",
    hotelProfileId: "hotel-e2e",
    side: "creator",
    initiatorSide: "creator",
    isInitiator: true,
    status: "completed",
    compensationType: "paid",
    propertyTimezone: "Europe/Berlin",
    offerTitle: "Alpine creator partnership",
    hotelLocation: "Innsbruck",
    applicationMessage: "Alpine guide",
    selectedCompensationOptionId: "paid-e2e",
    creator: {
      side: "creator",
      organizationId: "creator-org",
      profileId: "creator-profile-e2e",
      displayName: "Lina Creator",
      avatarUrl: null,
      location: "Berlin",
      portfolioUrl: null,
      creatorType: "travel",
      platforms: [],
    },
    hotel: {
      side: "hotel",
      organizationId: "hotel-org",
      profileId: "hotel-e2e",
      displayName: "Alpine House",
      avatarUrl: null,
    },
    terms: {
      paidAmount: "900",
      currency: "EUR",
      freeStayMinNights: null,
      freeStayMaxNights: null,
      discountPercentage: null,
      affiliateEnabled: true,
      affiliateCommissionPercentage: "12.5",
      travelDateFrom: "2026-09-01",
      travelDateTo: "2026-09-03",
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredMonths: [],
    },
    deliverables: [],
    createdAt: "2026-09-01T01:00:00.000Z",
    updatedAt: "2026-09-25T01:00:00.000Z",
    lastMessageAt: null,
    cancelledBy: null,
  };
}

function completedAffiliateAgreement(status: "active" | "paused") {
  return {
    participationId: "participation-e2e",
    attemptId: "attempt-e2e",
    programId: "program-e2e",
    propertyId: "property-e2e",
    offerId: "offer-e2e",
    creatorProfileId: "creator-profile-e2e",
    origin: "application",
    revision: 2,
    assentState: "matched",
    terms: {
      id: "terms-e2e",
      disclosure: "12.5% of accommodation revenue · 14-day attribution window",
      disclosureHash: "hash-e2e",
    },
    hotelApprovedAt: "2026-09-20T08:00:00.000Z",
    creatorAcceptedAt: "2026-09-20T09:00:00.000Z",
    lifecycle: {
      status,
      revision: status === "active" ? 0 : 1,
      pausedBy: status === "paused" ? ["hotel"] : [],
    },
  };
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
}
