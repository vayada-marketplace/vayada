import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_PROFILE_PATH,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
  defaultBookingAdminPropertyProfile,
} from "../support/bookingAdminMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";

// VAY-2326: Booking Admin › Location & surroundings › Nearby places, the host's own places in guest order.
const nearby = `/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/nearby`;
const locationMap = `/api/booking/properties/${BOOKING_ADMIN_PROPERTY_ID}/location-map`;
const PROPERTY = { latitude: 48.1394, longitude: 11.5835 };
const MUSIC = "c0000000-0000-4000-8000-000000000001";
const place = (
  n: number,
  name: string,
  category: string,
  latitude: number,
  longitude: number,
  note: string | null,
) => ({
  id: `a0000000-0000-4000-8000-00000000000${n}`,
  category,
  name,
  address: null,
  latitude,
  longitude,
  favorite: false,
  hidden: false,
  note,
});
const VIKTUALIENMARKT = place(
  1,
  "Viktualienmarkt",
  "food",
  48.1351,
  11.5763,
  "Grab a Weißwurst before noon.",
);
const EISBACH = place(
  2,
  "Eisbach wave",
  "nature",
  48.1435,
  11.5878,
  "Watch the river surfers from the bridge.",
);
const ISARTOR = place(3, "Isartor S-Bahn", "transport", 48.135, 11.5822, null);
// What production holds today: two Google choices the v1 editor neither shows nor sends.
const CHOICES = [
  {
    placeId: "google_hidden",
    category: "food",
    hidden: true,
    favorite: false,
    added: false,
    note: null,
  },
  {
    placeId: "google_favorite",
    category: "nature",
    hidden: false,
    favorite: true,
    added: false,
    note: null,
  },
];

/**
 * The parts of Google Maps the location page uses: the address map (VAY-2322) and the nearby places map, whose
 * markers are page content in an overlay. The projection is 10,000 px a degree around the property, so a marker
 * moved by the arrow keys lands on a known spot. `element.vayadaE2eClickMap(lat, lng)` clicks the map; the
 * "Find the area" search picks the Chinesischer Turm when typed into, as a road-level result (no exact address),
 * or `window.__nearbyFakePlace` when set.
 */
const GOOGLE_FAKE = `
  (() => {
    const state = (window.__nearbyFake = { cameras: [], searches: 0 });
    const latLng = (lat, lng) => ({ lat: () => lat, lng: () => lng });
    const projection = {
      fromLatLngToDivPixel: (p) => ({ x: (p.lng() - ${PROPERTY.longitude}) * 10000 + 300, y: (${PROPERTY.latitude} - p.lat()) * 10000 + 300 }),
      fromDivPixelToLatLng: (px) => latLng(${PROPERTY.latitude} - (px.y - 300) / 10000, ${PROPERTY.longitude} + (px.x - 300) / 10000),
    };
    class GMap {
      constructor(element, options) {
        this.element = element; this.listeners = {}; this.zoom = options.zoom;
        this.pane = document.createElement("div");
        this.pane.style.cssText = "position:absolute;inset:0";
        element.append(this.pane);
        element.vayadaE2eClickMap = (lat, lng) => this.listeners.click?.({ latLng: latLng(lat, lng) });
      }
      addListener(event, handler) { this.listeners[event] = handler; return { remove: () => delete this.listeners[event] }; }
      fitBounds() { setTimeout(() => this.listeners.idle?.(), 0); }
      moveCamera(camera) { state.cameras.push(camera); }
      getZoom() { return this.zoom; }
      setZoom(zoom) { this.zoom = zoom; }
      setCenter() {} panToBounds() {} setMapTypeId() {}
    }
    class OverlayView {
      static preventMapHitsAndGesturesFrom(element) { element.dataset.noMapGestures = "1"; }
      setMap(map) { if (!map) return this.onRemove(); this.map = map; this.onAdd(); this.draw(); }
      getPanes() { return { floatPane: this.map.pane }; }
      getProjection() { return projection; }
    }
    class Circle { setMap() {} setCenter() {} setVisible() {} }
    class Marker { setMap() {} setPosition() {} setTitle() {} setVisible() {} addListener() {} }
    class LatLng { constructor(lat, lng) { this.a = lat; this.b = lng; } lat() { return this.a; } lng() { return this.b; } }
    class LatLngBounds { extend() {} }
    class PlaceAutocompleteElement extends HTMLElement {
      constructor(options) {
        super();
        const input = document.createElement("input");
        input.setAttribute("aria-label", options.description);
        input.addEventListener("change", () => {
          state.searches += 1;
          const event = new Event("gmp-select");
          const found = window.__nearbyFakePlace ?? { lat: 48.1525, lng: 11.5922 };
          event.placePrediction = { types: [], toPlace: () => ({ location: latLng(found.lat, found.lng), addressComponents: found.addressComponents, fetchFields: async () => {} }) };
          this.dispatchEvent(event);
        });
        this.append(input);
      }
    }
    customElements.define("gmp-place-autocomplete", PlaceAutocompleteElement);
    window.google = { maps: { importLibrary: async (library) =>
      library === "maps" ? { Map: GMap, Circle, OverlayView }
      : library === "marker" ? { Marker }
      : library === "core" ? { LatLng, LatLngBounds, ControlPosition: { RIGHT_TOP: 1 } }
      : library === "places" ? { PlaceAutocompleteElement } : {} } };
  })();
`;

