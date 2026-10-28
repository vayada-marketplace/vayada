import type { Page, Route } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./cors";
import { createAdaptiveHotelSetupStatusMock } from "./sharedHotelSetupMocks";

/**
 * VAY-2383: the Booking Admin first run (ONBOARDING_V2) for a hotel that exists, resuming at
 * "Your first room and price" (step 5 of 7). The server must run with ONBOARDING_V2_ENABLED=true.
 */
export const QUICK_SETUP_PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

export function quickSetupUrl(baseURL: string | undefined, propertyId = QUICK_SETUP_PROPERTY_ID) {
  const search = `?entryProduct=booking&returnProduct=booking&returnTo=/dashboard&propertyId=${propertyId}`;
  if (!baseURL) return `/setup${search}`;
  const url = new URL(baseURL);
  // The browser state (consent, hotel profile) is primed for localhost, as the other setup specs do.
  if (url.hostname === "127.0.0.1" && url.port === "3003") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = search;
  return url.toString();
}

export async function primeQuickSetupBrowserState(
  page: Page,
  propertyId = QUICK_SETUP_PROPERTY_ID,
) {
  await page.addInitScript((selectedPropertyId) => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
    localStorage.setItem("userType", "hotel");
    localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
  }, propertyId);
}

async function json(route: Route, body: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
  await route.fulfill({ status, headers: corsHeaders(route), json: body });
}

export function quickSetupProfile(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: 48.137,
      longitude: 11.575,
      localityPublic: true,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      { channelType: "phone", value: "+49 89 123456", purpose: "general", isPublic: true },
      {
        channelType: "email",
        value: "owner@alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
    ],
    ...overrides,
  };
}

export type QuickSetupMockState = {
  /** Every PUT of the hotel profile, in order. */
  profileWrites: Record<string, unknown>[];
  /** What the next profile PUT answers; 200 with the saved profile by default. */
  profilePutStatus: number;
  profileRevision: number;
};

/**
 * A complete owner session and every read the quick setup makes for an existing hotel whose first
 * run has not saved a room yet (so it opens on step 5, "Your first room and price").
 */
export async function mockQuickSetupExistingHotel(
  page: Page,
  propertyId = QUICK_SETUP_PROPERTY_ID,
): Promise<QuickSetupMockState> {
  const state: QuickSetupMockState = {
    profileWrites: [],
    profilePutStatus: 200,
    profileRevision: 4,
  };
  let profile = quickSetupProfile();
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    json(route, {
      accessToken: "test-access-token",
      csrfToken: "test-csrf-token",
      organizationId: ORGANIZATION_ID,
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
    }),
  );
  await page.route(/\/api\/hotel-setup\/imports\/prepared/, (route) =>
    json(route, { import: null }),
  );
  await page.route(/\/api\/hotel-setup\/status/, (route) =>
    json(
      route,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId: ORGANIZATION_ID,
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId,
        publicId: "prop_alpenrose",
        propertyDisplayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
      }),
    ),
  );
  await page.route(/\/api\/hotel-setup\/property-types/, (route) =>
    json(route, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [
        { value: "hotel", label: "Hotel" },
        { value: "guesthouse", label: "Guesthouse" },
        { value: "apartment", label: "Apartment" },
      ],
    }),
  );
  // The first run saved nothing yet: the hotel resumes at its first room and price.
  await page.route(new RegExp(`/api/hotel-setup/properties/${propertyId}/first-run$`), (route) =>
    json(route, {
      contractVersion: "hotel-first-run.v1",
      propertyId,
      steps: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map(
        (id) => ({ id, state: "todo" }),
      ),
      nextStep: "currency",
    }),
  );
  await page.route(new RegExp(`/api/hotel-setup/properties/${propertyId}/profile$`), (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.profileWrites.push(body);
      if (state.profilePutStatus !== 200)
        return json(route, { code: "profile_conflict" }, state.profilePutStatus);
      state.profileRevision += 1;
      const patch = body["patch"] as Record<string, unknown>;
      profile = {
        ...profile,
        ...patch,
        location: { ...profile.location, ...((patch["location"] as object) ?? {}) },
      };
    }
    return json(route, { propertyId, profileRevision: state.profileRevision, profile });
  });
  // The hotel's pricing currency (none saved yet) and whether a Fixed Fee checkout is open.
  await page.route(
    new RegExp(`/api/pms/properties/${propertyId}/pricing-source/currency-capabilities$`),
    (route) =>
      json(route, {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: [{ code: "EUR", scale: 2 }],
      }),
  );
  await page.route(new RegExp(`/api/pms/setup/properties/${propertyId}/room-types$`), (route) =>
    json(route, { contractVersion: "pms-room-facts.v1", propertyId, items: [] }),
  );
  await page.route(new RegExp(`/api/pms/properties/${propertyId}/pricing-source$`), (route) =>
    json(route, { code: "pricing_currency_not_configured" }, 404),
  );
  await page.route(new RegExp(`/api/finance/properties/${propertyId}/plan-status`), (route) =>
    json(route, {
      planStatus: {
        plan: null,
        status: "not_selected",
        currency: "EUR",
        activeRoomCount: 0,
        amountMinor: 0,
        fixedPlanAvailable: false,
        checkoutPending: false,
        updatedAt: "2026-10-27T00:00:00.000Z",
      },
    }),
  );
  return state;
}
