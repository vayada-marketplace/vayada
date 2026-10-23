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
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
    approximate?: true;
    area?: string;
  },
  atProperty?: boolean,
) => ({
  roomTypeId: id,
  name,
  description: `${name}, made up for this test.`,
  occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
  offers: [{ publicOfferKey: offerKey(digit), currency: "EUR", mealPlan: "room_only" }],
  ...(location && { location }),
  ...(atProperty !== undefined && { atProperty }),
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

/** The Google Maps calls the section makes, kept on window.__locationMap: the markers, the area circles, the
 * popup, and clickMarker(index) to tap a pin. */
const GOOGLE_FAKE = `
  // An IIFE: a top-level "class Map" would replace the browser's own Map for the whole page.
  (() => {
  const state = (window.__locationMap = { markers: [], circles: [], popup: null, fitted: 0 });
  class Map {
    constructor(element, options) { state.options = options; this.zoom = options.zoom; }
    fitBounds() { state.fitted += 1; this.zoom = 21; setTimeout(() => this.idle?.(), 0); }
    addListener(event, handler) { if (event === "idle") this.idle = handler; return { remove: () => (this.idle = null) }; }
    getZoom() { return this.zoom; }
    setZoom(zoom) { this.zoom = zoom; state.zoom = zoom; }
    panTo() {}
  }
  class Circle {
    constructor(options) {
      this.listeners = {};
      state.circles.push({ lat: options.center.lat, lng: options.center.lng, radius: options.radius, circle: this });
    }
    addListener(event, handler) { this.listeners[event] = handler; }
  }
  window.__clickCircle = (index) => state.circles[index].circle.listeners.click();
  class InfoWindow {
    setContent(content) { this.content = content; }
    setPosition(position) { state.popupAt = position; }
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
    library === "maps" ? { Map, InfoWindow, Circle } : library === "marker" ? { Marker }
    : library === "core" ? { LatLngBounds, Point } : {} } };
  window.__vayadaGoogleMapsReady?.();
  })();
`;

type CatalogMap = {
  property: { latitude: number; longitude: number; approximate: boolean } | null;
};

async function setup(page: Page, catalog: { locationMap?: CatalogMap; rooms: unknown[] }) {
  await mockBookingApis(page);
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

const circles = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __locationMap?: { circles: { lat: number; lng: number; radius: number }[] };
        }
      ).__locationMap?.circles.map(({ lat, lng, radius }) => ({ lat, lng, radius })) ?? [],
  );

test.describe("booking page location map", () => {
  test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");

  test("lists the rooms' places and loads Google only when the guest asks", async ({ page }) => {
    const google = await setup(page, { locationMap: { property: null }, rooms: villas });
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
    // Picking a place before the map is open only highlights it: Google loads on "Show map" alone.
    await places.nth(2).getByRole("button").first().click();
    await expect(places.nth(2).getByRole("button").first()).toHaveAttribute("aria-current", "true");
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
    // Pins only a few streets apart don't zoom the map in past street level.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __locationMap?: { zoom?: number } }).__locationMap?.zoom,
        ),
      )
      .toBe(17);
    // The place picked before the map opened gets its popup.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __locationMap?: { popup: HTMLElement | null } }).__locationMap
              ?.popup?.textContent,
        ),
      )
      .toContain("Isar Studio");

    // A tapped pin names its room and opens the room's details.
    await page.evaluate(() =>
      (window as unknown as { __clickMarker: (i: number) => void }).__clickMarker(1),
    );
    await expect(places.nth(1)).toHaveClass(/bg-primary-50/);
    await page.getByRole("button", { name: "View details", exact: true }).last().click();
    await expect(page.getByRole("dialog")).toContainText("Haidhausen Garden Flat");
  });

  test("shows one pin with the hotel's name when no room has its own place", async ({ page }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [room("suite", "Suite", "a"), room("double", "Double", "b")],
    });
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    await expect(section.getByRole("list", { name: "Places on the map" })).toHaveCount(0);
    await section.getByRole("button", { name: "Show map" }).click();
    await expect.poll(() => markers(page)).toEqual([{ title: "Hotel Alpenrose", label: null }]);
  });

  test("shows the area, not a pin, when the hotel's location is approximate", async ({ page }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.14, longitude: 11.58, approximate: true } },
      rooms: [room("suite", "Suite", "a")],
    });
    await page.goto("/");
    await page.getByTestId("rooms-location-map").getByRole("button", { name: "Show map" }).click();
    await expect.poll(() => circles(page)).toEqual([{ lat: 48.14, lng: 11.58, radius: 1000 }]);
    expect(await markers(page)).toEqual([]);
  });

  test("puts the rooms at the property on the hotel's pin, and a villa shown as an area as a circle (VAY-2321)", async ({
    page,
  }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [
        room("suite", "Suite", "a", undefined, true),
        room(
          "loft",
          "Schwabing Loft",
          "b",
          {
            latitude: 48.15634,
            longitude: 11.58242,
            address: "Leopoldstraße 12, Munich",
          },
          false,
        ),
        room("double", "Double", "c", undefined, true),
        room(
          "villa",
          "Beach Villa",
          "d",
          {
            latitude: 48.13,
            longitude: 11.57,
            approximate: true,
            area: "Isarvorstadt",
          },
          false,
        ),
        // A place of its own without a pin yet: left off.
        room("annex", "Annex", "e", undefined, false),
      ],
    });
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    const places = section.getByRole("list", { name: "Places on the map" }).getByRole("listitem");
    await expect(places).toHaveCount(3);
    await expect(places.nth(0)).toContainText("Hotel Alpenrose");
    await expect(places.nth(1)).toContainText("Schwabing Loft");
    await expect(places.nth(2)).toContainText("Beach Villa");
    await expect(places.nth(2)).toContainText("Isarvorstadt");
    await expect(section.getByText("Annex")).toHaveCount(0);

    await section.getByRole("button", { name: "Show map" }).click();
    await expect
      .poll(() => markers(page))
      .toEqual([
        { title: "Hotel Alpenrose", label: "1" },
        { title: "Schwabing Loft", label: "2" },
      ]);
    expect(await circles(page)).toEqual([{ lat: 48.13, lng: 11.57, radius: 1000 }]);
    // The area opens its popup where it is, and names the area, not a street.
    await page.evaluate(() =>
      (window as unknown as { __clickCircle: (i: number) => void }).__clickCircle(0),
    );
    await expect(places.nth(2)).toHaveClass(/bg-primary-50/);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __locationMap?: { popup: HTMLElement | null } }).__locationMap
              ?.popup?.textContent,
        ),
      )
      .toBe("Beach VillaIsarvorstadtView details →");
  });

  test("shows no map while the hotel's switch is off", async ({ page }) => {
    const google = await setup(page, { rooms: villas });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    expect(google).toEqual([]);
  });
});