async function setup(
  page: Page,
  {
    places = [VIKTUALIENMARKT, EISBACH, ISARTOR],
    customCategories = [] as unknown[],
    nearbyEnabled = true,
  } = {},
) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.addInitScript(GOOGLE_FAKE);
  const profile = structuredClone(defaultBookingAdminPropertyProfile);
  profile.profile.displayName = "Alpenrose Apartments";
  profile.profile.location = {
    ...profile.profile.location,
    ...PROPERTY,
    mapDisplayMode: "exact",
    geoPublic: true,
  };
  const state = {
    curation: {
      schemaVersion: 1,
      profileRevision: profile.profileRevision,
      curationRevision: 1,
      savedProfileRevision: profile.profileRevision as number | null,
      choices: CHOICES as unknown[],
      customPlaces: places as unknown[],
      customCategories,
      categoryNames: {} as Record<string, string>,
    },
    puts: [] as Record<string, unknown>[],
    switches: [] as unknown[],
    nearbyEnabled,
    saveStatus: 200,
    switchStatus: 200,
  };
  await page.route(`**${BOOKING_ADMIN_PROPERTY_PROFILE_PATH}`, async (route) => {
    if (route.request().method() === "PUT") {
      profile.profile.location = route.request().postDataJSON().patch.location;
      profile.profileRevision += 1;
      state.curation.profileRevision = profile.profileRevision;
    }
    await route.fulfill({ json: profile });
  });
  await page.route(`**${nearby}/curation`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.puts.push(body);
      if (state.saveStatus !== 200)
        return route.fulfill({ status: state.saveStatus, json: { code: "revision_conflict" } });
      // Like the API: what the write leaves out stays as saved.
      state.curation = {
        ...state.curation,
        ...body,
        curationRevision: state.curation.curationRevision + 1,
        savedProfileRevision: profile.profileRevision,
      };
      delete (state.curation as Record<string, unknown>).expectedProfileRevision;
      delete (state.curation as Record<string, unknown>).expectedCurationRevision;
    }
    await route.fulfill({ json: state.curation });
  });
  // The booking API is another origin: the browser asks first (OPTIONS) and needs CORS headers.
  await page.route(`**${locationMap}**`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return fulfillCorsPreflight(route);
    const headers = corsHeaders(route);
    if (method === "PUT" && route.request().url().endsWith("/nearby")) {
      const body = route.request().postDataJSON() as { enabled: boolean };
      state.switches.push(body);
      if (state.switchStatus !== 200)
        return route.fulfill({
          status: state.switchStatus,
          headers,
          json: { code: "location_map_unavailable" },
        });
      state.nearbyEnabled = body.enabled;
      return route.fulfill({ headers, json: { enabled: body.enabled } });
    }
    return route.fulfill({
      headers,
      json: {
        enabled: true,
        nearbyEnabled: state.nearbyEnabled,
        canSwitch: true,
        rooms: [
          {
            roomTypeId: "00000000-0000-4000-8000-000000000001",
            name: "Garden Villa",
            address: "Wörthstraße 8, Munich",
            pin: { latitude: 48.1291, longitude: 11.5952 },
            atProperty: false,
            approximate: false,
          },
        ],
        property: {
          name: "Alpenrose Apartments",
          address: "Maximilianstraße 3, 80539 Munich",
          pin: PROPERTY,
          mapDisplayMode: "exact",
        },
      },
    });
  });
  return state;
}

