import { expect, test, type Page } from "@playwright/test";

import {
  FOUR_STEP_HOTEL,
  FOUR_STEP_PROPERTY_ID as propertyId,
  OLDER_HOTEL,
  fourStepSetupUrl,
  mockFourStepOwner,
  primeSetupBrowserState,
} from "../support/fourStepSetupMocks";
import { mockGoogleMaps, type FakeGeocode } from "../support/googleMapsFake";
import { mockRoomOwnerApis } from "../support/roomOwnerMocks";

// VAY-2444, VAY-2451: the four-step setup's "Location & contact" takes a Google Maps link, as the room editor
// does: the pin, the address Google gives it, the time zone and currency, and "Guests will see". The setup sits
// behind ONBOARDING_V2_ENABLED (PR Checks' first shard runs a server with it on).
test.skip(
  process.env.E2E_ONBOARDING_V2 !== "1",
  "needs a Booking Admin server with ONBOARDING_V2_ENABLED=true (run with E2E_ONBOARDING_V2=1)",
);

const heading = (page: Page, name: string) => page.getByRole("heading", { name, level: 1 });
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

/** A hotel with its address, contacts and pin; its first room isn't saved yet. */
const HOTEL_PROFILE = {
  ...OLDER_HOTEL,
  location: {
    ...OLDER_HOTEL.location,
    streetAddress: FOUR_STEP_HOTEL.streetAddress,
    postalCode: FOUR_STEP_HOTEL.postalCode,
    timezone: "Europe/Berlin",
    latitude: 48.137,
    longitude: 11.575,
  },
};

/** The hotel's "Location & contact", opened on the address search (the hotel already has an address). */
async function openLocation(page: Page, baseURL: string | undefined, geocode: FakeGeocode) {
  await primeSetupBrowserState(page);
  const writes = await mockFourStepOwner(page, { profile: HOTEL_PROFILE });
  await mockRoomOwnerApis(page);
  await mockGoogleMaps(page, { geocode, placeAutocompleteElement: true });
  await page.goto(fourStepSetupUrl(baseURL, `&propertyId=${propertyId}&step=location`));
  await expect(heading(page, "Location & contact")).toBeVisible();
  // The saved address shows first; Change opens the search.
  await page.getByRole("button", { name: "Change", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Paste a Google Maps link" })).toBeVisible();
  return writes;
}

test("a pasted Google Maps link sets the pin, the address, the time zone and the currency", async ({
  page,
  baseURL,
}) => {
  const writes = await openLocation(page, baseURL, HIRIKETIYA);
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  await page.getByLabel("Google Maps link").fill(HIRIKETIYA_LINK);

  // The address Google gives the pin, the map with the pin, and "Guests will see".
  await expect(page.getByText("4th Lane, 81200 Dikwella, Sri Lanka").first()).toBeVisible();
  await expect(page.getByText("Pin placed", { exact: false })).toBeVisible();
  await expect(page.getByText("Guests will see", { exact: false })).toBeVisible();
  const map = page.getByTestId("google-address-map-canvas");
  await expect(map).toHaveAttribute("data-marker", "5.9762,80.7063");
  await expect(map).toHaveAttribute("data-marker-draggable", "true");
  await expect(page.getByText("Asia/Colombo")).toBeVisible();
  // The currency follows the country (this hotel never chose another).
  await expect(page.getByText(/^LKR/)).toBeVisible();
  await expect(page.getByText("Detected from your address")).toBeVisible();
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

  // Continue saves the hotel and its currency, then goes on to the first room.
  await proceed(page).click();
  await expect(heading(page, "Your first room type")).toBeVisible();
  expect(writes.profilePatch).toMatchObject({
    patch: { location: { countryCode: "LK", latitude: 5.9765, longitude: 80.7068 } },
  });
  expect(writes.currency).toMatchObject({ currency: "LKR" });
});

test("a link's pin is saved with the address, for the room editor's Same as property", async ({
  page,
  baseURL,
}) => {
  const writes = await openLocation(page, baseURL, MUNICH);
  // Save & exit leaves for the dashboard.
  await page.route(
    (url) => url.pathname === "/dashboard",
    (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Dashboard</title>" }),
  );
  await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
  await page
    .getByLabel("Google Maps link")
    .fill("https://www.google.com/maps/@48.15634,11.58242,17z");
  await expect(page.getByText("Leopoldstraße 12, 80802 München, Germany").first()).toBeVisible();
  await page.getByRole("button", { name: "Save & exit" }).first().click();
  await page.waitForURL(
    (url) => url.pathname === "/dashboard" && url.searchParams.get("propertyId") === propertyId,
  );
  expect(writes.profilePatch).toMatchObject({
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
  await openLocation(page, baseURL, "denied");
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
  await expect(heading(page, "Your first room type")).toBeVisible();
});

test("a short share link is read through the API; a link without a place says so", async ({
  page,
  baseURL,
}) => {
  await openLocation(page, baseURL, HIRIKETIYA);
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
