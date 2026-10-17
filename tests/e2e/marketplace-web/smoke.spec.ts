import { expect, test, type Page } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom auth form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
  });

  test("@signup unified signup renders the custom form", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("heading", { name: /create your vayada account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByText(/hotel \/ property/i)).toHaveCount(0);
    await expect(page.getByText(/^creator$/i)).toHaveCount(0);
  });

  test("hotel onboarding saves manager details with initials before shared setup", async ({
    page,
  }) => {
    await primeBrowserState(page);
    const onboarding = await mockOnboardingAuth(page);
    await mockSharedSetupStatus(page);

    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Welcome to vayada", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Account created", { exact: true })).toBeVisible();
    await expect(page.getByText("Let’s set up your hotel account.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    // VAY-2260: the hotel path is the only one and is preselected.
    await expect(page.getByRole("radio", { name: /i manage a hotel/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /i’m a creator/i })).toHaveCount(0);
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    const profileHeading = page.getByRole("heading", { name: "Let’s create your profile" });
    await expect(profileHeading).toBeVisible();
    await expect(profileHeading).toBeFocused();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.test");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Manager initials: ?" })).toBeVisible();
    await expect(page.getByText("Optional", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter your first name.")).toBeVisible();
    await expect(page.getByText("Enter your last name.")).toBeVisible();
    await expect(page.getByText("Profile photo is required.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toHaveCount(0);
    await page.getByLabel("First name").fill("Mary Jane");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Phone number").fill("sdfdsfsfsdfdsf");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter a valid phone number.")).toBeVisible();
    await page.getByLabel("Phone number").clear();
    await expect(page.getByRole("img", { name: "Manager initials: MW" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter your phone number.")).toBeVisible();
    await page.getByLabel("Phone number").fill("+49 89 123456");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    expect(onboarding.personalMediaRequestCount()).toBe(0);
    await expect(
      page.getByText("Your account details are saved. Next, let’s set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up my first hotel" })).toBeFocused();
    expect(
      await page.getByTestId("signup-success-ring").evaluate((element) => ({
        name: getComputedStyle(element).animationName,
        iterations: getComputedStyle(element).animationIterationCount,
      })),
    ).toEqual({ name: "ping", iterations: "2" });
    expect(
      await page.getByTestId("signup-success-check").evaluate((element) => ({
        name: getComputedStyle(element).animationName,
        iterations: getComputedStyle(element).animationIterationCount,
      })),
    ).toEqual({ name: "bounce", iterations: "1" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .getByTestId("signup-success-ring")
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await page.getByRole("button", { name: "Set up my first hotel" }).click();

    await expect(page).toHaveURL(/\/setup\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("entryProduct")).toBe("marketplace");
    await expect(page.getByRole("heading", { name: "Choose how you’ll use vayada" })).toBeVisible();
    await expect(page.getByLabel("Creator Marketplace")).toBeVisible();
    await expect(page.getByLabel("Hotel Operations")).toBeVisible();
    await expect(page.getByText("We'd like to get to know you better")).toHaveCount(0);
    await expect(page.getByText("Which systems do you want to use?")).toHaveCount(0);
  });

  test("hotel invitation survives first-run signup and hands off only after redemption", async ({
    page,
  }, testInfo) => {
    const inviteCode = "VAY-browser-invite-1050";
    const inviteRequests: Array<{ path: string; body: unknown; authorization?: string }> = [];
    const requestedUrls: string[] = [];
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "marketplace-web-hotel-invites");
    page.on("request", (request) => requestedUrls.push(request.url()));

    await primeBrowserState(page);
    await mockCookieConsent(page);
    const onboarding = await mockOnboardingAuth(
      page,
      "hotel",
      "Mary Jane",
      "+49 89 123456",
      inviteCode,
    );
    await page.route(
      /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        const url = new URL(route.request().url());
        const body = route.request().postDataJSON();
        inviteRequests.push({
          path: url.pathname,
          body,
          authorization: route.request().headers().authorization,
        });
        expect(body).toEqual({ code: inviteCode });
        if (url.pathname.endsWith("/lookup")) {
          await route.fulfill({
            status: 200,
            headers: corsHeaders(route),
            json: {
              contractVersion: "hotel-account-invite.v1",
              identity: { emailHint: "o****@example.test" },
              organization: { displayName: "Alpenrose Hospitality" },
              property: { displayName: "Hotel Alpenrose" },
              selectedTracks: ["creator_marketplace"],
              handoffPath: "/setup",
              expiresAt: "2026-08-20T12:00:00.000Z",
            },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "hotel-account-invite.v1",
            status: "redeemed",
            selectedTracks: ["creator_marketplace"],
            handoffPath: "/setup",
          },
        });
      },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(
      page,
      /\/api\/hotel-setup\/status/,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hospitality",
        selectedTracks: ["creator_marketplace"],
        trackRevision: 1,
        propertyId: null,
        updatedAt: "2026-08-02T12:00:00.000Z",
      }),
    );

    await page.goto(`/invite#code=${inviteCode}`);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(
      page.getByRole("heading", { name: "Create your invited hotel account" }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /i manage a hotel/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /i’m a creator/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.getByLabel("First name").fill("Mary Jane");
    await page.getByLabel("Last name").fill("Watson");
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Manager initials: MW" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Set up my first hotel" }).click();

    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose" })).toBeVisible();
    await expect(page.getByText("Creator Marketplace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept and continue to setup" }).click();

    await expect(page).toHaveURL(/\/setup\?entryProduct=marketplace&returnProduct=marketplace$/);
    const lookups = inviteRequests.filter((request) => request.path.endsWith("/lookup"));
    expect(lookups).toHaveLength(2);
    expect(lookups.every((request) => request.authorization === undefined)).toBe(true);
    const redemption = inviteRequests.find((request) => request.path.endsWith("/redeem"));
    expect(redemption).toEqual({
      path: "/api/marketplace/hotel-account-invites/redeem",
      body: { code: inviteCode },
      authorization: "Bearer test-access-token",
    });
    expect(requestedUrls.some((url) => url.includes(inviteCode))).toBe(false);
    expect(onboarding.personalMediaRequestCount()).toBe(0);
    await assertNoLegacyCalls();
    await assertHealthy();
  });

  for (const scenario of [
    {
      label: "Hotel Operations",
      selectedTracks: ["hotel_operations"],
      entryProduct: "pms",
    },
    {
      label: "combined",
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      entryProduct: "marketplace",
    },
  ] as const) {
    test(`hotel invitation preserves the ${scenario.label} route intent`, async ({ page }) => {
      const inviteCode = `VAY-browser-${scenario.entryProduct}-invite`;
      await primeBrowserState(page);
      await mockInviteAuthenticatedHotel(page, inviteCode);
      await page.route(
        /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
        async (route) => {
          if (route.request().method() === "OPTIONS") {
            await fulfillCorsPreflight(route);
            return;
          }
          const url = new URL(route.request().url());
          const response = {
            contractVersion: "hotel-account-invite.v1",
            selectedTracks: [...scenario.selectedTracks],
            handoffPath: "/setup",
          };
          await route.fulfill({
            status: 200,
            headers: corsHeaders(route),
            json: url.pathname.endsWith("/lookup")
              ? {
                  ...response,
                  identity: { emailHint: "o****@example.test" },
                  organization: { displayName: "Alpenrose Hospitality" },
                  property: { displayName: "Hotel Alpenrose" },
                  expiresAt: "2026-08-20T12:00:00.000Z",
                }
              : { ...response, status: "redeemed" },
          });
        },
      );
      await routeJson(page, /\/api\/hotel-setup\/property-types/, {
        contractVersion: "adaptive-hotel-property-types.v1",
        propertyTypes: [{ value: "hotel", label: "Hotel" }],
      });
      await routeJson(
        page,
        /\/api\/hotel-setup\/status/,
        createAdaptiveHotelSetupStatusMock({
          entryProduct: scenario.entryProduct,
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationDisplayName: "Alpenrose Hospitality",
          selectedTracks: [...scenario.selectedTracks],
          trackRevision: 1,
          propertyId: null,
          updatedAt: "2026-08-02T12:00:00.000Z",
        }),
      );

      await page.goto(`/invite#code=${inviteCode}`);
      await page.getByRole("button", { name: "Accept and continue to setup" }).click();

      await expect(page).toHaveURL(
        new RegExp(
          `/setup\\?entryProduct=${scenario.entryProduct}&returnProduct=${scenario.entryProduct}$`,
        ),
      );
      await expect(
        page.getByRole("heading", { name: "Let’s get to know your hotel" }),
      ).toBeVisible();
    });
  }

  test("hotel invitation resumes an authenticated replay after a lost redemption response", async ({
    page,
  }) => {
    const inviteCode = "VAY-browser-lost-response";
    const requestedUrls: string[] = [];
    let lookupCalls = 0;
    let redemptionCalls = 0;
    let canonicalRedemptionCommitted = false;
    page.on("request", (request) => requestedUrls.push(request.url()));

    await primeBrowserState(page);
    await mockInviteAuthenticatedHotel(page, inviteCode);
    await page.route(
      /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        const url = new URL(route.request().url());
        expect(route.request().postDataJSON()).toEqual({ code: inviteCode });
        if (url.pathname.endsWith("/lookup")) {
          expect(route.request().headers().authorization).toBeUndefined();
          lookupCalls += 1;
          await route.fulfill({
            status: canonicalRedemptionCommitted ? 404 : 200,
            headers: corsHeaders(route),
            json: canonicalRedemptionCommitted
              ? {
                  code: "invite_not_available",
                  detail: "This hotel account invitation is invalid or no longer available.",
                }
              : {
                  contractVersion: "hotel-account-invite.v1",
                  identity: { emailHint: "o****@example.test" },
                  organization: { displayName: "Alpenrose Hospitality" },
                  property: { displayName: "Hotel Alpenrose" },
                  selectedTracks: ["creator_marketplace"],
                  handoffPath: "/setup",
                  expiresAt: "2026-08-20T12:00:00.000Z",
                },
          });
          return;
        }
        redemptionCalls += 1;
        if (!canonicalRedemptionCommitted) {
          canonicalRedemptionCommitted = true;
          await route.fulfill({
            status: 502,
            headers: corsHeaders(route),
            json: { code: "upstream_response_lost" },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "hotel-account-invite.v1",
            status: "already_redeemed",
            selectedTracks: ["creator_marketplace"],
            handoffPath: "/setup",
          },
        });
      },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(
      page,
      /\/api\/hotel-setup\/status/,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hospitality",
        selectedTracks: ["creator_marketplace"],
        trackRevision: 1,
        propertyId: null,
        updatedAt: "2026-08-02T12:00:00.000Z",
      }),
    );

    await page.goto(`/invite#code=${inviteCode}`);
    await page.getByRole("button", { name: "Accept and continue to setup" }).click();
    await expect(
      page.getByText("The invitation could not be accepted.", { exact: false }),
    ).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/setup\?entryProduct=marketplace&returnProduct=marketplace$/);
    expect(lookupCalls).toBe(2);
    expect(redemptionCalls).toBe(2);
    expect(requestedUrls.some((url) => url.includes(inviteCode))).toBe(false);
  });

  test("restored profile-ready sessions still show the onboarding handoff", async ({ page }) => {
    await primeBrowserState(page);
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "restored-hotel-token",
          csrfToken: "restored-hotel-csrf",
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationKind: "hotel_group",
          user: {
            id: "user-restored-hotel",
            email: "returning-owner@example.test",
            name: "Returning Owner",
            phone: "+49 89 123456",
            profilePictureUrl: "https://media.example/returning-owner.webp",
            profilePictureMediaObjectId: "media-returning-owner",
            status: "active",
          },
        },
      });
    });
    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await expect(
      page.getByText("Your account details are saved. Next, let’s set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up my first hotel" })).toBeVisible();
  });

  test("onboarding surfaces a stalled cold session instead of hanging", async ({ page }) => {
    await primeBrowserState(page);
    let sessionRequests = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      sessionRequests += 1;
      if (sessionRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.abort().catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "test-access-token",
          csrfToken: "test-csrf-token",
          user: {
            id: "user-pending-onboarding",
            email: "owner@example.test",
            status: "active",
          },
        },
      });
    });
    await page.goto("/onboarding");

    await expect(
      page.getByText("Loading your session took too long. Please try again."),
    ).toBeVisible({ timeout: 7_000 });
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Retry session" }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome to vayada — what brings you here?" }),
    ).toBeVisible();
  });

  test("redirects to login and blocks onboarding actions when the session check fails", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { error: "session_unavailable" },
      });
    });

    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toHaveCount(0);
  });
});