// Tall enough that the whole editor shows: Booking Admin scrolls inside its own layout, not the page.
test.use({ viewport: { width: 1440, height: 2400 } });

const editor = (page: Page) => page.getByRole("region", { name: "Nearby places", exact: true });
const map = (page: Page) => page.getByRole("region", { name: "Map of your nearby places" });
const rows = (page: Page) => editor(page).locator("ol > li");
async function names(page: Page) {
  return rows(page).evaluateAll((items) =>
    items.map((item) => item.querySelector("p.font-bold")?.textContent),
  );
}
// Booking Admin scrolls inside its main column, so that is where content would stick out.
async function expectNoSidewaysScroll(page: Page) {
  expect(await page.locator("main").evaluate((main) => main.scrollWidth <= main.clientWidth)).toBe(
    true,
  );
}
async function savePlaces(page: Page) {
  await editor(page).getByRole("button", { name: "Save places", exact: true }).click();
  await expect(page.getByText("Places saved.", { exact: true })).toBeVisible();
}

test("lists the host's places in guest order and saves a new order without the Google choices", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/settings/location");
  await expect(editor(page).getByRole("heading", { name: "Nearby places" })).toBeVisible();
  await expect(editor(page).getByRole("switch", { name: "Show nearby places" })).toBeChecked();
  expect(await names(page)).toEqual(["Viktualienmarkt", "Eisbach wave", "Isartor S-Bahn"]);
  await expect(rows(page).nth(0)).toContainText("Food & drink · 0.7 km");
  await expect(rows(page).nth(0)).toContainText("“Grab a Weißwurst before noon.”");
  await expect(rows(page).nth(1)).toContainText("Beach & surf · 0.6 km");
  await expect(rows(page).nth(2)).toContainText("Getting around · 0.5 km");
  // The map: the property, the villa with its own location, and one marker per place.
  await expect(map(page).getByText("What guests see")).toBeVisible();
  await expect(map(page).getByText("Alpenrose Apartments")).toBeVisible();
  await expect(map(page).getByText("Garden Villa")).toBeVisible();
  for (const name of ["Viktualienmarkt", "Eisbach wave", "Isartor S-Bahn"])
    await expect(map(page).locator(`[title="${name}"]`)).toHaveCount(1);
  await expect(editor(page).getByText("3 of 20 places · All changes saved")).toBeVisible();
  await editor(page).screenshot({ path: test.info().outputPath("list-1440.png") });

  // Keyboard: the handle moves its row, keeps the focus, and says where it went.
  const isartor = editor(page).getByRole("button", { name: /^Move Isartor S-Bahn/ });
  await isartor.focus();
  await page.keyboard.press("ArrowUp");
  expect(await names(page)).toEqual(["Viktualienmarkt", "Isartor S-Bahn", "Eisbach wave"]);
  await expect(isartor).toBeFocused();
  await expect(editor(page).getByText("Isartor S-Bahn, moved to position 2 of 3")).toBeAttached();
  // Drag: by the handle, onto the last row.
  const handle = await editor(page)
    .getByRole("button", { name: /^Move Viktualienmarkt/ })
    .boundingBox();
  const last = await rows(page).nth(2).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(last!.x + 100, last!.y + last!.height / 2, { steps: 8 });
  await expect(rows(page).nth(2)).toHaveClass(/ring-indigo-500/);
  await page.mouse.up();
  expect(await names(page)).toEqual(["Isartor S-Bahn", "Eisbach wave", "Viktualienmarkt"]);
  await expect(editor(page).getByText("3 of 20 places · Unsaved changes")).toBeVisible();

  await savePlaces(page);
  expect(Object.keys(state.puts[0]).sort()).toEqual([
    "categoryNames",
    "customCategories",
    "customPlaces",
    "expectedCurationRevision",
    "expectedProfileRevision",
    "schemaVersion",
  ]);
  expect((state.puts[0].customPlaces as { name: string }[]).map((p) => p.name)).toEqual([
    "Isartor S-Bahn",
    "Eisbach wave",
    "Viktualienmarkt",
  ]);
  // The Google choices stay as saved.
  expect(state.curation.choices).toEqual(CHOICES);
  await expect(editor(page).getByText("3 of 20 places · All changes saved")).toBeVisible();
});

