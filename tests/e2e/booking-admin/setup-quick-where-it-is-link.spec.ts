import { expect, test, type Page } from "@playwright/test";
import { mockGoogleMaps, type FakeGeocode } from "../support/googleMapsFake";
import { mockBookingDashboardExit } from "../support/setupExitHandoff";
import {
  QUICK_SETUP_PROPERTY_ID,
  mockQuickSetupExistingHotel,
  primeQuickSetupBrowserState,
  quickSetupUrl,
} from "../support/quickSetupMocks";

// VAY-2444: onboarding's "Where it is" takes a Google Maps link, as the room editor does: the pin, the address
// Google gives it, the time zone and currency, the room editor's map and "Guests will see". The quick setup sits
// behind ONBOARDING_V2_ENABLED (PR Checks' first shard runs a server with it on).
test.skip(
  process.env.E2E_ONBOARDING_V2 !== "1",
  "needs a Booking Admin server with ONBOARDING_V2_ENABLED=true (run with E2E_ONBOARDING_V2=1)",
);

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
const back = (page: Page) => page.getByRole("button", { name: "Back" }).first();
const proceed = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });
const part = (long_name: string, types: string[], short_name = long_name) => ({
  long_name,
  short_name,
  types,
});
// Lumansa Hiriketiya's lane, made up from the ticket's address (Google's autocomplete doesn't find it).
const HIRIKETIYA: FakeGeocode = {
  results: [
    {
      types: ["route"],
      address_components: [
        part("4th Lane", ["route"]),
        part("Hiriketiya", ["sublocality_level_1", "sublocality", "political"]),
        part("Dikwella", ["locality", "political"]),
        part("81200", ["postal_code"]),
        part("Sri Lanka", ["country", "political"], "LK"),
      ],
    },
  ],
};
const HIRIKETIYA_LINK =
  "https://www.google.com/maps/place/Lumansa+Hiriketiya/@5.9761,80.7062,18z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d5.9762!4d80.7063";
const MUNICH: FakeGeocode = {
  results: [
    {
      types: ["street_address"],
      address_components: [
        part("12", ["street_number"]),
        part("Leopoldstraße", ["route"]),
        part("München", ["locality", "political"]),
        part("80802", ["postal_code"]),
        part("Germany", ["country", "political"], "DE"),
      ],
    },
  ],
};

