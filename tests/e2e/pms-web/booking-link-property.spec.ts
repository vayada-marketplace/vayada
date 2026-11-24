import { expect, test, type Page } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";

// VAY-2099: the booking request email links `/bookings/<id>?property=<hotel>`. A login with several
// hotels opens the booking under that hotel, not the one it chose last (where the booking isn't
// found), and not the hotel picker when it hasn't chosen one yet. The link's hotel then leaves the
// address, so switching hotels and reloading doesn't switch back.
const DEWARI = "f6853000-0000-4000-8000-000000002451";
const STRANGER = "f6853000-0000-4000-8000-000000009999";
const BOOKING_LINK = `/bookings/${PMS_WEB_RESERVATION_ID}?property=${PMS_WEB_PROPERTY_ID}`;

/** Two hotels; the status answers for the hotel asked about, or asks to choose one. */
async function mockTwoHotels(page: Page) {
  await page.route("**/api/hotel-setup/status**", (route) => {
    const asked = new URL(route.request().url()).searchParams.get("propertyId");
    const dewari = asked === DEWARI;
    const status = createAdaptiveHotelSetupStatusMock({
      entryProduct: "pms",
      organizationId: "org_pms_owner",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["hotel_operations"],
      propertyId: asked === PMS_WEB_PROPERTY_ID || dewari ? asked : null,
      publicId: dewari ? "prop_dewari" : "prop_alpenrose",
      propertyDisplayName: dewari ? "Dewari Villa" : "Alpenrose Munich",
      locationSummary: dewari ? "Ubud, ID" : "Munich, DE",
    });
    return route.fulfill({
      json: {
        ...status,
        propertySelection: {
          state: "multiple_properties",
          selectedPropertyId: status.propertySelection.selectedPropertyId,
          availableProperties: [
            {
              propertyId: PMS_WEB_PROPERTY_ID,
              publicId: "prop_alpenrose",
              displayName: "Alpenrose Munich",
              locationSummary: "Munich, DE",
            },
            {
              propertyId: DEWARI,
              publicId: "prop_dewari",
              displayName: "Dewari Villa",
              locationSummary: "Ubud, ID",
            },
          ],
        },
      },
    });
  });
  // Alpenrose has the booking; Dewari doesn't.
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`${base}/change-request`, (route) => route.fulfill({ json: null }));
  await page.route(base, (route) => route.fulfill({ json: { item: pmsWebReservation } }));
  await page.route(`**/api/pms/properties/${DEWARI}/**`, (route) =>
    route.fulfill({ status: 404, json: { error: "not_found" } }),
  );
}

const chosenHotel = (page: Page) =>
  page.evaluate(() => [
    window.localStorage.getItem("selectedHotelId"),
    window.localStorage.getItem("selectedSharedPropertyId"),
  ]);

/** Signed in with Dewari chosen. The chosen hotel is kept only with its hotel group, as the PMS
 * stores it (a hotel without its group is dropped when the session loads). */
async function signedInWithDewari(page: Page) {
  await mockPmsWebAuthenticatedSession(page, DEWARI);
  await page.addInitScript((dewari) => {
    window.localStorage.setItem("selectedSharedPropertyId", dewari);
    window.localStorage.setItem("selectedSharedPropertyOrganizationId", "org_pms_owner");
  }, DEWARI);
  await mockPmsWebTargetRoutes(page);
  await mockTwoHotels(page);
}

const reservationRequest = (propertyId: string) =>
  new RegExp(`/api/pms/properties/${propertyId}/reservations/${PMS_WEB_RESERVATION_ID}(\\?|$)`);

test("a booking link opens the booking under the hotel it names", async ({ page }) => {
  await signedInWithDewari(page);
  const dewariAsked: string[] = [];
  page.on("request", (request) => {
    if (reservationRequest(DEWARI).test(request.url())) dewariAsked.push(request.url());
  });

  await page.goto(BOOKING_LINK);
  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  expect(await chosenHotel(page)).toEqual([PMS_WEB_PROPERTY_ID, PMS_WEB_PROPERTY_ID]);
  await expect(page).toHaveURL(new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}$`));
  expect(dewariAsked).toEqual([]);
});

test("a link naming a hotel the login doesn't have keeps the hotel chosen", async ({ page }) => {
  await signedInWithDewari(page);
  // The booking page then asks Dewari, the hotel still chosen, for the booking.
  const dewariAsked = page.waitForRequest(reservationRequest(DEWARI));

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}?property=${STRANGER}`);
  await dewariAsked;
  await expect(page).toHaveURL(new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}$`));
  expect(await chosenHotel(page)).toEqual([DEWARI, DEWARI]);
});

// The live sign-in answer carries no hotel list, so a login with several hotels and none chosen goes
// to the hotel picker after signing in. A link that names its hotel goes to the booking instead.
test("signing in from a booking link opens the booking, not the hotel picker", async ({ page }) => {
  await mockPmsWebTargetRoutes(page);
  await mockTwoHotels(page);
  let signedIn = false;
  await page.route("**/auth/session?surface=pms-web", (route) =>
    signedIn
      ? route.fallback()
      : route.fulfill({ status: 401, json: { error: "missing_session" } }),
  );
  await page.route("**/auth/password/login", (route) => {
    signedIn = true;
    return route.fulfill({
      json: {
        accessToken: "e2e-pms-token",
        csrfToken: "e2e-pms-csrf-token",
        organizationId: "org_pms_owner",
        workosOrganizationId: "org_workos_pms_owner",
        user: {
          id: "user_pms_owner",
          email: "owner@example.com",
          name: "PMS Owner",
          status: "active",
          workosUserId: "workos_user_pms_owner",
        },
      },
    });
  });

  await page.goto(BOOKING_LINK);
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(await chosenHotel(page)).toEqual([null, null]);
  await waitForLoginFormHydration(page);
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}$`));
  expect(await chosenHotel(page)).toEqual([PMS_WEB_PROPERTY_ID, PMS_WEB_PROPERTY_ID]);
});

async function waitForLoginFormHydration(page: Page) {
  const password = page.getByLabel("Password", { exact: true });
  await expect(async () => {
    await page
      .getByRole("button", { name: "Show password", exact: true })
      .click({ timeout: 1_000 });
    await expect(password).toHaveAttribute("type", "text", { timeout: 1_000 });
  }).toPass();
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "password");
}