test("adds a place: the search moves the map, a click drops the pin, and a new category", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/settings/location");
  await editor(page).getByRole("button", { name: "Add a place", exact: true }).click();
  const form = editor(page)
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: "Add a place" }) })
    .filter({ has: page.getByRole("button", { name: "Add to map" }) })
    .last();
  const add = form.getByRole("button", { name: "Add to map" });
  await expect(add).toBeDisabled();
  await expect(form.getByText("Click the map where the place is.", { exact: true })).toBeVisible();

  await form.getByRole("textbox", { name: "Find the area" }).fill("Englischer Garten");
  await form.getByRole("textbox", { name: "Find the area" }).dispatchEvent("change");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __nearbyFake: { cameras: unknown[] } }).__nearbyFake.cameras,
      ),
    )
    .toEqual([{ center: { lat: 48.1525, lng: 11.5922 }, zoom: 15 }]);
  // The search alone drops no pin: Google's place never becomes the host's.
  await expect(add).toBeDisabled();
  // The fake map keeps its click on the map element inside the region.
  await map(page).evaluate((region) => {
    type Clickable = Element & { vayadaE2eClickMap?: (lat: number, lng: number) => void };
    const map = [region, ...region.querySelectorAll("*")].find(
      (element) => (element as Clickable).vayadaE2eClickMap,
    ) as Clickable;
    map.vayadaE2eClickMap!(48.1525, 11.5922);
  });
  await expect(form.getByText("Pin dropped · 1.6 km from Alpenrose Apartments")).toBeVisible();
  await form.getByLabel("Place name").fill("Chinesischer Turm");

  await form.getByRole("button", { name: "New category" }).click();
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Live music");
  await expect(form.getByText("10 / 24")).toBeVisible();
  await form.locator("label").filter({ hasText: "Indigo" }).click();
  await expect(form.getByRole("radio", { name: "Indigo" })).toBeChecked();
  await form.locator("label").filter({ hasText: "Pink" }).click();
  await form.locator("label").filter({ hasText: "Star" }).click();
  await form.locator("label").filter({ hasText: "Music" }).click();
  await expect(form.getByRole("radio", { name: "Music" })).toBeChecked();
  // While the new category is open, the place can't be added yet.
  await expect(add).toBeDisabled();
  await editor(page).screenshot({ path: test.info().outputPath("new-category-1440.png") });
  await form.getByRole("button", { name: "Add category" }).click();
  await expect(form.getByRole("button", { name: "Live music", pressed: true })).toBeVisible();

  const tip = form.getByRole("textbox", { name: /^Your tip/ });
  await tip.fill("x".repeat(141));
  await expect(form.getByText("Shorten your tip to 140 characters.")).toBeVisible();
  await expect(add).toBeDisabled();
  await tip.fill("A brass band plays on Sunday afternoons.");
  await expect(form.getByText("40 / 140")).toBeVisible();
  await editor(page).screenshot({ path: test.info().outputPath("add-1440.png") });
  await add.click();

  expect(await names(page)).toEqual([
    "Viktualienmarkt",
    "Eisbach wave",
    "Isartor S-Bahn",
    "Chinesischer Turm",
  ]);
  await expect(rows(page).nth(3)).toContainText("Live music · 1.6 km");
  await savePlaces(page);
  const saved = state.puts[0] as {
    customPlaces: { name: string; category: string; latitude: number; note: string }[];
    customCategories: { id: string; name: string; color: string; icon: string }[];
  };
  expect(saved.customCategories).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Live music",
      color: "pink",
      icon: "musical-note",
    },
  ]);
  expect(saved.customPlaces[3]).toMatchObject({
    name: "Chinesischer Turm",
    category: saved.customCategories[0].id,
    latitude: 48.1525,
    note: "A brass band plays on Sunday afternoons.",
  });
  await page.reload();
  await expect(rows(page).nth(3)).toContainText("Live music · 1.6 km");
});