/** The existing hotel's "Where it is" edit, opened on the address search (the hotel already has an address). */
async function openWhereItIs(page: Page, baseURL: string | undefined, geocode: FakeGeocode) {
  await primeQuickSetupBrowserState(page);
  const state = await mockQuickSetupExistingHotel(page);
  await mockGoogleMaps(page, { geocode, placeAutocompleteElement: true });
  await page.goto(quickSetupUrl(baseURL));
  await expect(heading(page, "Your first room and price")).toBeVisible();
  await back(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
  await back(page).click();
  await expect(heading(page, "Where it is")).toBeVisible();
  // The saved address shows first; Change opens the search.
  await page.getByRole("button", { name: "Change", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Paste a Google Maps link" })).toBeVisible();
  return state;
}

test("a pasted Google Maps link sets the pin, the address, the time zone and the currency", async ({
  page,
  baseURL,
}) => {
  await openWhereItIs(page, baseURL, HIRIKETIYA);
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  await page.getByLabel("Google Maps link").fill(HIRIKETIYA_LINK);

  // The address Google gives the pin, the room editor's map with the pin, and "Guests will see".
  await expect(page.getByText("4th Lane, 81200 Dikwella, Sri Lanka").first()).toBeVisible();
  await expect(page.getByText("Pin placed on the map")).toBeVisible();
  const map = page.getByTestId("google-address-map-canvas");
  await expect(map).toHaveAttribute("data-marker", "5.9762,80.7063");
  await expect(map).toHaveAttribute("data-marker-draggable", "true");
  await expect(page.getByRole("group", { name: "Map type" })).toBeVisible();
  await expect(page.getByText("Guests will see")).toBeVisible();
  await expect(page.getByText("Asia/Colombo")).toBeVisible();
  // The currency is set (from the country, unless the hotel chose one before).
  await expect(page.getByText("Set from your country")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { vayadaE2eGeocodeQueries: string[] }).vayadaE2eGeocodeQueries,
    ),
  ).toEqual(["5.9762,80.7063"]);

  // Dragging the pin moves it.
  await map.evaluate((element) =>
    (
      element as unknown as { vayadaE2eDragMarker: (lat: number, lng: number) => void }
    ).vayadaE2eDragMarker(5.9765, 80.7068),
  );
  await expect(map).toHaveAttribute("data-marker", "5.9765,80.7068");

  // The live preview names the address, and Continue goes on (step 3 is done).
  await expect(page.getByText("4th Lane, Dikwella").first()).toBeVisible();
  await proceed(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
});

test("a link's pin is saved with the address, for the room editor's Same as property", async ({
  page,
  baseURL,
}) => {
  const state = await openWhereItIs(page, baseURL, MUNICH);
  const exitUrl = await mockBookingDashboardExit(page, baseURL, QUICK_SETUP_PROPERTY_ID);
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  await page
    .getByLabel("Google Maps link")
    .fill("https://www.google.com/maps/@48.15634,11.58242,17z");
  await expect(page.getByText("Leopoldstraße 12, 80802 München, Germany").first()).toBeVisible();
  await page.getByRole("button", { name: "Save & exit" }).click();
  await expect.poll(() => page.url()).toBe(exitUrl);
  expect(state.profileWrites).toHaveLength(1);
  expect(state.profileWrites[0]).toMatchObject({
    patch: {
      location: {
        streetAddress: "Leopoldstraße 12",
        postalCode: "80802",
        city: "München",
        countryCode: "DE",
        latitude: 48.15634,
        longitude: 11.58242,
        timezone: "Europe/Berlin",
      },
    },
  });
});

test("without reverse geocoding the pin stays and the host types the rest, from the country it's in", async ({
  page,
  baseURL,
}) => {
  await openWhereItIs(page, baseURL, "denied");
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  await page.getByLabel("Google Maps link").fill(HIRIKETIYA_LINK);
  // The manual fields, with the country guessed from the pin's time zone, next to the pin.
  const street = page.getByRole("textbox", { name: /Street and number/ });
  await expect(street).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Country", exact: true })).toHaveValue("LK");
  const map = page.getByTestId("google-address-map-canvas");
  await expect(map).toHaveAttribute("data-marker", "5.9762,80.7063");
  await street.fill("4th Lane, Henawatta Hiriketiya Road");
  await page.getByRole("textbox", { name: /Postal code/ }).fill("81200");
  await page.getByRole("textbox", { name: /City/ }).fill("Dikwella");
  // Typing keeps the link's pin.
  await expect(map).toHaveAttribute("data-marker", "5.9762,80.7063");
  await proceed(page).click();
  await expect(heading(page, "How guests reach you")).toBeVisible();
});

test("a short share link is read through the API; a link without a place says so", async ({
  page,
  baseURL,
}) => {
  await openWhereItIs(page, baseURL, HIRIKETIYA);
  const asked: string[] = [];
  await page.route("**/api/maps-links/resolve", (route) => {
    const { url } = route.request().postDataJSON() as { url: string };
    asked.push(url);
    return route.fulfill({ json: { url: HIRIKETIYA_LINK } });
  });
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  const link = page.getByLabel("Google Maps link");
  await link.fill("https://example.com/our-hotel");
  await expect(page.getByText("This link has no coordinates.")).toBeVisible();
  await link.fill("https://maps.app.goo.gl/Lumansa123");
  await expect(page.getByText("4th Lane, 81200 Dikwella, Sri Lanka").first()).toBeVisible();
  expect(asked).toEqual(["https://maps.app.goo.gl/Lumansa123"]);
});
