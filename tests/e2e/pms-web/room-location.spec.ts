import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
  sharedPropertyProfile,
} from "../support/pmsWebMocks";
import { mockGoogleMaps, type FakeGooglePlace } from "../support/googleMapsFake";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2126: a room type's own address and pin. Google address search fills the coordinates and the pin can be
// dragged; without Google the host types them, with a comma or a dot. VAY-2321: "Same as property" (the default)
// or a "Separate location", shown to guests exactly or as an area, and "Show map in room details".
const roomTypeId = "22222222-2222-4222-8222-222222222222";
const acceptedAt = "2026-10-22T08:00:00.000Z";
// The dev server's Maps key: CI's pms-web job and playwright.config.ts start it with this fake key.
const hasMapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY === "e2e-google-places";

const leopoldstrasse: FakeGooglePlace = {
  placeId: "made-up-leopoldstrasse-12",
  mainText: "Leopoldstraße 12",
  secondaryText: "80802 Munich, Germany",
  formattedAddress: "Leopoldstraße 12, 80802 München, Germany",
  latitude: 48.1563412,
  longitude: 11.5824198,
  area: "Schwabing",
};
// The mocked property's own pin (pmsWebMocks' shared profile: Alpenrose Munich, Alpenstrasse 12).
const propertyPin = "48.1372,11.5756";

