import { expect, test, type Page } from "@playwright/test";
import { mockBookingApis, mockStayPrices } from "../support/bookingMocks";

// VAY-2126: the booking page's location map, switched on in Booking Admin. Booking pages talk to no third
// party on their own (VAY-2216), so Google Maps loads only when the guest asks for it.
const hasMapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY === "e2e-google-places";
const offerKey = (digit: string) => `pricing-offer.v2:${digit.repeat(64)}`;
const room = (
  id: string,
  name: string,
  digit: string,
  location?: { latitude: number; longitude: number; address?: string },
) => ({
  roomTypeId: id,
  name,
  description: `${name}, made up for this test.`,
  occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
  offers: [{ publicOfferKey: offerKey(digit), currency: "EUR", mealPlan: "room_only" }],
  ...(location && { location }),
});
const villas = [
  room("schwabing", "Schwabing Loft", "a", {
    latitude: 48.15634,
    longitude: 11.58242,
    address: "Leopoldstraße 12, Munich",
  }),
  room("haidhausen", "Haidhausen Garden Flat", "b", {
    latitude: 48.1291,
    longitude: 11.5952,
    address: "Wörthstraße 8, Munich",
  }),
  room("isar", "Isar Studio", "c", { latitude: 48.1302, longitude: 11.5788 }),
  room("family", "Family Apartment", "d"),
];

/** The Google Maps calls the section makes, kept on window.__locationMap: the markers, the popup's text, and
 * clickMarker(index) to tap a pin. */
const GOOGLE_FAKE = `
  // An IIFE: a top-level "class Map" would replace the browser's own Map for the whole page.
  (() => {
  const state = (window.__locationMap = { markers: [], popup: null, fitted: 0 });
  class Map { constructor(element, options) { state.options = options; } fitBounds() { state.fitted += 1; } panTo() {} }
  class InfoWindow {
    setContent(content) { this.content = content; }
    open() { state.popup = this.content; document.body.append(this.content); }
    close() {}
  }
  class Marker {
    constructor(options) {
      this.listeners = {};
      state.markers.push({ title: options.title, label: options.label ? options.label.text : null,
        lat: options.position.lat, lng: options.position.lng, fill: options.icon.fillColor, marker: this });
    }
    addListener(event, handler) { this.listeners[event] = handler; }
  }
  window.__clickMarker = (index) => state.markers[index].marker.listeners.click();
  class LatLngBounds { extend() {} }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  window.google = { maps: { importLibrary: async (library) =>
    library === "maps" ? { Map, InfoWindow } : library === "marker" ? { Marker }
    : library === "core" ? { LatLngBounds, Point } : {} } };
  window.__vayadaGoogleMapsReady?.();
  })();
`;

async function setup(
  page: Page,
  catalog: { locationMap?: boolean; rooms: unknown[] },
  mapPin?: { latitude: number; longitude: number },
) {
  await mockBookingApis(page, mapPin ? { mapPin } : {});
  await page.route("**/pricing-offers", (route) =>
    route.fulfill({ json: { version: "public-pricing-offers.v1", ...catalog } }),
  );
  await mockStayPrices(page, {});
  const googleRequests: string[] = [];
  await page.route("https://maps.googleapis.com/**", (route) => {
    googleRequests.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", body: GOOGLE_FAKE });
  });
  return googleRequests;
}

const markers = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __locationMap?: { markers: { title: string; label: string | null }[] };
        }
      ).__locationMap?.markers.map(({ title, label }) => ({ title, label })) ?? [],
  );

test.describe("booking page location map", () => {
  test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");

  test("lists the rooms' places and loads Google only when the guest asks", async ({ page }) => {
    const google = await setup(page, { locationMap: true, rooms: villas });
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    await expect(section.getByRole("heading", { name: "Location" })).toBeVisible();
    await expect(
      section.getByText("Our rooms are in 3 places. Select a pin to see which room is there."),
    ).toBeVisible();
    const places = section.getByRole("list", { name: "Places on the map" }).getByRole("listitem");
    await expect(places).toHaveCount(3);
    await expect(places.nth(0)).toContainText("Schwabing Loft");
    await expect(places.nth(0)).toContainText("Leopoldstraße 12, Munich");
    await expect(section.getByText("Family Apartment")).toHaveCount(0);
    await expect(
      section.getByText("Loads Google Maps. Google receives your request."),
    ).toBeVisible();
    // Nothing to wait for when all is well: give a late script tag a moment to show up.
    await page.waitForTimeout(1500);
    expect(google).toEqual([]);

    await section.getByRole("button", { name: "Show map" }).click();
    await expect
      .poll(() => markers(page))
      .toEqual([
        { title: "Schwabing Loft", label: "1" },
        { title: "Haidhausen Garden Flat", label: "2" },
        { title: "Isar Studio", label: "3" },
      ]);
    expect(google.length).toBeGreaterThan(0);

    // A tapped pin names its room and opens the room's details.
    await page.evaluate(() =>
      (window as unknown as { __clickMarker: (i: number) => void }).__clickMarker(1),
    );
    await expect(places.nth(1)).toHaveClass(/bg-primary-50/);
    await page.getByRole("button", { name: "View details →" }).click();
    await expect(page.getByRole("dialog")).toContainText("Haidhausen Garden Flat");
  });

  test("shows one pin with the hotel's name when no room has its own place", async ({ page }) => {
    await setup(
      page,
      { locationMap: true, rooms: [room("suite", "Suite", "a"), room("double", "Double", "b")] },
      { latitude: 48.1394, longitude: 11.5835 },
    );
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    await expect(section.getByRole("list", { name: "Places on the map" })).toHaveCount(0);
    await section.getByRole("button", { name: "Show map" }).click();
    await expect.poll(() => markers(page)).toEqual([{ title: "Hotel Alpenrose", label: null }]);
  });

  test("shows no map while the hotel's switch is off", async ({ page }) => {
    const google = await setup(page, { rooms: villas }, { latitude: 48.1394, longitude: 11.5835 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    expect(google).toEqual([]);
  });
});
