import type { Page, Route } from "@playwright/test";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";

import type { FirstRunHotel } from "../next-stack-smoke/first-run";
import { corsHeaders, fulfillCorsPreflight } from "./cors";
import { ROOM_OWNER_PROPERTY_ID } from "./roomOwnerMocks";
import { createAdaptiveHotelSetupStatusMock } from "./sharedHotelSetupMocks";

/**
 * VAY-2451: Booking Admin's four-step setup for a hotel owner, against mocked APIs. The server must run with
 * ONBOARDING_V2_ENABLED=true. The property is the one the room mocks (`mockRoomOwnerApis`) answer for.
 */
export const FOUR_STEP_PROPERTY_ID = ROOM_OWNER_PROPERTY_ID;
const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = FOUR_STEP_PROPERTY_ID;
const now = "2026-08-03T12:00:00.000Z";

/** The hotel the four-step specs set up (the live smoke's helpers take the same shape). */
export const FOUR_STEP_HOTEL: FirstRunHotel = {
  name: "Hotel Alpenrose",
  streetAddress: "Marienplatz 1",
  postalCode: "80331",
  city: "Munich",
  countryCode: "DE",
  receptionEmail: "reception@alpenrose.example",
  receptionPhone: "+49 89 123456",
  room: { name: "Classic Double", numberOfRooms: 2, maxGuests: 2, pricePerNight: "150" },
};

/** Setup on Booking Admin at localhost, where the browser state is primed; `query` is added to the link. */
export function fourStepSetupUrl(baseURL: string | undefined, query = ""): string {
  const setup = new URL(`/setup?entryProduct=booking&returnProduct=booking${query}`, baseURL);
  if (setup.hostname === "127.0.0.1") setup.hostname = "localhost";
  return setup.toString();
}

export async function primeSetupBrowserState(page: Page, propertyId = FOUR_STEP_PROPERTY_ID) {
  await page.addInitScript((selectedPropertyId) => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
    localStorage.setItem("userType", "hotel");
    localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
  }, propertyId);
}

export async function json(route: Route, body: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
  await route.fulfill({ status, headers: corsHeaders(route), json: body });
}

const steps = (state: (id: string) => string) =>
  ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map((id) => ({
    id,
    state: state(id),
  }));

/**
 * An owner in Booking Admin's four-step setup, with or without a hotel yet (`profile` set: the hotel exists with
 * that profile), and every read and write setup makes outside the room APIs (`mockRoomOwnerApis`). Each write
 * is kept: the account, the created hotel, the profile patch, the currency and the first run.
 */
