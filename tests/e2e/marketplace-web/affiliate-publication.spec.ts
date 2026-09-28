import { expect, test, type Page, type Route } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const offerId = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const destinationId = "55555555-5555-4555-8555-555555555555";
const policyId = "66666666-6666-4666-8666-666666666666";

test("publishes the exact hotel offer after actionable recovery on desktop and mobile", async ({
  page,
}, testInfo) => {
  const noLegacy = watchNoLegacyCalls(page, testInfo, "marketplace-web-offer-discovery");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(
    ({ propertyId }) => {
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("selectedSharedPropertyId", propertyId);
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
    },
    { propertyId },
  );
  const publications: Array<{ body: unknown; key: string }> = [];
  await page.route(/\/(?:api|auth)\//, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith("/auth/session")) {
      json = {
        accessToken: "hotel-access",
        organizationId,
        organizationKind: "hotel_group",
        user: { id: "owner", email: "owner@example.test", name: "Hotel Owner", status: "active" },
      };
    } else if (path.endsWith("/hotel-setup/status")) {
      json = createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId,
        organizationDisplayName: "Alpenrose",
        propertyId,
        propertyDisplayName: "Hotel Alpenrose",
      });
    } else if (path.endsWith(`/hotel-setup/properties/${propertyId}/profile`)) {
      json = propertyProfile();
    } else if (path.endsWith("/public-profile")) {
      json = {
        propertyId,
        profileRevision: 1,
        publicProfile: { locale: "en", shortDescription: null, longDescription: null, media: [] },
      };
    } else if (path.endsWith(`/marketplace/properties/${propertyId}/profile`)) {
      json = {
        propertyId,
        profileStatus: "verified",
        profileComplete: true,
        hostSummary: "Independent alpine hotel.",
        collaborationGuidelines: null,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      };
    } else if (path.endsWith("/profile-status")) {
      json = {
        profile_complete: true,
        missing_fields: [],
        missing_offers: false,
        completion_steps: [],
      };
    } else if (path.endsWith(`/marketplace/properties/${propertyId}/offers`)) {
      json = { offers: [affiliateOffer()] };
    } else if (path.endsWith("/affiliate-policies")) {
      json = {
        policies: [
          {
            id: policyId,
            rateBasisPoints: 1250,
            approved: true,
            createdAt: "2026-09-01T00:00:00Z",
          },
        ],
      };
    } else if (path.endsWith("/affiliate-destinations")) {
      json = { destinations: [destination()] };
    } else if (path.endsWith("/affiliate-draft")) {
      json = {
        revision: 3,
        draft: {
          id: draftId,
          terms: terms(),
          destination: destination(),
          commission: {
            status: "available",
            policyVersionId: policyId,
            policy: { percentageRate: "12.50", rateBasisPoints: 1250 },
          },
        },
      };
    } else if (path.endsWith("/affiliate-publications")) {
      publications.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"] ?? "",
      });
      if (publications.length === 1)
        return fulfill(
          route,
          {
            ok: false,
            code: "publication_blocked",
            reasons: ["settlement_currency_unavailable", "tracking_readiness_invalid"],
          },
          409,
        );
      return fulfill(
        route,
        {
          ok: true,
          termsVersionId: "77777777-7777-4777-8777-777777777777",
          programId: "88888888-8888-4888-8888-888888888888",
          replayed: true,
        },
        200,
      );
    }
    await fulfill(route, json);
  });

  await page.goto("/profile");
  await page.getByRole("button", { name: "Offers" }).click();
  await page.getByText("Affiliate creator bookings", { exact: true }).click();
  const publish = page.getByRole("button", { name: "Publish affiliate terms" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(page.getByRole("alert").filter({ hasText: "settlement currency" })).toContainText(
    "Repair the affiliate tracking configuration",
  );
  expect(publications[0]?.body).toEqual({ draftId, expectedRevision: 3 });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await publish.click();
  await expect(
    page.getByText(/terms version 77777777-7777-4777-8777-777777777777 published/),
  ).toBeVisible();
  expect(publications[1]?.key).toBe(publications[0]?.key);
  await expect(page.getByRole("button", { name: "Affiliate terms published" })).toBeDisabled();
  await noLegacy();
});

const fulfill = (route: Route, json: unknown, status = 200) =>
  route.fulfill({ status, headers: corsHeaders(route), json });

const destination = () => ({
  destinationVersionId: destinationId,
  configuration: {
    displayName: "Direct booking",
    bookingUrl: "https://booking.example.test/hotel",
  },
  trackingStatus: "not_validated",
  trackingReadiness: { status: "pending", missing: ["stay_completion"] },
});
const terms = () => ({
  bookingDestinationId: destinationId,
  financePolicyVersionId: policyId,
  attributionWindowDays: 14,
});

function propertyProfile() {
  return {
    propertyId,
    profileRevision: 1,
    profile: {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      location: {
        streetAddress: "One Way",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "email", value: "hotel@example.test", purpose: "general", isPublic: true },
      ],
    },
  };
}

function affiliateOffer() {
  return {
    offerId,
    mediaResourceId: "99999999-9999-4999-8999-999999999999",
    propertyId,
    offerStatus: "verified",
    title: "Affiliate creator bookings",
    offerSummary: "Earn from completed stays.",
    media: [],
    deliverables: [],
    compensationOptions: [
      {
        compensationOptionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        compensationType: "affiliate",
        availabilityMonths: ["January"],
        platforms: ["instagram"],
        freeStayMinNights: null,
        freeStayMaxNights: null,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: 12.5,
        minFollowers: null,
        currency: null,
        termsSummary: null,
      },
    ],
    creatorRequirements: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}
