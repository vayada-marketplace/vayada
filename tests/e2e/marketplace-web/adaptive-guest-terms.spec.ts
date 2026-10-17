import { expect, test, type Page, type Route } from "@playwright/test";
import { mockAdaptiveSetupOwnerReads } from "../support/adaptiveSetupOwnerReads";
import {
  createPropertySetupRouteMock,
  mockPropertySetupRoute,
} from "../support/propertySetupRouteMocks";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rulesRevision = "55555555-5555-4555-8555-555555555555";
const choices = {
  defaultGuestLanguage: "en",
  childrenEnabled: true,
  adultAgeThreshold: 18,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};

// VAY-2176: the Guest experience step pre-fills starting guest terms for a hotel without any.
test.describe("adaptive setup guest terms", () => {
  test("pre-fills the starting terms and saves them with the guest rules", async ({
    page,
    baseURL,
  }, testInfo) => {
    const writes = await openGuestStep(page, baseURL, null);
    const terms = page.getByRole("textbox", { name: "Terms & Conditions", exact: true });
    await expect(terms).toHaveValue(
      /^These Terms & Conditions apply to stays booked on our booking page\./,
    );
    await expect(
      page.getByText("We've added a starting text. Edit it to match how you work."),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("guest-terms-starting.png"),
      fullPage: true,
    });
    await page
      .getByRole("checkbox", {
        name: "I confirm these guest rules, arrival times and terms & conditions.",
      })
      .check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(() => writes.terms.length).toBe(1);
    expect(writes.rules).toHaveLength(1);
    expect(writes.terms[0]!.termsText).toMatch(/^These Terms & Conditions apply/);
    expect(writes.terms[0]!.termsText).toContain("5. Contact");
    expect(writes.terms[0]!.expectedTermsText).toBeNull();
    await expect(page).toHaveURL(/[?&]step=review(?:&|$)/);
  });

  test("keeps a hotel's own terms and warns before saving them empty", async ({
    page,
    baseURL,
  }, testInfo) => {
    const writes = await openGuestStep(page, baseURL, "Our own house terms.");
    const terms = page.getByRole("textbox", { name: "Terms & Conditions", exact: true });
    await expect(terms).toHaveValue("Our own house terms.");
    await expect(page.getByText("We've added a starting text.", { exact: false })).toHaveCount(0);
    await terms.fill("");
    await expect(
      page.getByText(
        "Without terms & conditions, guests won't see any terms when they book. We recommend keeping at least the starting text.",
      ),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("guest-terms-cleared.png"), fullPage: true });
    await page
      .getByRole("checkbox", {
        name: "I confirm these guest rules, arrival times and terms & conditions.",
      })
      .check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect
      .poll(() => writes.terms)
      .toEqual([{ termsText: null, expectedTermsText: "Our own house terms." }]);
  });
});

async function openGuestStep(page: Page, baseURL: string | undefined, saved: string | null) {
  await mockAdaptiveSetupOwnerReads(page);
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
  await mockAuthSession(page);
  await mockPropertySetupRoute(
    page,
    createPropertySetupRouteMock({
      propertyId,
      selectedTracks: ["hotel_operations"],
      resumeStepId: "guest_experience",
      stepStates: {
        present_hotel: "complete",
        booking_design: "complete",
        rooms: "complete",
        payments: "complete",
        pricing: "complete",
        calendar: "complete",
      },
    }),
  );
  const writes = {
    rules: [] as Record<string, unknown>[],
    terms: [] as { termsText: string | null; expectedTermsText: string | null }[],
  };
  await page.route(
    new RegExp(`/api/booking/properties/${propertyId}/guest-rules(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() === "GET")
        return ok(route, { current: { revision: rulesRevision, choices } });
      writes.rules.push(route.request().postDataJSON());
      await ok(route, { revision: rulesRevision.replace(/5/g, "6"), replayed: false });
    },
  );
  await page.route(
    new RegExp(`/api/booking/properties/${propertyId}/guest-terms(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() === "GET") return ok(route, { termsText: saved });
      const body = route.request().postDataJSON() as (typeof writes.terms)[number];
      writes.terms.push(body);
      await ok(route, { termsText: body.termsText });
    },
  );
  await page.goto(setupUrl(baseURL));
  await expect(
    page.getByRole("heading", { name: "Configure the guest experience", level: 1 }),
  ).toBeVisible();
  return writes;
}

async function mockAuthSession(page: Page) {
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await ok(route, null);
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await ok(route, {
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
    });
  });
}

function setupUrl(baseURL: string | undefined) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    step: "guest_experience",
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