test("edits a place in the list, moves its marker, and asks before deleting another", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/settings/location");
  await editor(page).getByRole("button", { name: "Edit Eisbach wave" }).click();
  const editing = rows(page).nth(1);
  await expect(editing).toContainText("Editing · Beach & surf · 0.6 km");
  await editing.getByLabel("Place name").fill("");
  await expect(editing.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await editing.getByLabel("Place name").fill("Eisbach surf wave");
  await editing.getByRole("button", { name: "Sights" }).click();
  await expect(
    editing.getByText("Drag the highlighted marker on the map to move it."),
  ).toBeVisible();
  // The ringed marker moves with the arrow keys too.
  const marker = map(page).getByRole("button", { name: /^Move Eisbach surf wave/ });
  await marker.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await editor(page).screenshot({ path: test.info().outputPath("edit-1440.png") });
  await editing.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rows(page).nth(1)).toContainText("Eisbach surf wave");
  await expect(rows(page).nth(1)).toContainText("Sights · ");

  await editor(page).getByRole("button", { name: "Edit Viktualienmarkt" }).click();
  await rows(page).nth(0).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rows(page).nth(0)).toContainText("Remove from map?");
  await expect(rows(page).nth(0)).toContainText(
    "Viktualienmarkt disappears from your booking page when you save.",
  );
  await editor(page).screenshot({ path: test.info().outputPath("delete-1440.png") });
  await rows(page).nth(0).getByRole("button", { name: "Keep" }).click();
  await expect(rows(page).nth(0).getByLabel("Place name")).toHaveValue("Viktualienmarkt");
  await rows(page).nth(0).getByRole("button", { name: "Delete", exact: true }).click();
  await rows(page).nth(0).getByRole("button", { name: "Delete", exact: true }).click();
  expect(await names(page)).toEqual(["Eisbach surf wave", "Isartor S-Bahn"]);
  await expect(editor(page).getByText("2 of 20 places · Unsaved changes")).toBeVisible();

  await savePlaces(page);
  const saved = state.puts[0].customPlaces as {
    name: string;
    category: string;
    latitude: number;
    longitude: number;
  }[];
  expect(saved).toHaveLength(2);
  expect(saved[0]).toMatchObject({ name: "Eisbach surf wave", category: "activities" });
  expect(saved[0].latitude).toBeCloseTo(EISBACH.latitude, 6);
  expect(saved[0].longitude).toBeCloseTo(EISBACH.longitude + 0.0016, 6);
});