export async function mockFourStepOwner(
  page: Page,
  options: {
    profile?: Record<string, unknown> | null;
    finished?: boolean;
    newOwner?: boolean;
  } = {},
) {
  const writes: Record<string, unknown> = {};
  let profile: Record<string, unknown> | null = options.profile ?? null;
  let user: Record<string, unknown> = {
    id: "user-hotel-owner",
    email: "owner@alpenrose.example",
    name: options.newOwner ? null : "Harper Smoke",
    phone: options.newOwner ? null : "+49 30 5550102",
    status: "active",
    workosUserId: "user_workos_hotel_owner",
  };
  const session = () => ({
    accessToken: "test-access-token",
    csrfToken: "test-csrf-token",
    organizationId,
    workosOrganizationId: "org_workos_hotel_group",
    organizationKind: "hotel_group",
    user,
  });
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) => json(route, session()));
  await page.route(/\/auth\/profile$/, (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const body = route.request().postDataJSON() as Record<string, string>;
    writes.account = body;
    user = { ...user, name: `${body.firstName} ${body.lastName}`, phone: body.phone };
    return json(route, { updated: true });
  });
  await page.route(/\/api\/hotel-setup\/imports\/prepared/, (route) =>
    json(route, { import: null }),
  );
  await page.route(/\/api\/hotel-setup\/status/, (route) =>
    json(
      route,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId,
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: profile ? propertyId : null,
        propertyDisplayName: FOUR_STEP_HOTEL.name,
      }),
    ),
  );
  await page.route(/\/api\/hotel-setup\/property-types/, (route) =>
    json(route, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [
        { value: "hotel", label: "Hotel" },
        { value: "guesthouse", label: "Guesthouse" },
      ],
    }),
  );
  await page.route(/\/api\/hotel-setup\/properties$/, (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const { initialLaunchSettings: _settings, ...created } = route.request().postDataJSON();
    writes.hotel = created;
    profile = created;
    return json(route, { propertyId, profileRevision: 1, profile }, 201);
  });
  await page.route(new RegExp(`/api/hotel-setup/properties/${propertyId}/profile$`), (route) => {
    if (route.request().method() === "PUT" || route.request().method() === "PATCH") {
      writes.profilePatch = route.request().postDataJSON();
    }
    return json(route, { propertyId, profileRevision: 1, profile });
  });
  await page.route(new RegExp(`/api/hotel-setup/properties/${propertyId}/first-run$`), (route) => {
    if (route.request().method() !== "POST")
      return json(route, {
        contractVersion: "hotel-first-run.v1",
        propertyId,
        steps: steps((id) => (options.finished || id === "currency" ? "done" : "todo")),
        nextStep: options.finished ? null : "rooms",
      });
    writes.firstRun = route.request().postDataJSON();
    return json(route, {
      state: {
        contractVersion: "hotel-first-run.v1",
        propertyId,
        steps: steps(() => "done"),
        nextStep: null,
      },
      ran: ["rooms", "payments", "pricing", "calendar", "guest_rules", "plan"],
      checkout: null,
    });
  });
  await page.route(
    new RegExp(`/api/pms/properties/${propertyId}/pricing-source/currency-capabilities$`),
    (route) =>
      json(route, {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: [
          { code: "EUR", scale: 2 },
          { code: "LKR", scale: 2 },
        ],
      }),
  );
  // The pricing currency: none until step 2 saves one (the four-step setup always does), then that one.
  let currencyRevision = 0;
  let currency = "EUR";
  const pricingCurrency = () => ({
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    currency,
    pricingCurrencyRevision: currencyRevision,
    createdAt: now,
    updatedAt: now,
  });
  await page.route(new RegExp(`/api/pms/properties/${propertyId}/pricing-source$`), (route) =>
    currencyRevision === 0
      ? json(route, { code: "pricing_currency_not_configured" }, 404)
      : json(route, {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          propertyId,
          pricingCurrency: pricingCurrency(),
          flexibleRatePlans: [],
          capturedAt: now,
        }),
  );
  await page.route(
    new RegExp(`/api/pms/properties/${propertyId}/pricing-source/currency$`),
    (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      writes.currency = route.request().postDataJSON();
      currency = (writes.currency as { currency: string }).currency;
      currencyRevision = 1;
      return json(
        route,
        {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          outcome: "created",
          pricingCurrency: pricingCurrency(),
          acceptedAt: now,
        },
        201,
      );
    },
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
  return writes;
}

/** A hotel an older setup created without its street address, time zone or pin. */
export const OLDER_HOTEL = {
  displayName: FOUR_STEP_HOTEL.name,
  propertyType: "hotel",
  location: {
    streetAddress: "",
    postalCode: "",
    city: "Munich",
    countryCode: "DE",
    timezone: "",
    latitude: null,
    longitude: null,
    localityPublic: true,
    geoPublic: true,
    mapDisplayMode: "exact",
  },
  contacts: [
    {
      channelType: "email",
      value: FOUR_STEP_HOTEL.receptionEmail,
      purpose: "general",
      isPublic: true,
    },
    {
      channelType: "phone",
      value: FOUR_STEP_HOTEL.receptionPhone,
      purpose: "general",
      isPublic: true,
    },
  ],
};