async function primeBrowserState(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
}



async function mockOnboardingAuth(
  page: Page,
  accountType: "hotel" | "creator" = "hotel",
  expectedFirstName = "Mary Jane",
  expectedPhone = "+49 89 123456",
  expectedInviteCode?: string,
) {
  let personalMediaRequests = 0;
  let onboarded = false;
  let accountName: string | null = null;
  let accountPhone: string | null = "+49 89 123456";
  let accountProfilePictureUrl: string | null = null;
  let accountProfilePictureMediaObjectId: string | null = null;
  const guestSession = {
    accessToken: "test-access-token",
    csrfToken: "test-csrf-token",
    user: {
      id: "user-pending-onboarding",
      email: "owner@example.test",
      status: "active",
    },
  };
  const onboardedSession = {
    ...guestSession,
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: accountType === "creator" ? "creator_workspace" : "hotel_group",
  };

  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...(onboarded ? onboardedSession : guestSession),
        user: {
          ...(onboarded ? onboardedSession.user : guestSession.user),
          name: accountName,
          phone: accountPhone,
          profilePictureUrl: accountProfilePictureUrl,
          profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
        },
      },
    });
  });
  await page.route(/\/auth\/session\/refresh$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...onboardedSession,
        user: {
          ...onboardedSession.user,
          name: accountName,
          phone: accountPhone,
          profilePictureUrl: accountProfilePictureUrl,
          profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
        },
      },
    });
  });
  await page.route(/\/auth\/onboarding$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    expect(route.request().postDataJSON()).toEqual({
      type: accountType,
      surface: "marketplace-web",
      ...(expectedInviteCode ? { inviteCode: expectedInviteCode } : {}),
    });
    onboarded = true;
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...onboardedSession,
        user: { ...onboardedSession.user, name: accountName, phone: accountPhone },
      },
    });
  });
  await page.route(/\/auth\/profile$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    const payload = route.request().postDataJSON() as {
      firstName?: string;
      lastName?: string;
      phone?: string;
      profilePictureUrl?: string;
      profilePictureMediaObjectId?: string;
    };
    expect(payload).toMatchObject({
      firstName: expectedFirstName,
      lastName: "Watson",
      phone: expectedPhone,
    });
    if (accountType === "creator") {
      expect(payload).toMatchObject({
        profilePictureUrl: "https://media.example/profile.png",
        profilePictureMediaObjectId: "media-profile-e2e",
      });
    } else {
      expect(payload).not.toHaveProperty("profilePictureUrl");
      expect(payload).not.toHaveProperty("profilePictureMediaObjectId");
    }
    accountName =
      payload.firstName && payload.lastName ? `${payload.firstName} ${payload.lastName}` : null;
    accountPhone = payload.phone?.trim() || null;
    accountProfilePictureUrl = payload.profilePictureUrl?.trim() || null;
    accountProfilePictureMediaObjectId = payload.profilePictureMediaObjectId?.trim() || null;
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
  });
  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    personalMediaRequests += 1;
    if (route.request().url().endsWith("/finalize")) {
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          mediaObjects: [
            {
              mediaId: "media-profile-e2e",
              storageKey: "staging/profile-e2e/ada.png",
              variants: [
                {
                  publicCdnUrl: "https://media.example/profile.png",
                },
              ],
            },
          ],
        },
      });
      return;
    }
    expect(route.request().postDataJSON()).toMatchObject({
      purpose: "identity.user.profile_image",
      resource: {
        product: "platform",
        resourceType: "user_profile",
        resourceId: "user-pending-onboarding",
      },
    });
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        uploadSession: { sessionId: "profile-e2e" },
        uploadTargets: [
          {
            uploadTargetId: "profile-target-e2e",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/profile-e2e",
            headers: {},
          },
        ],
      },
    });
  });
  await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
    connections: [],
  });
  return { personalMediaRequestCount: () => personalMediaRequests };
}