test("Edit categories renames a standard one and deletes one of the host's own, moving its place", async ({
  page,
}) => {
  const state = await setup(page, {
    places: [VIKTUALIENMARKT, { ...EISBACH, name: "Jazzclub Unterfahrt", category: MUSIC }],
    customCategories: [{ id: MUSIC, name: "Live music", color: "pink", icon: "musical-note" }],
  });
  await page.goto("/settings/location");
  await expect(rows(page).nth(1)).toContainText("Live music · 0.6 km");
  await editor(page).screenshot({ path: test.info().outputPath("categories-before-1440.png") });
  await editor(page).getByRole("button", { name: "Edit categories" }).click();
  await editor(page).getByRole("textbox", { name: "Name of Food & drink" }).fill("Street food");
  await expect(rows(page).nth(0)).toContainText("Street food · 0.7 km");
  await editor(page).screenshot({ path: test.info().outputPath("categories-rename-1440.png") });
  await editor(page).getByRole("button", { name: "Delete Live music" }).click();
  await expect(editor(page).getByText("Delete “Live music”?")).toBeVisible();
  const move = editor(page).getByRole("combobox", { name: /1 place uses it/ });
  await move.selectOption({ label: "Sights" });
  await editor(page).screenshot({ path: test.info().outputPath("categories-delete-1440.png") });
  await editor(page).getByRole("button", { name: "Delete category" }).click();
  await expect(rows(page).nth(1)).toContainText("Sights · 0.6 km");
  // Emptying a standard name brings its translated name back.
  await editor(page).getByRole("textbox", { name: "Name of Beach & surf" }).fill("Surf");
  await editor(page).getByRole("textbox", { name: "Name of Beach & surf" }).fill("");
  await editor(page).getByRole("button", { name: "Done" }).click();
  await editor(page).screenshot({ path: test.info().outputPath("categories-after-1440.png") });
  await savePlaces(page);
  expect(state.puts[0]).toMatchObject({
    categoryNames: { food: "Street food" },
    customCategories: [],
    customPlaces: [{ category: "food" }, { name: "Jazzclub Unterfahrt", category: "activities" }],
  });
});

test("forms take the focus and give it back; Escape closes them and takes back their new category", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/settings/location");
  const add = editor(page).getByRole("button", { name: "Add a place", exact: true });
  await add.click();
  await expect(editor(page).getByLabel("Place name")).toBeFocused();
  await editor(page).getByRole("button", { name: "New category" }).click();
  await editor(page).getByRole("textbox", { name: "Name", exact: true }).fill("Temporary");
  await editor(page).getByRole("button", { name: "Add category" }).click();
  await expect(editor(page).getByText("3 of 20 places · Unsaved changes")).toBeVisible();
  await editor(page).getByLabel("Place name").press("Escape");
  await expect(add).toBeFocused();
  // The category made for the cancelled place went with it.
  await expect(editor(page).getByText("3 of 20 places · All changes saved")).toBeVisible();

  const edit = editor(page).getByRole("button", { name: "Edit Isartor S-Bahn" });
  await edit.click();
  await expect(editor(page).getByLabel("Place name")).toHaveValue("Isartor S-Bahn");
  await expect(editor(page).getByLabel("Place name")).toBeFocused();
  await editor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(edit).toBeFocused();

  const categories = editor(page).getByRole("button", { name: "Edit categories" });
  await categories.click();
  await expect(editor(page).getByRole("textbox", { name: "Name of Food & drink" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(categories).toBeFocused();
});

test("Show nearby places saves at once; off, the preview shows no places", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/settings/location");
  const toggle = editor(page).getByRole("switch", { name: "Show nearby places" });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(state.switches).toEqual([{ enabled: false }]);
  await expect(editor(page).getByText("Guests don't see nearby places right now")).toBeVisible();
  await expect(map(page).getByText("Guests see no nearby places")).toBeVisible();
  await expect(map(page).locator('[title="Viktualienmarkt"]')).toHaveCount(0);
  await expect(map(page).getByText("Garden Villa")).toBeVisible();
  // The list stays editable and nothing waits for "Save places".
  await expect(editor(page).getByText("3 of 20 places · All changes saved")).toBeVisible();
  await editor(page).screenshot({ path: test.info().outputPath("off-1440.png") });
  state.switchStatus = 503;
  await toggle.click();
  await expect(editor(page).getByText("The switch could not be saved. Try again.")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  state.switchStatus = 200;
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(map(page).locator('[title="Viktualienmarkt"]')).toHaveCount(1);
});

test("failed and conflicting saves keep the edits", async ({ page }) => {
  const state = await setup(page);
  await page.goto("/settings/location");
  await editor(page)
    .getByRole("button", { name: /^Move Isartor S-Bahn/ })
    .focus();
  await page.keyboard.press("ArrowUp");
  for (const [status, text] of [
    [503, "Changes could not be saved. Your edits are kept."],
    [409, "Someone changed this property's settings. Your edits are kept."],
  ] as const) {
    state.saveStatus = status;
    await editor(page).getByRole("button", { name: "Save places", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible();
    expect(await names(page)).toEqual(["Viktualienmarkt", "Isartor S-Bahn", "Eisbach wave"]);
  }
  state.saveStatus = 200;
  await savePlaces(page);
});

test("on a phone the map sits above the list, and nothing scrolls sideways", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 2400 });
  await page.goto("/settings/location");
  const mapBox = await map(page).boundingBox();
  const firstRow = await rows(page).nth(0).boundingBox();
  expect(mapBox!.y + mapBox!.height).toBeLessThan(firstRow!.y);
  await editor(page).screenshot({ path: test.info().outputPath("list-390.png") });
  await editor(page).getByRole("button", { name: "Add a place", exact: true }).click();
  await editor(page).getByRole("button", { name: "New category" }).click();
  await editor(page).screenshot({ path: test.info().outputPath("add-390.png") });
  await expectNoSidewaysScroll(page);
});

test("the editor speaks the admin's language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("admin_language", "de"));
  await setup(page);
  await page.goto("/settings/location");
  await expect(page.getByRole("heading", { name: "Lage & Umgebung" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Orte in der Nähe", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Orte in der Nähe zeigen" })).toBeChecked();
  await expect(
    page.getByRole("region", { name: "Orte in der Nähe", exact: true }).locator("ol > li").first(),
  ).toContainText("Essen & Trinken · 0,7 km");
  await expect(page.getByText("3 von 20 Orten · Alle Änderungen gespeichert")).toBeVisible();
});