test.describe("pms-web room location", () => {
  test("fills the pin from a picked address, takes a dragged pin and saves both", async ({
    page,
  }, testInfo) => {
    test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");
    const assertHealthy = watchPageHealth(page, testInfo);
    const backend = await mockRoomBackend(page);
    await mockGoogleMaps(page, { places: [leopoldstrasse] });

    await page.goto(`/rooms/${roomTypeId}`);
    const location = page.locator("main");
    await page.getByRole("radio", { name: /Separate location/ }).click();
    await expect(location.getByText("Pick an address to place the pin")).toBeVisible();
    await expect(
      location.getByText("Search above, or click the map to drop the pin."),
    ).toBeVisible();

    // Keyboard: the arrow highlights the suggestion and Enter takes it.
    const address = page.getByRole("combobox", { name: "Address" });
    await address.fill("Leopold");
    const suggestion = page.getByRole("option", { name: /Leopoldstraße 12/ });
    await expect(suggestion).toBeVisible();
    await address.press("ArrowDown");
    await expect(suggestion).toHaveAttribute("aria-selected", "true");
    await address.press("Enter");

    await expect(address).toHaveValue("Leopoldstraße 12, 80802 München, Germany");
    await page.getByRole("button", { name: /Coordinates \(advanced\)/ }).click();
    await expect(page.getByLabel("Latitude")).toHaveValue("48.156341");
    await expect(page.getByLabel("Longitude")).toHaveValue("11.58242");
    await expect(location.getByText("Pin set")).toBeVisible();
    const map = page.getByTestId("google-address-map-canvas");
    await expect(map).toHaveAttribute("data-marker", "48.156341,11.58242");
    await expect(map).toHaveAttribute("data-marker-draggable", "true");
    await expect(map).toHaveAttribute("data-marker-title", "Room location");
    expect(
      await page.evaluate(
        () => (window as { vayadaE2ePlaceQueries?: string[] }).vayadaE2ePlaceQueries,
      ),
    ).toEqual([
      "suggest:Leopold",
      "fields:made-up-leopoldstrasse-12:formattedAddress,location,addressComponents",
    ]);

    await expect(map).toHaveAttribute("data-center", "48.156341,11.58242");
    await expect(map).toHaveAttribute("data-zoom", "17");

    // Google reports a dragged pin with full precision; it is kept to six decimals, and the map stays where the
    // host zoomed and panned.
    await map.evaluate((element) =>
      (
        element as HTMLElement & { vayadaE2eDragMarker: (lat: number, lng: number) => void }
      ).vayadaE2eDragMarker(48.15651234, 11.58301234),
    );
    await expect(page.getByLabel("Latitude")).toHaveValue("48.156512");
    await expect(page.getByLabel("Longitude")).toHaveValue("11.583012");
    await expect(map).toHaveAttribute("data-center", "48.156341,11.58242");
    await expect(map).toHaveAttribute("data-zoom", "17");

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([
        expect.objectContaining({
          locationSource: "custom",
          locationAddress: "Leopoldstraße 12, 80802 München, Germany",
          locationArea: "Schwabing",
          latitude: 48.156512,
          longitude: 11.583012,
        }),
      ]);
    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    await assertHealthy();
  });

  test("keeps the cursor and the typed address when address search stops working", async ({
    page,
  }) => {
    test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");
    await mockRoomBackend(page);
    await mockGoogleMaps(page, { places: [leopoldstrasse], placesUnavailable: true });

    await page.goto(`/rooms/${roomTypeId}`);
    await page.getByRole("radio", { name: /Separate location/ }).click();
    const address = page.getByRole("combobox", { name: "Address" });
    // One failed request is treated as a blip; the second turns search off.
    await address.fill("Leop");
    await expect
      .poll(() =>
        page.evaluate(() => (window as { vayadaE2ePlaceQueries?: string[] }).vayadaE2ePlaceQueries),
      )
      .toEqual(["suggest:Leop"]);
    await address.pressSequentially("old");
    await expect(
      page.getByText(
        "Address search isn't available right now. Type the address and place the pin on the map.",
      ),
    ).toBeVisible();
    const typed = page.getByLabel("Address shown to guests");
    await expect(typed).toBeFocused();
    await typed.pressSequentially("straße 12");
    await expect(typed).toHaveValue("Leopoldstraße 12");
    // The map still works: the pin can be placed by hand.
    await expect(page.getByTestId("google-address-map-canvas")).toBeVisible();
  });

  test("takes typed coordinates with a comma and a pasted pair, and holds Save while one is out of range", async ({
    page,
  }) => {
    const backend = await mockRoomBackend(page);
    // A rejected key: the script loads, then Google calls gm_authFailure (with no key the map never loads).
    await mockGoogleMaps(page, { authFailure: true });

    await page.goto(`/rooms/${roomTypeId}`);
    await page.getByRole("radio", { name: /Separate location/ }).click();
    await expect(page.getByText("The map couldn't load")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Address" })).toHaveCount(0);
    // Google rejected the key: trying again can't help, so it isn't offered.
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await page.getByLabel("Address shown to guests").fill("Leopoldstraße 12, Munich");

    const latitude = page.getByLabel("Latitude");
    const longitude = page.getByLabel("Longitude");
    await latitude.fill("48,15634");
    await longitude.fill("181,2");
    await longitude.press("Tab");
    await expect(page.getByText("Longitude must be between -180 and 180.")).toBeVisible();
    await expect(longitude).toHaveAttribute("aria-invalid", "true");
    const save = page.getByRole("button", { name: "Save Changes" });
    await expect(save).toBeDisabled();

    await longitude.fill("11,58242");
    await longitude.press("Tab");
    await expect(latitude).toHaveValue("48.15634");
    await expect(longitude).toHaveValue("11.58242");
    await expect(save).toBeEnabled();

    // "lat, lng" as Google Maps copies it fills both fields.
    await paste(latitude, "48.1565, 11.583");
    await expect(latitude).toHaveValue("48.1565");
    await expect(longitude).toHaveValue("11.583");

    await save.click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([
        expect.objectContaining({
          locationSource: "custom",
          locationAddress: "Leopoldstraße 12, Munich",
          latitude: 48.1565,
          longitude: 11.583,
        }),
      ]);
  });

  test("still saves a room stored earlier with half a coordinate pair", async ({ page }) => {
    const backend = await mockRoomBackend(page, { latitude: 48.1565 });

    await page.goto(`/rooms/${roomTypeId}`);
    // Without a whole pin of its own the room is at the property, and an untouched room writes nothing.
    await expect(page.getByRole("radio", { name: /Same as property/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const save = page.getByRole("button", { name: "Save Changes" });
    await save.click();
    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    expect(backend.locationWrites).toEqual([]);

    // Its own place shows what is wrong with the half pair, and Save still takes the room.
    await page.getByRole("radio", { name: /Separate location/ }).click();
    await expect(page.getByLabel("Latitude")).toHaveValue("48.1565");
    await expect(page.getByLabel("Longitude")).toHaveValue("");
    await expect(
      page.getByText("Enter both latitude and longitude, or leave both empty."),
    ).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([expect.objectContaining({ locationSource: "custom" })]);
    // The half pair the host didn't touch isn't written.
    expect(backend.locationWrites[0]).not.toHaveProperty("latitude");
  });

  test("removes a saved location", async ({ page }) => {
    const backend = await mockRoomBackend(page, {
      locationAddress: "Leopoldstraße 12, 80802 München, Germany",
      latitude: 48.1565,
      longitude: 11.583,
    });

    await page.goto(`/rooms/${roomTypeId}`);
    // Saved before VAY-2321 with its own pin, away from the property: a separate location.
    await expect(page.getByRole("radio", { name: /Separate location/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    if (hasMapsKey) {
      await page.getByRole("button", { name: /Coordinates \(advanced\)/ }).click();
    }
    await expect(page.getByLabel("Latitude")).toHaveValue("48.1565");
    await expect(page.getByLabel("Longitude")).toHaveValue("11.583");
    await expect(page.locator("main").getByText("Pin set")).toBeVisible();
    if (hasMapsKey) {
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker",
        "48.1565,11.583",
      );
    }

    await page.getByRole("button", { name: "Remove location" }).click();
    // Still its own place, now without a pin.
    await expect(page.locator("main").getByText("Pick an address to place the pin")).toBeVisible();
    await expect(page.getByLabel("Latitude")).toHaveValue("");
    await expect(page.getByLabel("Longitude")).toHaveValue("");

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([
        expect.objectContaining({
          locationSource: "custom",
          locationAddress: "",
          latitude: null,
          longitude: null,
        }),
      ]);
  });

  test("uses the property's place by default, and the room-details map switch saves on its own (VAY-2321)", async ({
    page,
  }) => {
    const backend = await mockRoomBackend(page);
    await page.goto(`/rooms/${roomTypeId}`);
    const location = page.locator("main");
    await expect(page.getByRole("radio", { name: /Same as property/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(location.getByText("Alpenrose Munich", { exact: true })).toBeVisible();
    await expect(location.getByText("Alpenstrasse 12, 80331 Munich")).toBeVisible();
    await expect(location.getByText("Pin set")).toBeVisible();
    if (hasMapsKey) {
      // A small map of the property, not an editor.
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker",
        propertyPin,
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker-draggable",
        "false",
      );
    }
    await expect(page.getByRole("combobox", { name: "Address" })).toHaveCount(0);

    const detailsMap = page.getByRole("switch", { name: "Show map in room details" });
    await expect(detailsMap).toHaveAttribute("aria-checked", "true");
    await detailsMap.click();
    await expect(detailsMap).toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([expect.objectContaining({ showMapInDetails: false })]);
    expect(Object.keys(backend.locationWrites[0]).sort()).toEqual([
      "commandId",
      "idempotencyKey",
      "showMapInDetails",
    ]);
  });

  test("switching back to Same as property keeps the room's own place but stops using it (VAY-2321)", async ({
    page,
  }) => {
    const backend = await mockRoomBackend(page, {
      locationAddress: "Leopoldstraße 12, 80802 München, Germany",
      latitude: 48.1565,
      longitude: 11.583,
    });
    await page.goto(`/rooms/${roomTypeId}`);
    const same = page.getByRole("radio", { name: /Same as property/ });
    const separate = page.getByRole("radio", { name: /Separate location/ });
    const save = page.getByRole("button", { name: "Save Changes" });
    await expect(separate).toHaveAttribute("aria-checked", "true");

    // A choice undone, or a switch turned off and on again, writes nothing.
    await same.click();
    await separate.click();
    const detailsMap = page.getByRole("switch", { name: "Show map in room details" });
    await detailsMap.click();
    await detailsMap.click();
    await save.click();
    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    expect(backend.locationWrites).toEqual([]);

    // The keyboard moves between the choices too.
    await separate.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(same).toHaveAttribute("aria-checked", "true");
    await expect(same).toBeFocused();
    await save.click();
    await expect.poll(() => backend.locationWrites).toHaveLength(1);
    expect(Object.keys(backend.locationWrites[0]).sort()).toEqual([
      "commandId",
      "idempotencyKey",
      "locationSource",
    ]);
    expect(backend.locationWrites[0]).toMatchObject({ locationSource: "property" });
  });

  test("edits the property's address over the room, keeping the room's unsaved changes (VAY-2322)", async ({
    page,
  }) => {
    const backend = await mockRoomBackend(page);
    await mockGoogleMaps(page, { places: [] });
    // The other room types: one on "Same as property", an older one on the property's pin by its own
    // coordinates (saved before VAY-2321), and a villa with a place of its own.
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [
            backend.room,
            pmsWebRoomType,
            {
              ...pmsWebRoomType,
              roomTypeId: "room_type_garden",
              name: "Garden Room",
              attributes: { latitude: 48.13721, longitude: 11.57562 },
            },
            {
              ...pmsWebRoomType,
              roomTypeId: "room_type_beach_villa",
              name: "Beach Villa",
              attributes: { locationSource: "custom", latitude: 48.1563, longitude: 11.5824 },
            },
          ],
          sourceFreshness: {},
        },
      }),
    );
    // Guests see an approximate area and no locality: saving the address must keep both.
    const profile = structuredClone(sharedPropertyProfile);
    Object.assign(profile.profile.location, {
      mapDisplayMode: "approximate",
      localityPublic: false,
    });
    const profileWrites: Record<string, unknown>[] = [];
    await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`, (route) => {
      if (route.request().method() !== "PUT") return route.fulfill({ json: profile });
      profileWrites.push(route.request().postDataJSON());
      return route.fallback();
    });

    await page.goto(`/rooms/${roomTypeId}`);
    // An unsaved edit elsewhere in the room stays.
    await page.getByRole("switch", { name: "Show map in room details" }).click();
    const edit = page.getByRole("button", { name: "Edit property address" });
    await edit.click();
    const modal = page.getByRole("dialog", { name: "Property address" });
    const impact = modal.getByTestId("address-impact");
    await expect(impact).toContainText("Changes apply to 3 room types");
    await expect(impact.getByRole("listitem")).toHaveText([
      "Schwabing Loft",
      "Alpine Suite",
      "Garden Room",
    ]);
    await expect(impact).toContainText(
      "Rooms with a separate location keep their own pin: Beach Villa.",
    );
    await expect(modal.getByLabel("Street and number")).toHaveValue("Alpenstrasse 12");
    await expect(modal.getByLabel("Country")).toHaveValue("DE");

    // Escape closes without saving; the focus is back on the link and the room is as it was.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(edit).toBeFocused();
    expect(profileWrites).toEqual([]);

    await edit.click();
    await modal.getByLabel("Street and number").fill("Maximilianstraße 3");
    await modal.getByLabel("Postal code").fill("80539");
    // Enter in a field doesn't save the room behind.
    await modal.getByLabel("Postal code").press("Enter");
    await modal.getByLabel("City / region").fill("");
    const save = modal.getByRole("button", { name: "Save address" });
    await expect(save).toBeDisabled();
    await expect(modal).toContainText("Add the street, city and country before saving.");
    await modal.getByLabel("City / region").fill("Munich");

    // Moving the pin away leaves the older room at its own pin, and says so.
    await modal.getByText("Coordinates", { exact: true }).click();
    await modal.getByLabel("Latitude").fill("48.1394");
    await modal.getByLabel("Longitude").fill("");
    await expect(save).toBeDisabled();
    await expect(modal).toContainText("Enter both coordinates");
    await modal.getByLabel("Longitude").fill("11.5835");
    await expect(impact).toContainText("Changes apply to 2 room types");
    await expect(impact).toContainText(
      "Garden Room sits on the old pin by its own coordinates and stays there.",
    );
    await expect(modal).toContainText("Goes live in the Booking Engine as soon as you save.");
    await save.click();
    await expect(modal).toHaveCount(0);

    // Only the address and pin change: visibility, locality and time zone stay as they were.
    expect(profileWrites).toEqual([
      {
        expectedProfileRevision: 1,
        patch: {
          location: {
            countryCode: "DE",
            city: "Munich",
            streetAddress: "Maximilianstraße 3",
            postalCode: "80539",
            timezone: "Europe/Berlin",
            latitude: 48.1394,
            longitude: 11.5835,
            localityPublic: false,
            geoPublic: true,
            mapDisplayMode: "approximate",
          },
        },
      },
    ]);
    const location = page.locator("main");
    await expect(location.getByText("Property address saved.")).toBeVisible();
    await expect(location.getByText("Maximilianstraße 3, 80539 Munich")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Show map in room details" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(backend.locationWrites).toEqual([]);
  });

  test("shows a separate place to guests as an area, named from Google, next to the property (VAY-2321)", async ({
    page,
  }) => {
    test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");
    const backend = await mockRoomBackend(page);
    await mockGoogleMaps(page, { places: [leopoldstrasse] });
    await page.goto(`/rooms/${roomTypeId}`);
    await page.getByRole("radio", { name: /Separate location/ }).click();
    const map = page.getByTestId("google-address-map-canvas");
    // The main property, for reference.
    await expect(map).toHaveAttribute("data-reference", propertyPin);
    await expect(map).toHaveAttribute("data-reference-title", "Alpenrose Munich");

    const address = page.getByRole("combobox", { name: "Address" });
    await address.fill("Leopold");
    await page.getByRole("option", { name: /Leopoldstraße 12/ }).click();
    await expect(map).toHaveAttribute("data-marker", "48.156341,11.58242");
    const guests = page.locator("main").getByText("Guests will see").locator("..");
    await expect(guests).toContainText("Schwabing Loft");
    await expect(guests).toContainText("Leopoldstraße 12, 80802 München, Germany");
    await expect(guests).toContainText("2.2 km from Alpenrose Munich");

    await page.getByRole("radio", { name: /Approximate area/ }).check();
    await expect(map).toHaveAttribute("data-circle", "48.16,11.58,1000");
    await expect(map).toHaveAttribute("data-marker-visible", "false");
    await expect(page.getByLabel("Area name guests see")).toHaveValue("Schwabing");
    await expect(guests).toContainText("Schwabing · an area about 1 km wide, no street address");
    await expect(guests).toContainText("About 2.2 km from Alpenrose Munich");
    await expect(guests).not.toContainText("Leopoldstraße");

    await page.getByRole("button", { name: "Satellite" }).click();
    await expect(map).toHaveAttribute("data-map-type", "satellite");
    await page.getByRole("button", { name: "Recenter" }).click();
    await expect(map).toHaveAttribute("data-center", "48.16,11.58");

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([
        expect.objectContaining({
          locationSource: "custom",
          locationPrecision: "approximate",
          locationArea: "Schwabing",
          locationAddress: "Leopoldstraße 12, 80802 München, Germany",
          latitude: 48.156341,
          longitude: 11.58242,
        }),
      ]);
  });

  test("places the pin from a pasted Google Maps link or the property's address", async ({
    page,
  }) => {
    test.skip(!hasMapsKey, "needs the dev server's fake Google Maps key");
    await mockRoomBackend(page);
    await mockGoogleMaps(page, { places: [leopoldstrasse] });
    await page.goto(`/rooms/${roomTypeId}`);
    await page.getByRole("radio", { name: /Separate location/ }).click();
    const map = page.getByTestId("google-address-map-canvas");

    await page.getByRole("button", { name: "Paste a Google Maps link" }).click();
    const link = page.getByLabel("Google Maps link");
    await link.fill("https://maps.app.goo.gl/AbCdEf123");
    await expect(
      page.getByText(/Short links \(maps\.app\.goo\.gl\) carry no coordinates/),
    ).toBeVisible();
    await link.fill(
      "https://www.google.com/maps/place/Isar/@48.1301,11.5869,16z/data=!3d48.13021!4d11.58693",
    );
    await expect(page.getByText("Pin placed at 48.13021, 11.58693")).toBeVisible();
    await expect(map).toHaveAttribute("data-marker", "48.13021,11.58693");

    await page.getByRole("button", { name: "Search an address instead" }).click();
    await page.getByRole("button", { name: "Use property address as start" }).click();
    await expect(page.getByRole("combobox", { name: "Address" })).toHaveValue(
      "Alpenstrasse 12, 80331 Munich",
    );
    await expect(map).toHaveAttribute("data-marker", propertyPin);
  });
});

async function paste(field: Locator, text: string) {
  await field.focus();
  await field.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

async function mockRoomBackend(
  page: Page,
  location: { locationAddress?: string; latitude?: number; longitude?: number } | null = null,
) {
  const state = {
    room: {
      ...pmsWebRoomType,
      roomTypeId,
      name: "Schwabing Loft",
      version: "room-type-facts-v3",
      roomAmenitiesRevision: 2,
      attributes: {
        beds: [{ type: "king", quantity: 1 }],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: { value: 32, unit: "sqm" },
        ...location,
      } as Record<string, unknown>,
    },
    locationWrites: [] as Record<string, unknown>[],
  };

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`,
    (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { propertyId: PMS_WEB_PROPERTY_ID, item: state.room } });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.locationWrites.push(body);
      for (const key of [
        "locationAddress",
        "latitude",
        "longitude",
        "locationSource",
        "locationPrecision",
        "locationArea",
        "showMapInDetails",
      ]) {
        if (key in body) state.room.attributes[key] = body[key];
      }
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomType: state.room,
        },
      });
    },
  );
  // Only the location changes, so the room facts are never written.
  const setupPath = `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`;
  await page.route(setupPath, (route) =>
    route.fulfill({ status: 500, json: { code: "unexpected_room_facts_write" } }),
  );
  await page.route(`${setupPath}/capacity`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-room-facts.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        roomTypeId,
        roomUnitsRevision: 2,
        activeUnitCount: 1,
        capturedAt: acceptedAt,
      },
    }),
  );
  await page.route(`${setupPath}/units`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            contractVersion: "pms-room-facts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId,
            roomUnitId: "33333333-3333-4333-8333-333333333333",
            lifecycle: "active",
            operationalLabel: "Schwabing Loft 1",
            operationalLabelStatus: "verified",
          },
        ],
      },
    }),
  );
  return state;
}
