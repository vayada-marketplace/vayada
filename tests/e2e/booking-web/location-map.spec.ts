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

// Two rooms in the main house, a villa of its own and one shown as an area (VAY-2324).
const MIXED_MAP = { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } };
const mixed = [
  room("suite", "Suite", "a", undefined, true),
  room(
    "loft",
    "Schwabing Loft",
    "b",
    { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12, Munich" },
    false,
  ),
  room("double", "Double", "c", undefined, true),
  room(
    "villa",
    "Beach Villa",
    "d",
    { latitude: 48.13, longitude: 11.57, approximate: true, area: "Isarvorstadt" },
    false,
  ),
];

/** The Google Maps calls the page makes, kept on window.__locationMap: the markers and area circles, the
 * popup, and clickMarker(index) to tap a room details pin. The Location section's pills (VAY-2324) are page
 * buttons drawn by an OverlayView: this fake puts each one in its own spot on the map. */
const GOOGLE_FAKE = `
  // An IIFE: a top-level "class Map" would replace the browser's own Map for the whole page.
  (() => {
  const state = (window.__locationMap = { maps: 0, markers: [], circles: [], popup: null, fitted: 0, overlays: 0, panned: [] });
  const point = (position) =>
    typeof position.lat === "function" ? { lat: position.lat(), lng: position.lng() } : position;
  class Map {
    constructor(element, options) {
      state.maps += 1; state.options = options; this.zoom = options.zoom;
      this.pane = document.createElement("div"); element.append(this.pane);
    }
    fitBounds() { state.fitted += 1; this.zoom = 21; setTimeout(() => this.idle?.(), 0); }
    addListener(event, handler) { if (event === "idle") this.idle = handler; return { remove: () => (this.idle = null) }; }
    getZoom() { return this.zoom; }
    setZoom(zoom) { this.zoom = zoom; state.zoom = zoom; }
    // Only Haidhausen is out of view, to show the map moves to a selected place only when it has to.
    getBounds() { return { contains: (position) => point(position).lat !== 48.1291 }; }
    panTo(position) { state.panned.push(point(position)); }
  }
  class OverlayView {
    static preventMapHitsAndGesturesFrom(element) { element.dataset.noMapGestures = "1"; }
    setMap(map) {
      if (!map) return this.onRemove();
      this.map = map; this.slot = state.overlays++; this.onAdd(); this.draw();
    }
    getPanes() { return { floatPane: this.map.pane }; }
    getProjection() { return { fromLatLngToDivPixel: () => ({ x: 170, y: 70 + 70 * this.slot }) }; }
  }
  class Circle {
    constructor(options) {
      this.listeners = {};
      state.circles.push({ ...point(options.center), radius: options.radius, circle: this });
    }
    addListener(event, handler) { this.listeners[event] = handler; }
    setMap() {}
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
  class LatLng { constructor(lat, lng) { this.lat = () => lat; this.lng = () => lng; } }
  class LatLngBounds { extend() {} }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  window.google = { maps: { importLibrary: async (library) =>
    library === "maps" ? { Map, InfoWindow, Circle, OverlayView } : library === "marker" ? { Marker }
    : library === "core" ? { LatLng, LatLngBounds, Point } : {} } };
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

/** A map's pills, as the guest reads them: the Location section's, or the accommodations' (VAY-2324). */
const pills = (
  page: Page,
  map: "rooms-location-map" | "accommodations-map" = "rooms-location-map",
) =>
  page
    .getByTestId(map)
    .getByRole("region", { name: "Map of where the rooms are" })
    .getByRole("button");

// On a phone the Location section still shows rooms in several places (VAY-2325 brings the map to the list).
const PHONE = { width: 390, height: 844 };

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
    await page.setViewportSize(PHONE);
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    await expect(section.getByRole("heading", { name: "Location" })).toBeVisible();
    await expect(section.getByText("Our rooms are in 3 places.")).toBeVisible();
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
    await expect(pills(page)).toHaveText([
      "Schwabing Loft",
      "Haidhausen Garden Flat",
      "Isar Studio",
    ]);
    expect(google.length).toBeGreaterThan(0);
    // Pins only a few streets apart don't zoom the map in past street level.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __locationMap?: { zoom?: number } }).__locationMap?.zoom,
        ),
      )
      .toBe(16);
    // The place picked before the map opened stands out on it, and the map stays put: it's in view.
    await expect(pills(page).nth(2)).toHaveAttribute("aria-current", "true");
    await expect(pills(page).nth(0)).not.toHaveAttribute("aria-current");
    await expect(pills(page).nth(0)).toHaveAttribute("data-no-map-gestures", "1");

    // A tapped pill selects its place in the list, and the map moves to it when it's out of view.
    await pills(page).nth(1).click();
    await expect(pills(page).nth(1)).toHaveAttribute("aria-current", "true");
    await expect(places.nth(1)).toHaveClass(/bg-primary-50/);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __locationMap?: { panned: { lat: number }[] } }
          ).__locationMap?.panned.map(({ lat }) => lat),
        ),
      )
      .toEqual([48.1291]);
    await places.nth(1).getByRole("button", { name: "View details", exact: true }).click();
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
    // Every room in one place: today's list, without the views or location lines (VAY-2324).
    await expect(page.getByRole("group", { name: "Show the accommodations as" })).toHaveCount(0);
    await expect(page.getByTestId("room-card-suite")).not.toContainText("Main house");
    await section.getByRole("button", { name: "Show map" }).click();
    await expect(pills(page)).toHaveText(["Hotel Alpenrose"]);
    expect(await circles(page)).toEqual([]);
  });

  test("lists a lone villa's place, so its details open from the section", async ({ page }) => {
    await setup(page, {
      locationMap: { property: null },
      rooms: [villas[0], room("suite", "Suite", "b", undefined, true)],
    });
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    // The hotel hides its own place: the suite is left off, the loft is the only place.
    const places = section.getByRole("list", { name: "Places on the map" }).getByRole("listitem");
    await expect(places).toHaveCount(1);
    await expect(places).toContainText("Leopoldstraße 12, Munich");
    await places.getByRole("button", { name: "View details", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Schwabing Loft");
  });

  test("shows the area, not a pin, when the hotel's location is approximate", async ({ page }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.14, longitude: 11.58, approximate: true } },
      rooms: [room("suite", "Suite", "a")],
    });
    await page.goto("/");
    await page.getByTestId("rooms-location-map").getByRole("button", { name: "Show map" }).click();
    await expect.poll(() => circles(page)).toEqual([{ lat: 48.14, lng: 11.58, radius: 1000 }]);
    // The area's name sits on the area: no pin on a spot that isn't the hotel's.
    await expect(pills(page)).toHaveText(["Hotel Alpenrose"]);
    await expect(pills(page)).toHaveAttribute("style", /translate\(-50%, -50%\)/);
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
    await page.setViewportSize(PHONE);
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    const places = section.getByRole("list", { name: "Places on the map" }).getByRole("listitem");
    await expect(places).toHaveCount(3);
    // The rooms at the property share the main house's pin (VAY-2324).
    await expect(places.nth(0)).toContainText("Main house · 2 rooms");
    await expect(places.nth(1)).toContainText("Schwabing Loft");
    await expect(places.nth(2)).toContainText("Beach Villa");
    await expect(places.nth(2)).toContainText("Isarvorstadt");
    await expect(section.getByText("Annex")).toHaveCount(0);

    await section.getByRole("button", { name: "Show map" }).click();
    await expect(pills(page)).toHaveText(["Main house · 2 rooms", "Schwabing Loft", "Beach Villa"]);
    expect(await circles(page)).toEqual([{ lat: 48.13, lng: 11.57, radius: 1000 }]);
    // The area's pill names the room, never a street.
    await pills(page).nth(2).click();
    await expect(places.nth(2)).toHaveClass(/bg-primary-50/);
    // Several rooms on one pin: no single room's details to open from it.
    await expect(places.nth(0).getByRole("button", { name: "View details" })).toHaveCount(0);
    await expect(places.nth(2).getByRole("button", { name: "View details" })).toHaveCount(1);
  });

  test("shows where a villa is in its details, with Directions, and loads Google only after Show map (VAY-2323)", async ({
    page,
  }) => {
    const google = await setup(page, {
      locationMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [
        room("suite", "Suite", "a", undefined, true),
        room(
          "villa",
          "Beach Villa",
          "b",
          { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12, Munich" },
          false,
        ),
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await page.getByRole("button", { name: "View Details", exact: true }).nth(1).click();
    const details = page.getByRole("dialog");
    const place = details.getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toBeVisible();
    await expect(place).toContainText("1.9 km from the main property");
    await expect(place).toContainText("Beach Villa");
    await expect(place).toContainText("Leopoldstraße 12, Munich");
    await expect(place.getByRole("link", { name: "Directions" })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=48.15634,11.58242",
    );
    await page.waitForTimeout(1000);
    expect(google).toEqual([]);

    await place.getByRole("button", { name: "Show map" }).click();
    await expect
      .poll(() => markers(page))
      .toEqual([
        { title: "Beach Villa", label: null },
        // The main property, for reference.
        { title: "Reception", label: "Reception" },
      ]);
    expect(google.length).toBeGreaterThan(0);

    await place.getByRole("button", { name: "Expand map" }).click();
    const full = page.getByRole("dialog", { name: "Where you'll stay", exact: true });
    await expect(full).toContainText("Beach Villa · Leopoldstraße 12, Munich");
    await page.keyboard.press("Escape");
    await expect(full).toHaveCount(0);
    // Escape closed the map, not the room's details, and the focus is back on "Expand map".
    await expect(details).toBeVisible();
    await expect(place.getByRole("button", { name: "Expand map" })).toBeFocused();
  });

  test("shows an area without its street or Directions, the property's own place, or nothing (VAY-2323)", async ({
    page,
  }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [
        room(
          "villa",
          "Beach Villa",
          "a",
          { latitude: 48.13, longitude: 11.57, approximate: true, area: "Isarvorstadt" },
          false,
        ),
        room("suite", "Suite", "b", undefined, true),
        { ...room("loft", "Loft", "c", undefined, true), showMapInDetails: false },
      ],
    });
    // "Show map" pressed earlier in this tab counts: the maps load at once.
    await page.addInitScript(() => sessionStorage.setItem("vayada.booking.showMap", "1"));
    await page.goto("/");
    // The map next to the list draws at once, without a new press (VAY-2324).
    await expect(pills(page, "accommodations-map")).toHaveText([
      "Main house · 2 rooms",
      "Beach Villa",
    ]);
    await expect(page.getByRole("button", { name: "Show map" })).toHaveCount(0);
    const cards = page.getByRole("button", { name: "View Details", exact: true });
    await expect(cards).toHaveCount(3);

    await cards.nth(0).click();
    let place = page
      .getByRole("dialog")
      .getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toContainText("Isarvorstadt");
    await expect(place).toContainText("Shown as an area, not the exact spot.");
    await expect(place).toContainText("About 1 km from the main property");
    await expect(place.getByRole("link", { name: "Directions" })).toHaveCount(0);
    // The accommodations map's circle and the popup's own, for the same area.
    await expect
      .poll(() => circles(page))
      .toEqual([
        { lat: 48.13, lng: 11.57, radius: 1000 },
        { lat: 48.13, lng: 11.57, radius: 1000 },
      ]);
    await expect(page.getByTestId("room-place-map")).toBeVisible();
    await page.getByRole("button", { name: "Close room details" }).click();

    // "Same as property": the hotel's own place, no distance.
    await cards.nth(1).click();
    place = page
      .getByRole("dialog")
      .getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toContainText("Hotel Alpenrose");
    await expect(place).not.toContainText("from the main property");
    await expect(place.getByRole("link", { name: "Directions" })).toHaveAttribute(
      "href",
      "https://www.google.com/maps/dir/?api=1&destination=48.1394,11.5835",
    );
    await page.getByRole("button", { name: "Close room details" }).click();

    // "Show map in room details" off.
    await cards.nth(2).click();
    await expect(page.getByRole("dialog")).toContainText("Loft");
    await expect(page.getByRole("dialog").getByText("Where you'll stay")).toHaveCount(0);
  });

  test("shows the rooms next to a map, and selects a room from its card or its pill (VAY-2324)", async ({
    page,
  }) => {
    const google = await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await mockStayPrices(page, { villa: { [offerKey("d")]: "84000" } });
    await page.goto("/");
    const views = page.getByRole("group", { name: "Show the accommodations as" });
    await expect(views.getByRole("button", { name: "List + map" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // One map only: the views replace the Location section.
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    await expect(page.getByTestId("room-card-suite")).toContainText("Main house");
    await expect(page.getByTestId("room-card-loft")).toContainText(
      "Own location · 1.9 km from the main house",
    );
    await expect(page.getByTestId("room-card-villa")).toContainText(
      "Isarvorstadt · about 1 km from the main house",
    );
    // The short cards show the lowest price per night and keep the choices in their details.
    await expect(page.getByTestId("room-card-villa")).toContainText(/from €[\d,.]+\/ night/);
    await expect(page.getByTestId("select-rate-suite")).toHaveCount(0);
    // The list works before the map: picking a card loads nothing.
    await page
      .getByTestId("room-card-loft")
      .getByRole("button", { name: "Schwabing Loft" })
      .click();
    await page.waitForTimeout(1000);
    expect(google).toEqual([]);

    const map = page.getByTestId("accommodations-map");
    await map.getByRole("button", { name: "Show map" }).click();
    await expect(pills(page, "accommodations-map")).toHaveText([
      "Main house · 2 rooms",
      "Schwabing Loft",
      "Beach Villa",
    ]);
    // The card picked before the map opened is the selected pill.
    await expect(pills(page, "accommodations-map").nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("room-card-loft")).toHaveClass(/border-primary-600/);

    // The main house's pill selects its first room in the guest's order.
    await pills(page, "accommodations-map").nth(0).click();
    await expect(
      page.getByTestId("room-card-suite").getByRole("button", { name: "Suite" }),
    ).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("room-card-loft")).not.toHaveClass(/border-primary-600/);
    // A card selects its pill.
    await page.getByTestId("room-card-villa").click();
    await expect(pills(page, "accommodations-map").nth(2)).toHaveAttribute("aria-current", "true");

    await page
      .getByTestId("room-card-villa")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Beach Villa");
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Select This Rate" }),
    ).toBeVisible();
  });

  test("keeps the map when switching to Map, shows the selected room on it, and remembers the view (VAY-2324)", async ({
    page,
  }) => {
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await page.goto("/");
    const views = page.getByRole("group", { name: "Show the accommodations as" });
    const map = page.getByTestId("accommodations-map");
    await map.getByRole("button", { name: "Show map" }).click();
    await expect(pills(page, "accommodations-map")).toHaveCount(3);

    await views.getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.getByTestId("room-card-suite")).toHaveCount(0);
    await pills(page, "accommodations-map").nth(1).click();
    // The selected room floats on the map, with its details.
    await expect(map.getByTestId("room-card-loft")).toContainText("Schwabing Loft");
    await expect(map.getByTestId("room-card-loft")).toContainText("Own location");
    // Switching views moved the map, it didn't load another one.
    expect(
      await page.evaluate(
        () => (window as unknown as { __locationMap: { maps: number } }).__locationMap.maps,
      ),
    ).toBe(1);

    // This tab remembers the view and the "Show map".
    await page.reload();
    await expect(views.getByRole("button", { name: "Map", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(pills(page, "accommodations-map")).toHaveCount(3);

    // List: today's cards with where each room is, and no map.
    await views.getByRole("button", { name: "List", exact: true }).click();
    await expect(map).toHaveCount(0);
    await expect(page.getByTestId("select-rate-loft")).toBeVisible();
    await expect(page.getByTestId("room-card-loft")).toContainText(
      "Own location · 1.9 km from the main house",
    );
  });

  test("shows no map while the hotel's switch is off", async ({ page }) => {
    const google = await setup(page, { rooms: villas });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    expect(google).toEqual([]);
  });
});