test("mobile editing, discard and navigation protection retain dirty forms", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/location");
  await page.getByLabel("Street and number", { exact: true }).fill("Changed street");
  // The pin marks where guests arrive: typing the address keeps it (VAY-2322).
  await expect(page.getByLabel(/^latitude$/i)).toHaveValue(String(PROPERTY.latitude));
  await expect(page.getByText("Save your location before editing nearby places.")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await expect(page).toHaveURL(/settings\/location/);
  await expect(page.getByLabel("Street and number", { exact: true })).toHaveValue("Changed street");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.reload({ timeout: 2000 }).catch(() => {});
  await expect(page.getByLabel("Street and number", { exact: true })).toHaveValue("Changed street");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByLabel("Street and number", { exact: true })).not.toHaveValue(
    "Changed street",
  );
  await expectNoSidewaysScroll(page);
});

test("an unfinished place keeps the page from being left", async ({ page }) => {
  await setup(page);
  await page.goto("/settings/location");
  await editor(page).getByRole("button", { name: "Add a place", exact: true }).click();
  await editor(page).getByLabel("Place name").fill("Unfinished garden");
  await expect(
    editor(page).getByRole("button", { name: "Save places", exact: true }),
  ).toBeDisabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "General", exact: true })
    .click();
  await expect(page).toHaveURL(/settings\/location/);
  await expect(editor(page).getByLabel("Place name")).toHaveValue("Unfinished garden");
});

