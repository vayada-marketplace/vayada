import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_PROFILE_PATH,
  defaultBookingAdminPropertyProfile,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

// VAY-2126: Settings → Location & surroundings → "Location map on your booking page".
const nearby = `/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/nearby`;
const locationMap = `/api/booking/properties/${BOOKING_ADMIN_PROPERTY_ID}/location-map`;
const pin = (latitude: number, longitude: number) => ({ latitude, longitude });
const room = (
  n: number,
  name: string,
  address: string | null,
  at: ReturnType<typeof pin> | null,
) => ({
  roomTypeId: `00000000-0000-4000-8000-00000000000${n}`,
  name,
  address,
  pin: at,
});
const property = {
  name: "Alpenrose Apartments",
  address: "Maximilianstraße 3, 80539 Munich",
  pin: pin(48.1394, 11.5835),
  mapDisplayMode: "exact" as const,
};
const villas = [
  room(1, "Schwabing Loft", "Leopoldstraße 12, Munich", pin(48.15634, 11.58242)),
  room(2, "Haidhausen Garden Flat", "Wörthstraße 8, Munich", pin(48.1291, 11.5952)),
  room(3, "Isar Studio", "Erhardtstraße 21, Munich", pin(48.1302, 11.5788)),
  room(4, "Family Apartment", null, null),
];

async function setup(
  page: Page,
  summary: { enabled: boolean; canSwitch: boolean; rooms: unknown[] },
  saveStatus = 200,
) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  // The location form's map is Google's; this page's check doesn't need it.
  await page.route("https://maps.googleapis.com/**", (route) => route.abort());
  const profile = structuredClone(defaultBookingAdminPropertyProfile);
  await page.route(`**${BOOKING_ADMIN_PROPERTY_PROFILE_PATH}`, (route) =>
    route.fulfill({ json: profile }),
  );
  await page.route(`**${nearby}/curation`, (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        profileRevision: profile.profileRevision,
        curationRevision: 0,
        savedProfileRevision: null,
        choices: [],
        customPlaces: [],
      },
    }),
  );
  await page.route(`**${nearby}/refresh`, (route) =>
    route.fulfill({ status: 503, json: { code: "not_configured" } }),
  );
  const state = { ...summary, property, saves: [] as unknown[] };
  // The API is another origin: the browser asks first (OPTIONS) and needs CORS headers.
  await page.route(`**${locationMap}`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return fulfillCorsPreflight(route);
    const headers = corsHeaders(route);
    if (method === "PUT") {
      const body = route.request().postDataJSON() as { enabled: boolean };
      state.saves.push(body);
      if (saveStatus !== 200)
        return route.fulfill({
          status: saveStatus,
          headers,
          json: { code: "location_map_unavailable" },
        });
      state.enabled = body.enabled;
      return route.fulfill({ headers, json: { enabled: body.enabled } });
    }
    const { enabled, canSwitch, rooms } = state;
    return route.fulfill({ headers, json: { enabled, canSwitch, rooms, property } });
  });
  return state;
}

test("turns the location map on and shows a pin for each room's place", async ({ page }) => {
  const state = await setup(page, { enabled: false, canSwitch: true, rooms: villas });
  await page.goto("/settings/location");
  const card = page.getByRole("region", { name: "Location map on your booking page" });
  const toggle = card.getByRole("switch", { name: "Location map on your booking page" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(card.getByText("Off: guests see no map.", { exact: false })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(state.saves).toEqual([{ enabled: true }]);
  await expect(
    card.getByText("What guests see: 3 pins, one for each place with a room"),
  ).toBeVisible();
  const pins = card.getByRole("listitem");
  await expect(pins).toHaveCount(3);
  await expect(pins.nth(0)).toContainText("Schwabing Loft");
  await expect(pins.nth(0)).toContainText("Leopoldstraße 12, Munich");
  await expect(card.getByText("Family Apartment has no location, so it has no pin.")).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(state.saves).toEqual([{ enabled: true }, { enabled: false }]);

  // The room without a location opens in PMS (through PMS sign-in when there is no handoff).
  await toggle.click();
  await page.route(/^http:\/\/pms\.localhost:3004\//, (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>PMS</p>" }),
  );
  await card.getByRole("button", { name: "Add it in Rooms & Rates" }).click();
  await expect
    .poll(() => decodeURIComponent(page.url()))
    .toContain("/rooms/00000000-0000-4000-8000-000000000004");
});

test("shows one pin at the property when no room has its own location", async ({ page }) => {
  await setup(page, {
    enabled: true,
    canSwitch: true,
    rooms: [room(1, "Deluxe Double", null, null), room(2, "Garden Suite", null, null)],
  });
  await page.goto("/settings/location");
  const card = page.getByRole("region", { name: "Location map on your booking page" });
  await expect(card.getByText("What guests see: one pin at your property")).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveText(
    /Alpenrose Apartments\s*Maximilianstraße 3, 80539 Munich/,
  );
  await expect(card.getByText(/no location, so/)).toHaveCount(0);
});

test("keeps the switch as it was when the save fails", async ({ page }) => {
  await setup(page, { enabled: false, canSwitch: true, rooms: villas }, 503);
  await page.goto("/settings/location");
  const card = page.getByRole("region", { name: "Location map on your booking page" });
  const toggle = card.getByRole("switch", { name: "Location map on your booking page" });
  await toggle.click();
  await expect(card.getByRole("alert")).toHaveText("The change couldn't be saved. Try again.");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("waits for the booking engine setup before the map can be switched on", async ({ page }) => {
  await setup(page, { enabled: false, canSwitch: false, rooms: villas });
  await page.goto("/settings/location");
  const card = page.getByRole("region", { name: "Location map on your booking page" });
  await expect(
    card.getByRole("switch", { name: "Location map on your booking page" }),
  ).toBeDisabled();
  await expect(
    card.getByText("Finish setting up your booking engine to turn the map on."),
  ).toBeVisible();
});