async function mockInviteAuthenticatedHotel(page: Page, inviteCode: string) {
  const session = {
    accessToken: "invite-hotel-access-token",
    csrfToken: "invite-hotel-csrf-token",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: "hotel_group",
    user: {
      id: "user-invited-owner",
      email: "owner@example.test",
      name: "Invited Owner",
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/invited-owner.png",
      profilePictureMediaObjectId: "media-invited-owner",
      status: "active",
    },
  };
  await routeJson(page, /\/auth\/session(?:\?|$)/, session);
  await page.route(/\/auth\/onboarding$/, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      type: "hotel",
      surface: "marketplace-web",
      inviteCode,
    });
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: session });
  });
}

async function mockSharedSetupStatus(page: Page) {
  await routeJson(page, /\/api\/hotel-setup\/property-types/, {
    contractVersion: "adaptive-hotel-property-types.v1",
    propertyTypes: [{ value: "hotel", label: "Hotel" }],
  });
  await routeJson(
    page,
    /\/api\/hotel-setup\/status/,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Test Hotel Group",
      selectedTracks: [],
      trackRevision: 0,
      propertyId: null,
      updatedAt: "2026-07-08T00:00:00.000Z",
    }),
  );
}

async function mockCookieConsent(page: Page) {
  await routeJson(page, /\/api\/identity\/consent\/cookies(?:\?|$)/, {
    id: "consent-e2e",
    visitor_id: "visitor-e2e",
    user_id: null,
    necessary: true,
    functional: true,
    analytics: false,
    marketing: false,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
  });
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
