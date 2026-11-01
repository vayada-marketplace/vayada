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
  // Like Google: a LatLng, or a literal with numbers; anything else throws.
  const point = (position) => {
    if (position instanceof LatLng) return { lat: position.lat(), lng: position.lng() };
    if (typeof position?.lat === "number" && typeof position?.lng === "number") return position;
    throw new Error("InvalidValueError: not a LatLng or LatLngLiteral");
  };
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
  class LatLngBounds { extend(position) { point(position); } }
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

async function setup(
  page: Page,
  catalog: { locationMap?: CatalogMap; detailsMap?: CatalogMap; rooms: unknown[] },
) {
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

  test("on a phone, opens a full-screen map from the Map button, with the cards to swipe (VAY-2325)", async ({
    page,
  }) => {
    const google = await setup(page, { locationMap: { property: null }, rooms: villas });
    // The narrowest phone it's made for.
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto("/");
    // The first visit's analytics question sits over the bottom of a phone screen.
    await page.getByRole("button", { name: "Reject analytics" }).click();
    // No view switch and no Location section on a phone: the cards say where each room is.
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Show the accommodations as" })).toHaveCount(0);
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    await expect(page.getByTestId("room-card-schwabing")).toContainText("Own location");
    await expect(page.getByTestId("room-card-family")).toContainText("Main house");
    // The Map button floats while the cards are on screen.
    await page.getByTestId("room-card-schwabing").scrollIntoViewIfNeeded();
    const mapButton = page.getByRole("button", { name: "Map", exact: true });
    await expect(mapButton).toBeVisible();
    expect((await mapButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Every card fits the screen (the page itself clips sideways, so measure the cards).
    for (const right of await page
      .locator('[data-testid^="room-card-"]')
      .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().right)))
      expect(right).toBeLessThanOrEqual(360);
    // Nothing to wait for when all is well: give a late script tag a moment to show up.
    await page.waitForTimeout(1500);
    expect(google).toEqual([]);

    // Pressing it is the guest's choice to load Google.
    await mapButton.click();
    const map = page.getByRole("dialog", { name: "Accommodations on the map" });
    await expect(map).toContainText("4 accommodations");
    await expect(map.getByRole("button", { name: "List", exact: true })).toBeFocused();
    const mapPills = map
      .getByRole("region", { name: "Map of where the rooms are" })
      .getByRole("button");
    await expect(mapPills).toHaveText(["Schwabing Loft", "Haidhausen Garden Flat", "Isar Studio"]);
    expect(google.length).toBeGreaterThan(0);
    // Pins only a few streets apart don't zoom the map in past street level.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __locationMap?: { zoom?: number } }).__locationMap?.zoom,
        ),
      )
      .toBe(16);
    // The first card's pill starts selected, and the map stays put: it's in view.
    await expect(mapPills.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(mapPills.nth(0)).toHaveAttribute("data-no-map-gestures", "1");
    // A pill's touch target reaches past its edges to at least 44 px.
    expect(
      await mapPills
        .nth(0)
        .evaluate(
          (pill) =>
            pill.getBoundingClientRect().height -
            2 * parseFloat(getComputedStyle(pill, "::before").top),
        ),
    ).toBeGreaterThanOrEqual(44);

    // A tapped pill brings its card into view, and the map moves to it when it's out of view.
    await mapPills.nth(1).click();
    await expect(mapPills.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(map.getByTestId("room-card-haidhausen")).toBeInViewport({ ratio: 0.9 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as { __locationMap?: { panned: { lat: number }[] } }
          ).__locationMap?.panned.map(({ lat }) => lat),
        ),
      )
      .toEqual([48.1291]);
    // Swiping to a card selects its pill.
    await map
      .getByTestId("room-card-isar")
      .evaluate((card) => card.scrollIntoView({ inline: "center", block: "nearest" }));
    await expect(mapPills.nth(2)).toHaveAttribute("aria-current", "true");
    await expect(mapPills.nth(1)).not.toHaveAttribute("aria-current");

    // A card's details open over the map.
    await map
      .getByTestId("room-card-isar")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Close room details" })).toBeVisible();
    await page.getByRole("button", { name: "Close room details" }).click();

    // List and Escape go back to the cards; Edit goes back to the search, with the dates open.
    await map.getByRole("button", { name: "List", exact: true }).click();
    await expect(map).toHaveCount(0);
    await expect(mapButton).toBeFocused();
    await mapButton.click();
    await page.keyboard.press("Escape");
    await expect(map).toHaveCount(0);
    await mapButton.click();
    await map.getByRole("button", { name: "Edit" }).click();
    await expect(map).toHaveCount(0);
    await expect(page.locator("#stay-search button").first()).toBeFocused();
    await expect(
      page
        .locator("#stay-search")
        .getByRole("button", { name: /^\d{4}-\d{2}-\d{2}$/ })
        .first(),
    ).toBeVisible();
  });

  test("keeps the cards and pills in step on a tablet, where the end cards can't reach the middle (VAY-2325)", async ({
    page,
  }) => {
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto("/");
    await page.getByRole("button", { name: "Reject analytics" }).click();
    await page.getByTestId("room-card-loft").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Map", exact: true }).click();
    const map = page.getByRole("dialog", { name: "Accommodations on the map" });
    const mapPills = map
      .getByRole("region", { name: "Map of where the rooms are" })
      .getByRole("button");
    await expect(mapPills).toHaveCount(3);
    // Swiping to the end selects the last room.
    await map
      .getByRole("group", { name: "Accommodations" })
      .evaluate((row) => row.scrollTo({ left: row.scrollWidth }));
    await expect(mapPills.nth(2)).toHaveAttribute("aria-current", "true");
    // The main house's pill selects its first room, and the selection stays there at the start of the row.
    await mapPills.nth(0).click();
    await page.waitForTimeout(800);
    await expect(mapPills.nth(0)).toHaveAttribute("aria-current", "true");
    await expect(map.getByTestId("room-card-suite")).toHaveClass(/border-primary-600/);
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
    await page.goto("/");
    await page.getByTestId("accommodations-map").getByRole("button", { name: "Show map" }).click();
    // The rooms at the property share the main house's pill (VAY-2324); the area is a circle.
    await expect(pills(page, "accommodations-map")).toHaveText([
      "Main house · 2 rooms",
      "Schwabing Loft",
      "Beach Villa",
    ]);
    expect(await circles(page)).toEqual([{ lat: 48.13, lng: 11.57, radius: 1000 }]);
    // The area's card names it, never a street; the annex has no place to show yet.
    await expect(page.getByTestId("room-card-villa")).toContainText("Isarvorstadt");
    await expect(page.getByTestId("room-card-annex")).not.toContainText("Own location");
    await expect(page.getByTestId("room-card-annex")).not.toContainText("Main house");
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
    await expect(place).toContainText(
      "Shown as an area, not the exact spot. The exact address is sent with your booking confirmation.",
    );
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

  test("shows where a room is in its details by the room's own switch while the hotel's map is off (VAY-2445)", async ({
    page,
  }) => {
    const google = await setup(page, {
      // The hotel's location map is off: no locationMap, the property's place only for the rooms' details.
      detailsMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [
        room(
          "villa",
          "Beach Villa",
          "a",
          { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12, Munich" },
          false,
        ),
        room(
          "garden",
          "Garden Villa",
          "b",
          { latitude: 48.13, longitude: 11.57, approximate: true, area: "Isarvorstadt" },
          false,
        ),
        room("suite", "Suite", "c", undefined, true),
        { ...room("loft", "Loft", "d", undefined, true), showMapInDetails: false },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Available Accommodations" })).toBeVisible();
    // No map below the list or next to it: those follow the hotel's switch.
    await expect(page.getByTestId("rooms-location-map")).toHaveCount(0);
    await expect(page.getByTestId("accommodations-map")).toHaveCount(0);
    const cards = page.getByRole("button", { name: "View Details", exact: true });
    await expect(cards).toHaveCount(4);

    // A place of its own, exact: street, distance, Directions; Google only after "Show map".
    await cards.nth(0).click();
    let place = page
      .getByRole("dialog")
      .getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toContainText("Leopoldstraße 12, Munich");
    await expect(place).toContainText("1.9 km from the main property");
    await expect(place.getByRole("link", { name: "Directions" })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(google).toEqual([]);
    await place.getByRole("button", { name: "Show map" }).click();
    await expect
      .poll(() => markers(page))
      .toEqual([
        { title: "Beach Villa", label: null },
        { title: "Reception", label: "Reception" },
      ]);
    await page.getByRole("button", { name: "Close room details" }).click();

    // Shown as an area: its circle and name, no street or Directions.
    await cards.nth(1).click();
    place = page
      .getByRole("dialog")
      .getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toContainText("Isarvorstadt");
    await expect(place.getByRole("link", { name: "Directions" })).toHaveCount(0);
    await expect.poll(() => circles(page)).toEqual([{ lat: 48.13, lng: 11.57, radius: 1000 }]);
    await page.getByRole("button", { name: "Close room details" }).click();

    // "Same as property": the hotel's own place.
    await cards.nth(2).click();
    place = page
      .getByRole("dialog")
      .getByRole("region", { name: "Where you'll stay", exact: true });
    await expect(place).toContainText("Hotel Alpenrose");
    await page.getByRole("button", { name: "Close room details" }).click();

    // The room's own switch off: nothing.
    await cards.nth(3).click();
    await expect(page.getByRole("dialog")).toContainText("Loft");
    await expect(page.getByRole("dialog").getByText("Where you'll stay")).toHaveCount(0);
  });

  test("shows the rooms next to a map, and selects a room from its card or its pill (VAY-2324)", async ({
    page,
  }) => {
    const google = await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await mockStayPrices(page, { villa: { [offerKey("d")]: "84000" } });
    // Three nights: €840 for the stay.
    await page.goto("/?checkIn=2027-03-10&checkOut=2027-03-13");
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
    await expect(page.getByTestId("room-card-villa")).toContainText("from €280 / night");
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

// VAY-2327: the host's nearby places on the same guest maps, in the host's order.
const MUSIC = "c0000000-0000-4000-8000-000000000001";
const nearbyPlace = (
  id: string,
  name: string,
  category: string,
  latitude: number,
  longitude: number,
  note: string | null = null,
) => ({
  source: "custom",
  id,
  name,
  address: null,
  category,
  latitude,
  longitude,
  favorite: false,
  note,
});
const NEARBY = {
  schemaVersion: 1,
  status: "ready",
  location: { mode: "exact", latitude: 48.1394, longitude: 11.5835 },
  places: [
    nearbyPlace(
      "p-garden",
      "Englischer Garten",
      "activities",
      48.1525,
      11.5922,
      "Rent a bike at the south entrance and ride to the lake.",
    ),
    nearbyPlace("p-market", "Viktualienmarkt", "food", 48.1351, 11.5763),
    nearbyPlace("p-jazz", "Jazzclub Unterfahrt", MUSIC, 48.1335, 11.5927, "Free jam on Sundays."),
  ],
  categories: [
    { id: "food", name: null, color: "orange", icon: "cake" },
    { id: "nature", name: null, color: "teal", icon: "sun" },
    { id: "activities", name: null, color: "purple", icon: "camera" },
    { id: "transport", name: null, color: "slate", icon: "map" },
    { id: MUSIC, name: "Live music", color: "pink", icon: "musical-note" },
  ],
};

/** Answers the page's nearby request with the host's places, and counts the requests. */
async function mockNearby(page: Page, payload: unknown = NEARBY) {
  const requests: string[] = [];
  await page.route("**/api/booking-web/hotels/hotel-alpenrose/nearby", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: payload });
  });
  return requests;
}
const marker = (page: Page, testId: string, name: string) =>
  page.getByTestId(testId).getByRole("button", { name });
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("nearby places on the guest map (VAY-2327)", () => {
  test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");

  test("List + map: the host's places after Show map, the chips filter them, a place opens its card", async ({
    page,
  }) => {
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    const requests = await mockNearby(page);
    await page.goto("/");
    const map = page.getByTestId("accommodations-map");
    await expect(map.getByRole("button", { name: "Show map" })).toBeVisible();
    // Nothing about the places loads before the guest asks for the map.
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
    await expect(page.getByRole("group", { name: "Nearby places" })).toHaveCount(0);

    await map.getByRole("button", { name: "Show map" }).click();
    const chips = map.getByRole("group", { name: "Nearby places" });
    // One chip per category the places use, in the host's order, the host's own ones too.
    await expect(chips.getByRole("button")).toHaveText(["Food & drink", "Sights", "Live music"]);
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toBeVisible();
    await expect(
      marker(page, "accommodations-map", "Jazzclub Unterfahrt, Live music"),
    ).toBeVisible();
    // Each marker sits at its spot on the map, inside it.
    const [mapBox, markerBox] = await Promise.all([
      map.boundingBox(),
      marker(page, "accommodations-map", "Englischer Garten, Sights").boundingBox(),
    ]);
    expect(markerBox!.x).toBeGreaterThan(mapBox!.x);
    expect(markerBox!.x + markerBox!.width).toBeLessThan(mapBox!.x + mapBox!.width);

    // With no room selected, distances count from the main house.
    await marker(page, "accommodations-map", "Englischer Garten, Sights").click();
    const card = map.getByTestId("nearby-place-card");
    await expect(card).toContainText("Englischer Garten");
    await expect(card).toContainText("Sights · 1.6 km from the main house");
    await expect(card).toContainText("Host tip");
    await expect(card).toContainText("Rent a bike at the south entrance and ride to the lake.");
    await expect(
      card.getByRole("link", { name: "Directions to Englischer Garten, opens Google Maps" }),
    ).toHaveAttribute("href", "https://www.google.com/maps/dir/?api=1&destination=48.1525,11.5922");
    await expect(card.getByRole("button", { name: "Close" })).toBeFocused();
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toBeFocused();

    // A selected room: distances count from its place.
    await page.getByTestId("room-card-loft").click();
    // Keyboard: Enter opens a place's card, Escape closes it and gives the focus back.
    await marker(page, "accommodations-map", "Englischer Garten, Sights").focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("Sights · 840 m from Schwabing Loft");
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toBeFocused();

    // A chip turns its category off at once (and closes its place's card), for this tab.
    await marker(page, "accommodations-map", "Englischer Garten, Sights").click();
    await chips.getByRole("button", { name: "Sights" }).click();
    await expect(chips.getByRole("button", { name: "Sights" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(chips.getByRole("button", { name: "Sights" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(marker(page, "accommodations-map", "Viktualienmarkt, Food & drink")).toBeVisible();
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toHaveCount(0);
    await chips.getByRole("button", { name: "Sights" }).click();
    await expect(marker(page, "accommodations-map", "Englischer Garten, Sights")).toBeVisible();
  });

  test("Map view: the place's card opens bottom right and never covers the room's card", async ({
    page,
  }) => {
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await mockNearby(page);
    await page.goto("/");
    const map = page.getByTestId("accommodations-map");
    await map.getByRole("button", { name: "Show map" }).click();
    await page
      .getByRole("group", { name: "Show the accommodations as" })
      .getByRole("button", { name: "Map", exact: true })
      .click();
    await pills(page, "accommodations-map").nth(1).click();
    await marker(page, "accommodations-map", "Jazzclub Unterfahrt, Live music").click();
    const room = map.getByTestId("room-card-loft");
    const card = map.getByTestId("nearby-place-card");
    await expect(card).toContainText("Live music · 2.7 km from Schwabing Loft");
    const [roomBox, cardBox, mapBox] = await Promise.all([
      room.boundingBox(),
      card.boundingBox(),
      map.boundingBox(),
    ]);
    expect(overlaps(roomBox!, cardBox!)).toBe(false);
    expect(cardBox!.x + cardBox!.width).toBeGreaterThan(mapBox!.x + mapBox!.width - 40);
  });

  test("on a phone, a place's card takes the carousel's place until it's closed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    await mockNearby(page);
    await page.goto("/");
    // The first visit's analytics question sits over the bottom of a phone screen.
    await page.getByRole("button", { name: "Reject analytics" }).click();
    // The Map button floats while the cards are on screen.
    await page.getByTestId("room-card-loft").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Map", exact: true }).click();
    const dialog = page.getByTestId("accommodations-phone-map");
    await expect(
      dialog.getByRole("group", { name: "Nearby places" }).getByRole("button"),
    ).toHaveCount(3);
    await dialog.getByRole("button", { name: "Viktualienmarkt, Food & drink" }).click();
    const card = dialog.getByTestId("nearby-place-card");
    // The first room, Suite, is in the main house.
    await expect(card).toContainText("Food & drink · 720 m from the main house");
    await expect(dialog.getByRole("group", { name: "Accommodations" })).toHaveCount(0);
    await card.getByRole("button", { name: "Close" }).click();
    await expect(dialog.getByRole("group", { name: "Accommodations" })).toBeVisible();
    // With a place's card open, Escape closes the card, not the map; then the map.
    await dialog.getByRole("button", { name: "Viktualienmarkt, Food & drink" }).click();
    await dialog.getByRole("button", { name: "Viktualienmarkt, Food & drink" }).focus();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // The next map opens on the rooms, not on the closed place.
    await page.getByTestId("room-card-loft").scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect(
      page.getByTestId("accommodations-phone-map").getByRole("group", { name: "Accommodations" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("every room in one place: the Location section shows the same chips, markers and card", async ({
    page,
  }) => {
    await setup(page, {
      locationMap: { property: { latitude: 48.1394, longitude: 11.5835, approximate: false } },
      rooms: [room("suite", "Suite", "a"), room("double", "Double", "b")],
    });
    await mockNearby(page);
    await page.goto("/");
    const section = page.getByTestId("rooms-location-map");
    await section.getByRole("button", { name: "Show map" }).click();
    await expect(
      section.getByRole("group", { name: "Nearby places" }).getByRole("button"),
    ).toHaveCount(3);
    await marker(page, "rooms-location-map", "Viktualienmarkt, Food & drink").click();
    await expect(section.getByTestId("nearby-place-card")).toContainText(
      "Food & drink · 720 m from the property",
    );
    // A place without a tip has no "Host tip".
    await expect(section.getByTestId("nearby-place-card")).not.toContainText("Host tip");
    // The card sits over the map, and under it on a phone, where the map is short.
    const boxes = () =>
      Promise.all([
        section.getByRole("region", { name: "Map of where the rooms are" }).boundingBox(),
        section.getByTestId("nearby-place-card").boundingBox(),
      ]);
    let [map, card] = await boxes();
    expect(card!.y + card!.height).toBeLessThanOrEqual(map!.y + map!.height);
    await page.setViewportSize({ width: 390, height: 844 });
    [map, card] = await boxes();
    expect(card!.y).toBeGreaterThanOrEqual(map!.y + map!.height);
  });

  test("shows no nearby places while the host's switch is off", async ({ page }) => {
    await setup(page, { locationMap: MIXED_MAP, rooms: mixed });
    const requests = await mockNearby(page, {
      schemaVersion: 1,
      status: "hidden",
      location: null,
      places: [],
      categories: [],
    });
    await page.goto("/");
    await page.getByTestId("accommodations-map").getByRole("button", { name: "Show map" }).click();
    await expect(pills(page, "accommodations-map")).toHaveCount(3);
    await expect.poll(() => requests.length).toBe(1);
    await expect(page.getByRole("group", { name: "Nearby places" })).toHaveCount(0);
  });
});