// VAY-2344: a test hotel's pin sat in Oman: a road-level search result never moves the pin, and a pin
// only moves by dragging. A road far from the pin now clears it and shows the road, so a click pins it.
for (const width of [1440, 390]) {
  test(`a road picked far from the pin clears it and shows the road; a click there pins it (${width})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 2400 });
    await setup(page);
    // Welhengoda Road, Ahangama: Google knows only the road, so it is no arrival point.
    await page.addInitScript(() => {
      const part = (longText: string, shortText: string, type: string) => ({
        longText,
        shortText,
        types: [type],
      });
      (window as unknown as { __nearbyFakePlace: unknown }).__nearbyFakePlace = {
        lat: 5.9731,
        lng: 80.3628,
        addressComponents: [
          part("Welhengoda Road", "Welhengoda Rd", "route"),
          part("Ahangama", "Ahangama", "locality"),
          part("Sri Lanka", "LK", "country"),
        ],
      };
    });
    await page.goto("/settings/location");
    const coordinates = page.locator("summary", { hasText: "Coordinates" });
    await expect(coordinates).toContainText("48.1394, 11.5835");
    const search = page.getByRole("textbox", { name: "Property address" });
    await search.fill("Welhengoda Road");
    await search.dispatchEvent("change");
    const form = page.locator("form").filter({ has: search });

    await expect(
      page.getByText("Pick an address, click the map or type coordinates to place the pin."),
    ).toBeVisible();
    await expect(coordinates).not.toContainText("48.1394");
    await expect(page.getByLabel("City / region")).toHaveValue("Ahangama");
    await form.screenshot({ path: testInfo.outputPath(`vay2344-road-pick-${width}.png`) });
    const cameras = () =>
      page.evaluate(
        () => (window as unknown as { __nearbyFake: { cameras: unknown[] } }).__nearbyFake.cameras,
      );
    await expect.poll(cameras).toContainEqual({ center: { lat: 5.9731, lng: 80.3628 }, zoom: 16 });
    await page.getByTestId("google-address-map-canvas").evaluate((canvas) => {
      (
        canvas as Element & { vayadaE2eClickMap: (lat: number, lng: number) => void }
      ).vayadaE2eClickMap(5.9729, 80.3631);
    });
    await expect(coordinates).toContainText("5.9729, 80.3631");
    await page.getByRole("button", { name: "Save location", exact: true }).click();
    await expect(page.getByText(/^Location saved/)).toBeVisible();
  });
}

test("a road picked near the pin keeps it", async ({ page }) => {
  await setup(page);
  await page.goto("/settings/location");
  const coordinates = page.locator("summary", { hasText: "Coordinates" });
  // The fake's road is 1.6 km from the pin: close enough to be the same place.
  const search = page.getByRole("textbox", { name: "Property address" });
  await search.fill("Englischer Garten");
  await search.dispatchEvent("change");
  await expect(coordinates).toContainText("48.1394, 11.5835");
  await expect(
    page.getByText("Pick an address, click the map or type coordinates to place the pin."),
  ).toHaveCount(0);
});

test("saving a new location keeps the places and says when they need a look", async ({ page }) => {
  await setup(page);
  await page.goto("/settings/location");
  await page.getByLabel("Guest map visibility").selectOption("approximate");
  await page.getByRole("button", { name: "Save location", exact: true }).click();
  await expect(page.getByText(/^Location saved/)).toBeVisible();
  expect(await names(page)).toEqual(["Viktualienmarkt", "Eisbach wave", "Isartor S-Bahn"]);
});

test("fallback protects same-document back, forward and app navigation", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  await setup(page);
  await page.goto("/settings/location");
  await expect(page.getByLabel("Street and number", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, "", "?step=1");
    history.pushState({}, "", "?step=2");
    history.back();
  });
  await expect(page).toHaveURL(/step=1/);
  await page.getByLabel("Street and number", { exact: true }).fill("Keep this draft");
  for (const direction of ["back", "forward"] as const) {
    const dialog = page.waitForEvent("dialog");
    await page.evaluate((direction) => history[direction](), direction);
    await (await dialog).dismiss();
    await expect(page).toHaveURL(/step=1/);
    await expect(page.getByLabel("Street and number", { exact: true })).toHaveValue(
      "Keep this draft",
    );
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(page).toHaveURL(/step=1/);
});

test("a hung map loader reaches its readable fallback, and the list still works", async ({
  page,
}) => {
  await page.clock.install();
  await setup(page);
  await page.addInitScript(() => {
    const google = (
      window as unknown as { google: { maps: { importLibrary: (l: string) => Promise<unknown> } } }
    ).google;
    const real = google.maps.importLibrary;
    google.maps.importLibrary = (library) =>
      library === "maps" ? new Promise(() => {}) : real(library);
  });
  await page.goto("/settings/location");
  await expect(map(page).getByText("Loading map…")).toBeAttached();
  await page.clock.runFor(13000);
  await expect(
    page.getByText("The map could not load. You can still edit your list."),
  ).toBeVisible();
  await editor(page)
    .getByRole("button", { name: /^Move Isartor S-Bahn/ })
    .focus();
  await page.keyboard.press("ArrowUp");
  expect(await names(page)).toEqual(["Viktualienmarkt", "Isartor S-Bahn", "Eisbach wave"]);
});
