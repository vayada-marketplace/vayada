import { expect, test, type Page, type Route } from "@playwright/test";
import { completeFirstRun, type FirstRunHotel } from "../next-stack-smoke/first-run";
import { submitAccountDetails } from "../next-stack-smoke/support";
import {
  BOOKING_PUBLICATION_PATH,
  bookingPublicationReviewMock,
  fulfillPublication,
  publicationOperationMock,
} from "../support/bookingPublicationMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { primeQuickSetupBrowserState } from "../support/quickSetupMocks";

// VAY-2357: the live next-stack smoke drives Booking Admin's first run with these same helpers. Here
// they run against a mocked API, so a renamed label or button fails the PR instead of the next live
// run. The quick setup sits behind ONBOARDING_V2_ENABLED, set on PR Checks' first-run server.
test.skip(
  process.env.E2E_ONBOARDING_V2 !== "1",
  "needs a Booking Admin server with ONBOARDING_V2_ENABLED=true (run with E2E_ONBOARDING_V2=1)",
);

const PROPERTY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_URL = "https://hotel-alpenrose.booking.vayada.com";
const HOTEL: FirstRunHotel = {
  name: "Hotel Alpenrose",
  streetAddress: "Marienplatz 1",
  postalCode: "80331",
  city: "Munich",
  countryCode: "DE",
  receptionEmail: "reception@alpenrose.example",
  receptionPhone: "+49 89 123456",
  room: { name: "Classic Double", numberOfRooms: 2, maxGuests: 2, pricePerNight: "150" },
};

async function json(route: Route, body: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
  await route.fulfill({ status, headers: corsHeaders(route), json: body });
}

/** A new owner with no name or phone yet and no hotel; every write the first run makes is kept. */
async function mockNewHotelFirstRun(page: Page) {
  const writes: Record<string, unknown> = {};
  let user: Record<string, unknown> = {
    id: "user-hotel-owner",
    email: "owner@alpenrose.example",
    name: null,
    phone: null,
    status: "active",
    workosUserId: "user_workos_hotel_owner",
  };
  let profile: Record<string, unknown> | null = null;
  let published = false;
  const session = () => ({
    accessToken: "test-access-token",
    csrfToken: "test-csrf-token",
    organizationId: ORGANIZATION_ID,
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
        organizationId: ORGANIZATION_ID,
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: profile ? PROPERTY_ID : null,
        propertyDisplayName: HOTEL.name,
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
    return json(route, { propertyId: PROPERTY_ID, profileRevision: 1, profile }, 201);
  });
  await page.route(new RegExp(`/api/hotel-setup/properties/${PROPERTY_ID}/profile$`), (route) =>
    json(route, { propertyId: PROPERTY_ID, profileRevision: 1, profile }),
  );
  const steps = (state: string) =>
    ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"].map((id) => ({
      id,
      state,
    }));
  await page.route(new RegExp(`/api/hotel-setup/properties/${PROPERTY_ID}/first-run$`), (route) => {
    if (route.request().method() !== "POST")
      return json(route, {
        contractVersion: "hotel-first-run.v1",
        propertyId: PROPERTY_ID,
        steps: steps("todo"),
        nextStep: "currency",
      });
    writes.firstRun = route.request().postDataJSON();
    return json(route, {
      state: {
        contractVersion: "hotel-first-run.v1",
        propertyId: PROPERTY_ID,
        steps: steps("done"),
        nextStep: null,
      },
      ran: ["currency", "rooms", "payments", "pricing", "calendar", "guest_rules", "plan"],
      checkout: null,
    });
  });
  await page.route(
    new RegExp(`/api/pms/properties/${PROPERTY_ID}/pricing-source/currency-capabilities$`),
    (route) =>
      json(route, {
        contractVersion: "pms-pricing-currency-capabilities.v1",
        supportedCurrencies: [{ code: "EUR", scale: 2 }],
      }),
  );
  await page.route(new RegExp(`/api/pms/setup/properties/${PROPERTY_ID}/room-types$`), (route) =>
    json(route, { contractVersion: "pms-room-facts.v1", propertyId: PROPERTY_ID, items: [] }),
  );
  await page.route(new RegExp(`/api/pms/properties/${PROPERTY_ID}/pricing-source$`), (route) =>
    json(route, { code: "pricing_currency_not_configured" }, 404),
  );
  await page.route(new RegExp(`/api/finance/properties/${PROPERTY_ID}/plan-status`), (route) =>
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
  // Ready to publish, then live with its address once the publish was sent.
  await page.route(BOOKING_PUBLICATION_PATH, async (route) => {
    if (route.request().method() === "POST") {
      published = true;
      return fulfillPublication(route, { json: publicationOperationMock(PROPERTY_ID) });
    }
    const review = await bookingPublicationReviewMock(PROPERTY_ID, published ? "online" : "ready");
    return fulfillPublication(route, {
      json: { ...review, publishedUrl: published ? BOOKING_URL : null },
    });
  });
  return writes;
}

test("the smoke's first-run helpers take a new owner from About you to a live booking page", async ({
  page,
  baseURL,
}) => {
  await primeQuickSetupBrowserState(page, PROPERTY_ID);
  const writes = await mockNewHotelFirstRun(page);
  const setup = new URL(
    "/setup?entryProduct=booking&returnProduct=booking&returnTo=/dashboard",
    baseURL,
  );
  // The browser state is primed for localhost, as the other setup specs do.
  if (setup.hostname === "127.0.0.1") setup.hostname = "localhost";
  await page.goto(setup.toString());

  await expect(
    submitAccountDetails(page, { firstName: "Harper", lastName: "Smoke" }, "+49 30 5550102"),
  ).resolves.toBe("first_run");
  const created: string[] = [];
  const result = await completeFirstRun(page, HOTEL, (propertyId) => created.push(propertyId));

  expect(result).toEqual({ propertyId: PROPERTY_ID, bookingUrl: BOOKING_URL });
  // The smoke leaves the live screen through this button.
  await expect(page.getByRole("button", { name: "Go to my dashboard" })).toBeVisible();
  expect(created).toEqual([PROPERTY_ID]);
  expect(writes.account).toMatchObject({
    firstName: "Harper",
    lastName: "Smoke",
    phone: "+49 30 5550102",
  });
  expect(writes.hotel).toMatchObject({
    displayName: HOTEL.name,
    propertyType: "hotel",
    location: {
      streetAddress: HOTEL.streetAddress,
      postalCode: HOTEL.postalCode,
      city: HOTEL.city,
      countryCode: "DE",
      timezone: "Europe/Berlin",
    },
  });
  expect(writes.firstRun).toEqual({
    rooms: [{ name: "Classic Double", numberOfRooms: 2, maxGuests: 2, pricePerNight: "150" }],
    pricesIncludeMandatoryCharges: true,
    guestPayment: "pay_at_property",
    plan: "commission",
    cancellation: { kind: "free_until_days_before_arrival", days: 3 },
    bed: "double",
  });
});
