import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";
import { mockGoogleMaps, type FakeGooglePlace } from "../support/googleMapsFake";
import { watchPageHealth } from "../support/pageHealth";

// VAY-2126: a room type's own address and pin. Google address search fills the coordinates and the pin can be
// dragged; without Google the host types them, with a comma or a dot.
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
};

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
    await expect(location.getByText("No location yet")).toBeVisible();
    await expect(location.getByText("Add an address to see the pin on the map.")).toBeVisible();

    // Keyboard: the arrow highlights the suggestion and Enter takes it.
    const address = page.getByRole("combobox", { name: "Address" });
    await address.fill("Leopold");
    const suggestion = page.getByRole("option", { name: /Leopoldstraße 12/ });
    await expect(suggestion).toBeVisible();
    await address.press("ArrowDown");
    await expect(suggestion).toHaveAttribute("aria-selected", "true");
    await address.press("Enter");

    await expect(address).toHaveValue("Leopoldstraße 12, 80802 München, Germany");
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
    ).toEqual(["suggest:Leopold", "fields:made-up-leopoldstrasse-12:formattedAddress,location"]);

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
          locationAddress: "Leopoldstraße 12, 80802 München, Germany",
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
          locationAddress: "Leopoldstraße 12, Munich",
          latitude: 48.1565,
          longitude: 11.583,
        }),
      ]);
  });

  test("still saves a room stored earlier with half a coordinate pair", async ({ page }) => {
    const backend = await mockRoomBackend(page, { latitude: 48.1565 });

    await page.goto(`/rooms/${roomTypeId}`);
    await expect(page.getByLabel("Latitude")).toHaveValue("48.1565");
    await expect(page.getByLabel("Longitude")).toHaveValue("");
    await expect(
      page.getByText("Enter both latitude and longitude, or leave both empty."),
    ).toBeVisible();
    const save = page.getByRole("button", { name: "Save Changes" });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    expect(backend.locationWrites).toEqual([]);
  });

  test("removes a saved location", async ({ page }) => {
    const backend = await mockRoomBackend(page, {
      locationAddress: "Leopoldstraße 12, 80802 München, Germany",
      latitude: 48.1565,
      longitude: 11.583,
    });

    await page.goto(`/rooms/${roomTypeId}`);
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
    await expect(page.locator("main").getByText("No location yet")).toBeVisible();
    await expect(page.getByLabel("Latitude")).toHaveValue("");
    await expect(page.getByLabel("Longitude")).toHaveValue("");

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(() => backend.locationWrites)
      .toEqual([expect.objectContaining({ locationAddress: "", latitude: null, longitude: null })]);
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
      for (const key of ["locationAddress", "latitude", "longitude"]) {
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
