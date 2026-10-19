// Ported from tests/e2e/marketplace-web/setup-activation.spec.ts (VAY-2261): Booking Admin hosts the
// hotel setup wizard. The original stays until the marketplace-web spec folder is deleted.
import {
  createPropertySetupRouteMock,
  mockPropertySetupRoute,
} from "../support/propertySetupRouteMocks";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdaptiveHotelSetupStatus } from "@vayada/domain-hotels";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
import { mockBookingDashboardExit } from "../support/setupExitHandoff";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test.describe("shared setup activation", () => {
  test("does not reopen personal account setup when only a hotel-manager photo is missing", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    let accountProfileWrites = 0;
    let personalMediaRequests = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "test-access-token",
          csrfToken: "test-csrf-token",
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationKind: "hotel_group",
          user: {
            id: "user-hotel-owner",
            email: "owner@alpenrose.example",
            name: "Hotel Owner",
            phone: "+49 89 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            status: "active",
          },
        },
      });
    });
    await page.route(/\/auth\/profile$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      accountProfileWrites += 1;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      personalMediaRequests += 1;
      await route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { error: "unexpected" },
      });
    });
    await mockSharedSetupStatus(page, readySetupStatus());
    await mockHotelProfileApis(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "present_hotel",
      }),
    );
    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Present your hotel", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    expect(accountProfileWrites).toBe(0);
    expect(personalMediaRequests).toBe(0);
  });

  test("offers the address search when an existing hotel has an address but no map pin", async ({
    page,
    baseURL,
  }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    // Open hotel basics land straight in the shared profile editor (update mode).
    await mockSharedSetupStatus(page, hotelBasicsOpenStatus());
    const profileWrites: unknown[] = [];
    await mockHotelProfileApis(
      page,
      [{ mediaType: "logo", url: "https://media.example/alpenrose-logo.webp" }],
      { profile: profileWrites },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "present_hotel",
      }),
    );
    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("textbox", { name: /Hotel name/ })).toHaveValue("Alpenrose Munich");
    await page.getByRole("button", { name: "Continue" }).click();

    // The saved address (Marienplatz 1, no coordinates) keeps its fields open, and the
    // labelled Google search sits above them: typed fields never set a map pin.
    const locationSearchPanel = page.getByTestId("location-search-panel");
    const locationActionBar = page.getByTestId("location-action-bar");
    await expect(
      locationSearchPanel.getByRole("heading", { name: "Where is your property?" }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: /Street address/ })).toHaveValue(
      "Marienplatz 1",
    );
    await expect(
      locationSearchPanel.getByText("Search for your address", { exact: true }),
    ).toBeVisible();
    const googleAddressSearch = page.locator(".vayada-google-place-autocomplete");
    await expect(locationSearchPanel.getByPlaceholder("Search for an address")).toBeVisible();
    await expect(page.getByTestId("google-address-map-canvas")).not.toHaveAttribute(
      "data-marker",
      /./,
    );
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();

    await selectExactGoogleAddress(googleAddressSearch);
    await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
    await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
      "data-marker",
      "48.1373932,11.5754485",
    );
    await locationActionBar.getByRole("button", { name: "Continue" }).click();

    await continuePastGuestPreferences(page);
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(() => profileWrites.length).toBe(1);
    expect(profileWrites[0]).toMatchObject({
      patch: { location: { latitude: 48.1373932, longitude: 11.5754485 } },
    });
  });

  test("a Booking dashboard fix for the hotel's location ticks the box, saves and returns (VAY-2288)", async ({
    page,
    baseURL,
  }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    // Basics are complete, so only the dashboard's focus opens the hotel details form.
    await mockSharedSetupStatus(page, readySetupStatus());
    const writes = { profile: [] as unknown[], launchSettings: [] as unknown[] };
    await mockHotelProfileApis(
      page,
      [{ mediaType: "logo", url: "https://media.example/alpenrose-logo.webp" }],
      writes,
      {
        latitude: 48.1373932,
        longitude: 11.5754485,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(page, new RegExp(`/api/hotel-setup/properties/${propertyId}/import$`), {
      import: null,
    });
    const dashboard = await mockBookingDashboardExit(page, baseURL, propertyId);
    const fixUrl = new URL(setupUrl(baseURL), baseURL ?? "http://localhost:3003");
    fixUrl.searchParams.set("propertyId", propertyId);
    fixUrl.searchParams.set("step", "present_hotel");
    fixUrl.searchParams.set("focus", "location");
    await page.goto(baseURL ? fixUrl.toString() : `${fixUrl.pathname}${fixUrl.search}`);

    const locationActionBar = page.getByTestId("location-action-bar");
    const showLocality = page.getByRole("checkbox", { name: "Show city and country publicly" });
    await expect(
      page.getByTestId("location-search-panel").getByRole("heading", {
        name: "Where is your property?",
      }),
    ).toBeVisible();
    await expect(showLocality).not.toBeChecked();
    await expect(showLocality).toBeFocused();
    await expect(
      page.getByText("Your booking page needs this before it can go live."),
    ).toBeVisible();

    await showLocality.check();
    await expect(page.getByText("Your booking page needs this before it can go live.")).toHaveCount(
      0,
    );
    await locationActionBar.getByRole("button", { name: "Save and continue" }).click();

    await page.waitForURL(dashboard);
    expect(writes.profile).toEqual([
      { expectedProfileRevision: 1, patch: { location: { localityPublic: true } } },
    ]);
    // The focused edit never showed the guest preferences, so it leaves them as saved.
    expect(writes.launchSettings).toEqual([]);
  });

  test("lets a hotel place and drag its map pin when Google address search is unavailable", async ({
    page,
    baseURL,
  }) => {
    const profileWrites = await openLocationWithOpenBasics(page, baseURL, {
      placesUnavailable: true,
    });

    const locationSearchPanel = page.getByTestId("location-search-panel");
    const locationActionBar = page.getByTestId("location-action-bar");
    const map = page.getByTestId("google-address-map-canvas");
    await expect(
      locationSearchPanel.getByText(
        "Address suggestions are unavailable. Enter the address, then click your property on the map.",
      ),
    ).toBeVisible();
    await expect(
      locationSearchPanel.getByText("Search for your address", { exact: true }),
    ).toHaveCount(0);
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();
    await expect(
      locationActionBar.getByText(
        "Needed for your booking page’s map. Zoom in and click your property; drag the pin to adjust.",
      ),
    ).toBeVisible();
    await expect(map).toHaveAttribute("data-zoom-control", "true");
    await expect(map).toHaveAttribute("data-marker-draggable", "true");

    await expect(map).toHaveAttribute("data-zoom-control-position", "3");
    // The open fields stop above the action bar that asks for the pin.
    const panelBox = await locationSearchPanel.boundingBox();
    const actionBarBox = await locationActionBar.boundingBox();
    expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThanOrEqual(actionBarBox?.y ?? 0);
    // Keyboard users get the coordinates instead of the pointer-only map.
    await locationSearchPanel.getByRole("button", { name: "Enter coordinates instead" }).click();
    await expect(page.getByRole("textbox", { name: "Latitude" })).toBeFocused();

    // Zoomed out, a click zooms in on that spot instead of dropping a vague pin.
    const clickMap = () => map.click({ position: { x: 1000, y: 300 } });
    await clickMap();
    await expect(map).toHaveAttribute("data-zoom", "6");
    await expect(map).toHaveAttribute("data-center", "48.1374,11.5754");
    await clickMap();
    await expect(map).toHaveAttribute("data-zoom", "10");
    await clickMap();
    await expect(map).toHaveAttribute("data-zoom", "14");
    await expect(map).not.toHaveAttribute("data-marker", /./);
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();

    await clickMap();
    await expect(map).toHaveAttribute("data-marker", "48.1374,11.5754");
    await expect(map).toHaveAttribute("data-zoom", "17");
    await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
    await expect(
      locationActionBar.getByText(
        "Drag the pin if it isn’t exactly on your property · Time zone · Europe/Berlin",
      ),
    ).toBeVisible();
    // The complete address folds away so the pin is in view.
    await expect(page.getByRole("textbox", { name: /Street address/ })).toHaveCount(0);

    await map.evaluate((element) =>
      (
        element as HTMLElement & { vayadaE2eDragMarker: (lat: number, lng: number) => void }
      ).vayadaE2eDragMarker(48.13745, 11.5756),
    );
    await expect(map).toHaveAttribute("data-marker", "48.13745,11.5756");
    // Dragging keeps the hotel's view: the map doesn't jump to recenter on the pin.
    await expect(map).toHaveAttribute("data-center", "48.1374,11.5754");
    // Once there is a pin, a stray click can't move it; only a drag does.
    await clickMap();
    await expect(map).toHaveAttribute("data-marker", "48.13745,11.5756");
    await expect(page.getByRole("textbox", { name: "Latitude" })).toHaveValue("48.13745");

    await locationActionBar.getByRole("button", { name: "Continue" }).click();
    await continuePastGuestPreferences(page);
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(() => profileWrites.length).toBe(1);
    expect(profileWrites[0]).toMatchObject({
      patch: { location: { latitude: 48.13745, longitude: 11.5756 } },
    });
  });

  test("a focused location fix still saves when the hotel's details lack a phone number (VAY-2288)", async ({
    page,
    baseURL,
  }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, readySetupStatus());
    const writes = { profile: [] as unknown[], launchSettings: [] as unknown[] };
    await mockHotelProfileApis(
      page,
      [{ mediaType: "logo", url: "https://media.example/alpenrose-logo.webp" }],
      writes,
      {
        latitude: 48.1373932,
        longitude: 11.5754485,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      [
        {
          channelType: "email",
          value: "owner@alpenrose.example",
          purpose: "general",
          isPublic: false,
        },
      ],
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(page, new RegExp(`/api/hotel-setup/properties/${propertyId}/import$`), {
      import: null,
    });
    const dashboard = await mockBookingDashboardExit(page, baseURL, propertyId);
    const fixUrl = new URL(setupUrl(baseURL), baseURL ?? "http://localhost:3003");
    fixUrl.searchParams.set("propertyId", propertyId);
    fixUrl.searchParams.set("step", "present_hotel");
    fixUrl.searchParams.set("focus", "location");
    await page.goto(baseURL ? fixUrl.toString() : `${fixUrl.pathname}${fixUrl.search}`);

    await page.getByRole("checkbox", { name: "Show city and country publicly" }).check();
    await page
      .getByTestId("location-action-bar")
      .getByRole("button", { name: "Save and continue" })
      .click();

    // The missing phone number opens the contact step, which saves directly too.
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await expect(page.getByText("Phone number is required.")).toBeVisible();
    expect(writes.profile).toEqual([]);
    await page.getByRole("textbox", { name: /^Phone number/ }).fill("+49 89 123456");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await page.waitForURL(dashboard);
    expect(writes.profile).toHaveLength(1);
    expect(writes.profile[0]).toMatchObject({
      expectedProfileRevision: 1,
      patch: { location: { localityPublic: true } },
    });
    expect(writes.launchSettings).toEqual([]);
  });

  test("keeps the map clickable on a phone while the address fields are open", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLocationWithOpenBasics(page, baseURL, { placesUnavailable: true });
    const map = page.getByTestId("google-address-map-canvas");
    await expect(page.getByRole("textbox", { name: /Street address/ })).toBeVisible();

    // The card moves to the top only while it holds focus, and a touch keeps the pointer on the
    // map while it moves; Playwright's mouse doesn't, so settle focus before measuring.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The card stays below 70% of the screen, so part of the map is always free to tap.
    const card = await page.getByTestId("location-search-panel").locator("..").boundingBox();
    const mapBox = await map.boundingBox();
    if (!card || !mapBox) throw new Error("The location card or map has no box.");
    const y = card.y > 120 ? card.y / 2 : Math.min(card.y + card.height + 60, 844 - 60);
    await map.click({ position: { x: 300 - mapBox.x, y: y - mapBox.y } });
    await expect(map).toHaveAttribute("data-zoom", "6");
  });

  test("keeps the picked map pin clear of the location card on a phone", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLocationWithOpenBasics(page, baseURL);
    await selectExactGoogleAddress(page.locator(".vayada-google-place-autocomplete"));
    await expect(
      page.getByTestId("location-action-bar").getByText("Is this the right location?"),
    ).toBeVisible();

    // Focused on arrival, the card sits at the top of the screen: the pin shows below it.
    await expect.poll(() => locationCardTop(page)).toBeLessThan(100);
    await expect.poll(() => mapPointClearOfLocationCard(page)).toBe(true);

    // A tap on the map takes focus from the card, which drops to the bottom: the pin shows above it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => locationCardTop(page)).toBeGreaterThan(200);
    await expect.poll(() => mapPointClearOfLocationCard(page)).toBe(true);
  });

  test("keeps a found area clear of the location card on a phone", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLocationWithOpenBasics(page, baseURL);
    const locationActionBar = page.getByTestId("location-action-bar");
    await page.getByRole("textbox", { name: /Street address/ }).fill("Unknown Street 5");
    await locationActionBar.getByRole("button", { name: "Find on map" }).click();
    await expect(
      locationActionBar.getByText(
        "Google found the area, not the exact address. Click your property on the map.",
      ),
    ).toBeVisible();
    const map = page.getByTestId("google-address-map-canvas");
    await expect(map).toHaveAttribute("data-center", "48.1351,11.582");
    await expect(map).not.toHaveAttribute("data-marker", /./);

    // The button is disabled while it searches, so focus may have left the card without an event:
    // wherever the card ended up, the area is clear of it.
    await expect.poll(() => mapPointClearOfLocationCard(page)).toBe(true);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => locationCardTop(page)).toBeGreaterThan(200);
    await expect.poll(() => mapPointClearOfLocationCard(page)).toBe(true);

    // Back in the address fields, the card moves to the top: the area shows below it.
    await page.getByRole("textbox", { name: /Street address/ }).focus();
    await expect.poll(() => locationCardTop(page)).toBeLessThan(100);
    await expect.poll(() => mapPointClearOfLocationCard(page)).toBe(true);
  });

  test("offers typed coordinates when Google rejects the map key", async ({ page, baseURL }) => {
    await openLocationWithOpenBasics(page, baseURL, { mapsAuthFailure: true });
    await expect(page.getByText("Map unavailable")).toBeVisible();
    await expect(
      page.getByText(
        "The map couldn’t load. Enter your property’s coordinates, for example copied from Google Maps.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Latitude" })).toBeVisible();
  });

  test("takes typed coordinates when the map itself can't load", async ({ page, baseURL }) => {
    const profileWrites = await openLocationWithOpenBasics(page, baseURL, {
      placesUnavailable: true,
      mapsUnavailable: true,
    });
    const locationActionBar = page.getByTestId("location-action-bar");
    await expect(page.getByText("Map unavailable")).toBeVisible();
    await expect(
      locationActionBar.getByText(
        "Needed for your booking page’s map. Enter your property’s coordinates above.",
      ),
    ).toBeVisible();

    await page.getByRole("textbox", { name: "Latitude" }).fill("48.1374");
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();
    await page.getByRole("textbox", { name: "Longitude" }).fill("181");
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();
    await page.getByRole("textbox", { name: "Longitude" }).fill("11.5754");
    await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Longitude" })).toHaveValue("11.5754");

    await locationActionBar.getByRole("button", { name: "Continue" }).click();
    await continuePastGuestPreferences(page);
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(() => profileWrites.length).toBe(1);
    expect(profileWrites[0]).toMatchObject({
      patch: { location: { latitude: 48.1374, longitude: 11.5754 } },
    });
  });

  test("finds a typed address on the map and says when Google can't place it", async ({
    page,
    baseURL,
  }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, hotelBasicsOpenStatus());
    const profileWrites: unknown[] = [];
    await mockHotelProfileApis(
      page,
      [{ mediaType: "logo", url: "https://media.example/alpenrose-logo.webp" }],
      { profile: profileWrites },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "present_hotel",
      }),
    );
    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue" }).click();

    const locationActionBar = page.getByTestId("location-action-bar");
    const map = page.getByTestId("google-address-map-canvas");
    const streetAddress = page.getByRole("textbox", { name: /Street address/ });
    const findOnMap = locationActionBar.getByRole("button", { name: "Find on map" });
    await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();

    await streetAddress.fill("Nowhere 1");
    await findOnMap.click();
    await expect(
      locationActionBar.getByText(
        "We couldn’t find this address on the map. Click your property on the map instead.",
      ),
    ).toBeVisible();
    await expect(map).not.toHaveAttribute("data-marker", /./);

    // A postcode-level match only shows the area: no pin until the hotel clicks its property.
    await streetAddress.fill("Unknown Street 5");
    await findOnMap.click();
    await expect(
      locationActionBar.getByText(
        "Google found the area, not the exact address. Click your property on the map.",
      ),
    ).toBeVisible();
    await expect(map).toHaveAttribute("data-center", "48.1351,11.582");
    await expect(map).toHaveAttribute("data-zoom", "16");
    await expect(map).not.toHaveAttribute("data-marker", /./);

    await streetAddress.fill("Marienplatz 1");
    await expect(
      locationActionBar.getByText(
        "Needed for your booking page’s map. Click your property on the map.",
      ),
    ).toBeVisible();
    await findOnMap.click();
    await expect(map).toHaveAttribute("data-marker", "48.1373932,11.5754485");
    await expect(map).toHaveAttribute("data-center", "48.1373932,11.5754485");
    await expect(map).toHaveAttribute("data-zoom", "17");
    await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
    await expect(findOnMap).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as { vayadaE2ePlaceQueries?: string[] }).vayadaE2ePlaceQueries,
      ),
    ).toEqual([
      "Nowhere 1, 80331 Munich, Germany | location,types",
      "Unknown Street 5, 80331 Munich, Germany | location,types",
      "Marienplatz 1, 80331 Munich, Germany | location,types",
    ]);

    await locationActionBar.getByRole("button", { name: "Continue" }).click();
    await continuePastGuestPreferences(page);
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(() => profileWrites.length).toBe(1);
    expect(profileWrites[0]).toMatchObject({
      patch: { location: { latitude: 48.1373932, longitude: 11.5754485 } },
    });
  });

  const recoverFirstHotel = async (
    { page, baseURL }: { page: Page; baseURL?: string },
    adding = false,
  ) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    const publicProfileWrites: unknown[] = [];
    await mockHotelProfileApis(page, [canonicalHeroMedia()], {
      publicProfile: publicProfileWrites,
    });
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });

    const logoMediaObjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let propertyCreated = false;
    let propertyCreateRequests = 0;
    let createdPropertyPayload: Record<string, unknown> | null = null;
    let logoUploadFinalized = false;
    let logoAssigned = false;
    let personalMediaRequests = 0;
    let accountProfileWrites = 0;
    let trackSelected = adding;
    const launchSettingsWrites: unknown[] = [];
    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: logoAssigned
          ? readySetupStatus()
          : adding
            ? createAdaptiveHotelSetupStatusMock({
                entryProduct: "booking",
                organizationId: "11111111-1111-4111-8111-111111111111",
                organizationDisplayName: "Alpenrose Hotel Group",
                propertyId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              })
            : trackSelected
              ? createAdaptiveHotelSetupStatusMock({
                  entryProduct: "booking",
                  organizationId: "11111111-1111-4111-8111-111111111111",
                  organizationDisplayName: "Alpenrose Hotel Group",
                  selectedTracks: ["hotel_operations"],
                  propertyId: null,
                })
              : emptySharedSetupStatus(),
      });
    });
    await page.route(/\/api\/hotel-setup\/tracks$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      expect(route.request().postDataJSON()).toEqual({
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
      });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      trackSelected = true;
      const status = createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: null,
      });
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          trackRevision: 1,
          selectedTracks: ["hotel_operations"],
          tracks: status.organization.tracks,
        },
      });
    });
    await page.route(/\/api\/hotel-setup\/properties$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const payload = route.request().postDataJSON();
      propertyCreateRequests += 1;
      expect(payload).toMatchObject({
        displayName: "Hotel Alpenrose",
        propertyType: "hotel",
        location: {
          streetAddress: "Marienplatz 1",
          postalCode: "80331",
          city: "Munich",
          countryCode: "DE",
          localityPublic: true,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [
          {
            channelType: "phone",
            value: "+94 77 123 4567",
            purpose: "general",
            isPublic: true,
          },
          {
            channelType: "whatsapp",
            value: "+49 170 1234567",
            purpose: "general",
            isPublic: true,
          },
          {
            channelType: "email",
            value: "owner@alpenrose.example",
            purpose: "general",
            isPublic: true,
          },
        ],
      });
      expect(payload.location.timezone).toMatch(/\//);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      propertyCreated = true;
      createdPropertyPayload = payload;
      // The Hotel Operations create carries initialLaunchSettings, and the wizard deliberately
      // does not recover a correlated create conflict in that case (the marketplace-web original
      // exercised that recovery with a creator-only hotel). The create succeeds here.
      const { initialLaunchSettings: _launchSettings, ...profile } = payload;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: sharedPropertyProfile(profile),
      });
    });
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/profile$`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        expect(createdPropertyPayload).not.toBeNull();
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: sharedPropertyProfile(createdPropertyPayload ?? {}),
        });
      },
    );
    await page.route(/\/auth\/profile$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      accountProfileWrites += 1;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().url().endsWith("/finalize")) {
        expect(propertyCreated).toBe(true);
        expect(logoAssigned).toBe(false);
        logoUploadFinalized = true;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            mediaObjects: [
              {
                mediaObjectId: logoMediaObjectId,
                purpose: "property.logo",
                status: "private_ready",
                publicVariants: [],
              },
            ],
          },
        });
        return;
      }
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (payload.purpose !== "property.logo") personalMediaRequests += 1;
      expect(payload).toMatchObject({
        purpose: "property.logo",
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
        },
      });
      expect(payload).not.toHaveProperty("expectedProfileRevision");
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          uploadSession: { sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          uploadTargets: [
            {
              uploadTargetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/property-logo",
              headers: {},
            },
          ],
        },
      });
    });
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/media/logo$`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        expect(propertyCreated).toBe(true);
        expect(logoUploadFinalized).toBe(true);
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        expect(route.request().postDataJSON()).toEqual({
          expectedProfileRevision: 1,
          assignment: {
            mediaObjectId: logoMediaObjectId,
            role: "logo",
            altText: null,
            sortOrder: 0,
          },
        });
        logoAssigned = true;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            outcome: "updated",
            profileRevision: 2,
            logoAssignment: {
              mediaObjectId: logoMediaObjectId,
              role: "logo",
              altText: null,
              sortOrder: 0,
            },
            presentationAssignments: [],
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/launch-settings$`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        const payload = route.request().postDataJSON();
        launchSettingsWrites.push(payload);
        await route.fulfill({ status: 200, headers: corsHeaders(route), json: payload });
      },
    );

    const url = new URL(setupUrl(baseURL), baseURL);
    if (adding) {
      url.searchParams.set("mode", "add");
      url.searchParams.set("propertyId", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
      url.searchParams.set("step", "payments");
    }
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "present_hotel",
      }),
    );
    await page.goto(url.toString());

    if (!adding) {
      await expect(
        page.getByRole("heading", { name: "Choose how you’ll use vayada" }),
      ).toBeVisible();
      await page.getByLabel("Hotel Operations").locator("xpath=ancestor::label").click();
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await expect(
      page.getByRole("heading", {
        name: adding ? "Let’s get to know this hotel" : "Let’s get to know your hotel",
      }),
    ).toBeVisible();
    const hotelName = page.getByRole("textbox", { name: /Hotel name/ });
    await hotelName.fill("Hotel Alpenrose");
    await expect(hotelName).toHaveValue("Hotel Alpenrose");
    await page.locator('label:has(input[type="radio"][value="hotel"])').click();
    await expect(page.getByRole("radio", { name: "Hotel", exact: true })).toBeChecked();
    await page.getByLabel("Hotel logo file").setInputFiles({
      name: "alpenrose.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("property-logo"),
    });
    await page.getByRole("button", { name: "Continue" }).click();

    const locationSearchPanel = page.getByTestId("location-search-panel");
    const locationActionBar = page.getByTestId("location-action-bar");
    const locationHeading = locationSearchPanel.getByRole("heading", {
      name: "Where is your property?",
      level: 1,
    });
    await expect(locationHeading).toBeVisible();
    await expect(locationHeading).toBeFocused();
    const locationContinueButton = locationActionBar.getByRole("button", {
      name: "Continue",
    });
    await expect(locationContinueButton).toBeEnabled();
    await expect(locationActionBar.getByText("Is this the right location?")).toHaveCount(0);
    await expect(page.getByText("Search for your hotel address", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Start with a street name. Add the house number or city to narrow the suggestions.",
        { exact: true },
      ),
    ).toHaveCount(0);
    const manualAddressButton = locationSearchPanel.getByRole("button", {
      name: "Enter address manually",
    });
    const streetAddress = page.getByRole("textbox", { name: /Street address/ });
    const searchFirst = await manualAddressButton.isVisible();
    if (
      process.env.CI === "true" ||
      process.env.E2E_START_SERVERS === "1" ||
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    ) {
      expect(searchFirst).toBe(true);
    }
    if (searchFirst) {
      await expect(streetAddress).toHaveCount(0);
      const addressSearch = locationSearchPanel.getByPlaceholder("Search for an address");
      await expect(addressSearch).toBeVisible();
      const googleAddressSearch = page.locator(".vayada-google-place-autocomplete");
      await expect(googleAddressSearch).toHaveAttribute(
        "data-included-primary-types",
        "street_address,route",
      );
      await selectExactGoogleAddress(googleAddressSearch);
      await expect(locationHeading).toBeInViewport();
      await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-center",
        "48.1373932,11.5754485",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-zoom",
        "17",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker",
        "48.1373932,11.5754485",
      );
      await expect(locationContinueButton).toBeEnabled();

      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expect(locationContinueButton).toBeInViewport();
      await addressSearch.focus();
      await googleAddressSearch.dispatchEvent("gmp-error");
      await expect(streetAddress).toBeFocused();
      await expect(streetAddress).toBeInViewport();
    }

    if (searchFirst) await expect(streetAddress).toBeFocused();
    await streetAddress.fill("Marienplatz 1");
    await page.getByRole("textbox", { name: /Postal code/ }).fill("80331");
    await page.getByRole("textbox", { name: /City/ }).fill("Munich");
    const countrySelect = page.getByRole("combobox", { name: /Country/ });
    await expect(countrySelect.locator('option[value="PR"]')).toHaveCount(1);
    await countrySelect.selectOption("DE");
    const localityConsent = page.getByRole("checkbox", {
      name: "Show city and country publicly",
    });
    await expect(localityConsent).not.toBeChecked();
    await localityConsent.check();
    await expect(locationContinueButton).toBeEnabled();

    if (searchFirst) {
      await locationSearchPanel.getByRole("button", { name: "Done editing" }).click();
      await expect(locationActionBar.getByText("Add your map pin")).toBeVisible();
      await expect(
        locationActionBar.getByText("Marienplatz 1, 80331 Munich, Germany"),
      ).toBeVisible();
      await locationSearchPanel.getByRole("button", { name: "Edit address details" }).click();
      await expect(streetAddress).toBeFocused();
    }

    await page.getByRole("button", { name: "Continue" }).click();

    // Hotel Operations suggests guest preferences (currency, language) from the country; the
    // suggestion is accepted as-is and travels with the property create.
    await continuePastGuestPreferences(page);
    await expect(page.getByText("Step 4 of 4 · Contact information")).toBeVisible();
    await expect(page.getByRole("heading", { name: "How can guests reach you?" })).toBeVisible();
    await expect(
      page.getByText("This information is shown when guests click 'Contact' on your booking page."),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Phone number country code" })).toHaveValue(
      "DE",
    );
    await page.getByRole("combobox", { name: "Phone number country code" }).selectOption("LK");
    await page.getByRole("textbox", { name: /^Phone number/ }).fill("0771234567");
    await expect(page.getByRole("textbox", { name: /^Phone number/ })).toHaveValue(
      "+94 77 123 4567",
    );
    await expect(page.getByRole("textbox", { name: /^WhatsApp number/ })).toHaveValue(
      "+94 77 123 4567",
    );
    await page.getByRole("textbox", { name: /^WhatsApp number/ }).fill("+49 170 1234567");
    await page.getByRole("textbox", { name: /^Email/ }).fill("owner@alpenrose.example");
    await expect(page.getByRole("textbox", { name: /Website/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page.getByRole("heading", { name: "Present your hotel", level: 1 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`propertyId=${propertyId}`));
    expect(propertyCreated).toBe(true);
    expect(propertyCreateRequests).toBe(1);
    expect(logoUploadFinalized).toBe(true);
    expect(logoAssigned).toBe(true);
    expect(accountProfileWrites).toBe(0);
    expect(personalMediaRequests).toBe(0);
    expect(publicProfileWrites).toEqual([]);
    expect(launchSettingsWrites).toEqual([]);
    expect(createdPropertyPayload).toMatchObject({
      initialLaunchSettings: {
        defaultCurrency: "EUR",
        supportedCurrencies: [],
        defaultLanguage: "de",
        supportedLanguages: ["en"],
      },
    });
  };
  test("hands a newly created hotel to adaptive setup after saving contact and logo", async ({
    page,
    baseURL,
  }) => recoverFirstHotel({ page, baseURL }));

  test("hands an additional hotel to its own adaptive session instead of the previous hotel", async ({
    page,
    baseURL,
  }) => recoverFirstHotel({ page, baseURL }, true));
});

// An existing hotel with open hotel basics: setup opens the shared profile editor on its
// identity step; Continue moves to Location. Returns the profile PUT bodies.
async function openLocationWithOpenBasics(
  page: Page,
  baseURL: string | undefined,
  google: Parameters<typeof mockGooglePlaces>[1] = {},
) {
  await mockGooglePlaces(page, google);
  await primeBrowserState(page, true);
  await mockAuthSession(page);
  await mockSharedSetupStatus(page, hotelBasicsOpenStatus());
  const profileWrites: unknown[] = [];
  await mockHotelProfileApis(
    page,
    [{ mediaType: "logo", url: "https://media.example/alpenrose-logo.webp" }],
    { profile: profileWrites },
  );
  await routeJson(page, /\/api\/hotel-setup\/property-types/, {
    contractVersion: "adaptive-hotel-property-types.v1",
    propertyTypes: [{ value: "hotel", label: "Hotel" }],
  });
  await mockPropertySetupRoute(
    page,
    createPropertySetupRouteMock({
      propertyId,
      selectedTracks: ["hotel_operations"],
      resumeStepId: "present_hotel",
    }),
  );
  await page.goto(setupUrl(baseURL));
  await expect(page.getByRole("textbox", { name: /Hotel name/ })).toHaveValue("Alpenrose Munich");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByTestId("location-search-panel").getByRole("heading", {
      name: "Where is your property?",
    }),
  ).toBeVisible();
  return profileWrites;
}

// With the Hotel Operations track, Guest preferences sits between Location and Contact
// information. The saved (or country-suggested) settings are valid, so Continue passes through.
async function continuePastGuestPreferences(page: Page) {
  await expect(page.getByText("Step 3 of 4 · Guest preferences")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
}

// The phone location card: the search panel's parent, a full-width sheet over the map.
function locationCard(page: Page) {
  return page.getByTestId("location-search-panel").locator("..");
}

async function locationCardTop(page: Page) {
  return (await locationCard(page).boundingBox())?.y ?? Number.NaN;
}

// The map mock tracks where the point it was last centred on is drawn (data-center-y). A pin there
// stands 43px tall above it; the whole pin must be on the map and outside the card.
async function mapPointClearOfLocationCard(page: Page) {
  const map = page.getByTestId("google-address-map-canvas");
  const mapBox = await map.boundingBox();
  const cardBox = await locationCard(page).boundingBox();
  const pointY = Number(await map.getAttribute("data-center-y"));
  if (!mapBox || !cardBox || !Number.isFinite(pointY)) return false;
  const tip = mapBox.y + pointY;
  const onMap = tip - 43 >= mapBox.y && tip <= mapBox.y + mapBox.height;
  return onMap && (tip - 43 >= cardBox.y + cardBox.height || tip <= cardBox.y);
}

async function mockGooglePlaces(
  page: Page,
  { placesUnavailable = false, mapsUnavailable = false, mapsAuthFailure = false } = {},
) {
  await page.route(/https:\/\/maps\.googleapis\.com\/maps\/api\/js/, async (route) => {
    expect(new URL(route.request().url()).searchParams.get("language")).toBe("en");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        const elementName = "vayada-e2e-place-autocomplete";
        let PlaceAutocompleteElement = customElements.get(elementName);
        if (!PlaceAutocompleteElement) {
          PlaceAutocompleteElement = class extends HTMLElement {
            constructor(options) {
              super();
              const root = this.attachShadow({ mode: "open" });
              const input = document.createElement("input");
              input.setAttribute("part", "input");
              input.setAttribute("aria-label", options.description);
              input.placeholder = options.placeholder;
              root.append(input);
              this.dataset.includedPrimaryTypes = options.includedPrimaryTypes.join(",");
            }
          };
          customElements.define(elementName, PlaceAutocompleteElement);
        }
        const latLng = (lat, lng) => ({ lat: () => lat, lng: () => lng });
        // Text search knows one made-up building and one postcode area; queries are kept.
        window.vayadaE2ePlaceQueries = [];
        const Place = {
          searchByText: async ({ textQuery, fields }) => {
            window.vayadaE2ePlaceQueries.push(textQuery + " | " + fields.join(","));
            return {
              places: textQuery.startsWith("Marienplatz 1,")
                ? [{ location: latLng(48.1373932, 11.5754485), types: ["street_address"] }]
                : textQuery.startsWith("Unknown Street 5,")
                  ? [{ location: latLng(48.1351, 11.582), types: ["postal_code"] }]
                  : [],
            };
          },
        };
        class GoogleMap {
          constructor(element, options) {
            this.element = element;
            this.listeners = {};
            this.setCenter(options.center);
            this.setZoom(options.zoom);
            element.dataset.zoomControl = String(Boolean(options.zoomControl));
            element.dataset.zoomControlPosition = String(options.zoomControlOptions?.position ?? "");
            // Google reports a rejected key after loading, through a global callback.
            if (${mapsAuthFailure}) setTimeout(() => window.gm_authFailure?.(), 0);
            // A real click anywhere on the map lands on one made-up spot.
            element.addEventListener("click", () =>
              this.listeners.click?.({ latLng: latLng(48.1374, 11.5754) }),
            );
          }
          addListener(eventName, handler) {
            this.listeners[eventName] = handler;
            return { remove: () => delete this.listeners[eventName] };
          }
          getZoom() {
            return this.zoom;
          }
          moveCamera({ center, zoom }) {
            this.setCenter(center);
            this.setZoom(zoom);
          }
          setCenter(position) {
            this.element.dataset.center = position.lat + "," + position.lng;
            // Where the centred point is drawn (px from the map's top); panToBounds moves it.
            this.element.dataset.centerY = String(this.element.clientHeight / 2);
          }
          panToBounds(bounds, padding) {
            // Callers keep the point the map was just centred on in view: the least pan that brings
            // it inside the padded map.
            const centerY = Number(this.element.dataset.centerY);
            const bottom = this.element.clientHeight - padding.bottom;
            this.element.dataset.centerY = String(Math.min(Math.max(centerY, padding.top), bottom));
          }
          setZoom(zoom) {
            this.zoom = zoom;
            this.element.dataset.zoom = String(zoom);
          }
        }
        class GoogleMarker {
          constructor(options) {
            this.element = options.map.element;
            this.listeners = {};
            this.element.dataset.markerDraggable = String(Boolean(options.draggable));
            this.element.vayadaE2eDragMarker = (lat, lng) => {
              this.setPosition({ lat, lng });
              this.listeners.dragend?.({ latLng: latLng(lat, lng) });
            };
            this.setPosition(options.position);
          }
          addListener(eventName, handler) {
            this.listeners[eventName] = handler;
          }
          setPosition(position) {
            if (position) {
              this.element.dataset.marker = position.lat + "," + position.lng;
            } else {
              delete this.element.dataset.marker;
            }
          }
        }
        window.google = {
          maps: {
            importLibrary: async (library) =>
              library === "maps"
                ? ${mapsUnavailable}
                  ? Promise.reject(new Error("Maps is unavailable."))
                  : { Map: GoogleMap }
                : library === "marker"
                  ? { Marker: GoogleMarker }
                  : library === "core"
                    ? { ControlPosition: { RIGHT_TOP: 3 } }
                    : ${placesUnavailable}
                    ? Promise.reject(new Error("Places is unavailable."))
                    : { PlaceAutocompleteElement, Place },
          },
        };
        window.__vayadaGoogleMapsReady?.();
      `,
    });
  });
}

async function selectExactGoogleAddress(autocomplete: Locator) {
  await autocomplete.evaluate((element) => {
    const event = new Event("gmp-select");
    Object.defineProperty(event, "placePrediction", {
      value: {
        types: ["street_address"],
        toPlace: () => ({
          fetchFields: async () => undefined,
          location: { lat: () => 48.1373932, lng: () => 11.5754485 },
          postalAddress: {
            addressLines: ["Marienplatz 1"],
            administrativeArea: "Bavaria",
            locality: "Munich",
            postalCode: "80331",
            regionCode: "DE",
          },
        }),
      },
    });
    element.dispatchEvent(event);
  });
}

function setupUrl(baseURL: string | undefined) {
  const path = "/setup?entryProduct=booking&returnProduct=booking&returnTo=/dashboard";
  if (!baseURL) return path;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3003") {
    url.hostname = "localhost";
    url.pathname = "/setup";
    url.search = "?entryProduct=booking&returnProduct=booking&returnTo=/dashboard";
    return url.toString();
  }
  return path;
}

async function primeBrowserState(page: Page, hotelProfile = false) {
  await page.addInitScript(
    ({ primeHotelProfile, selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      if (primeHotelProfile) {
        localStorage.setItem("userType", "hotel");
        localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
      }
    },
    { primeHotelProfile: hotelProfile, selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId: "11111111-1111-4111-8111-111111111111",
        workosOrganizationId: "org_workos_hotel_group",
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Owner Example",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "media-owner",
          status: "active",
          workosUserId: "user_workos_hotel_owner",
        },
      },
    });
  });
}

async function mockSharedSetupStatus(page: Page, status: AdaptiveHotelSetupStatus) {
  await page.route(/\/bank-transfer-destination$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: { destination: null } });
  });
  await page.route(/\/api\/hotel-setup\/status/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: status,
    });
  });
}

// The shared hotel profile reads and writes behind the first-run editor (launch settings,
// profile, public profile, presentation media).
async function mockHotelProfileApis(
  page: Page,
  media: unknown[] = [],
  writes?: {
    profile?: unknown[];
    publicProfile?: unknown[];
    propertyPresentation?: unknown[];
    launchSettings?: unknown[];
  },
  location: Record<string, unknown> = {},
  contacts?: unknown[],
) {
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/launch-settings$`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT")
        writes?.launchSettings?.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json:
          route.request().method() === "PUT"
            ? route.request().postDataJSON()
            : {
                defaultCurrency: "EUR",
                supportedCurrencies: ["CHF"],
                defaultLanguage: "de",
                supportedLanguages: ["en"],
                instagram: "https://instagram.com/alpenrose",
                facebook: "https://facebook.com/alpenrose",
                tiktok: "https://tiktok.com/@alpenrose",
                youtube: "https://youtube.com/@alpenrose",
              },
      });
    },
  );
  let canonicalProfile = sharedPropertyProfile({
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact",
      ...location,
    },
    contacts: [
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
      {
        channelType: "email",
        value: "owner@alpenrose.example",
        purpose: "general",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "general",
        isPublic: false,
      },
    ],
  });
  if (contacts) {
    canonicalProfile = { ...canonicalProfile, profile: { ...canonicalProfile.profile, contacts } };
  }
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/profile`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const request = route.request().postDataJSON() as Record<string, unknown>;
        writes?.profile?.push(request);
        expect(request).toEqual({
          expectedProfileRevision: canonicalProfile.profileRevision,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        canonicalProfile = {
          propertyId,
          profileRevision: canonicalProfile.profileRevision + 1,
          profile: {
            ...canonicalProfile.profile,
            ...patch,
            location:
              patch.location && typeof patch.location === "object"
                ? { ...canonicalProfile.profile.location, ...patch.location }
                : canonicalProfile.profile.location,
          },
        };
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: canonicalProfile,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: canonicalProfile,
      });
    },
  );
  let publicProfile = {
    propertyId,
    profileRevision: 1,
    publicProfile: {
      locale: "en",
      shortDescription: "A city hotel close to the old town.",
      longDescription: null,
      media: media.map((item, index) => {
        const candidate = item as {
          mediaType?: unknown;
          url?: unknown;
          altText?: unknown;
          sortOrder?: unknown;
        };
        return {
          mediaObjectId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          mediaType: candidate.mediaType ?? "gallery_image",
          url: candidate.url ?? `https://media.example/canonical-${index + 1}.webp`,
          altText: candidate.altText ?? null,
          sortOrder: candidate.sortOrder ?? index,
        };
      }),
    },
  };
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/public-profile`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const request = route.request().postDataJSON() as Record<string, unknown>;
        writes?.publicProfile?.push(request);
        expect(request).toEqual({
          expectedProfileRevision: publicProfile.profileRevision,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        publicProfile = {
          propertyId,
          profileRevision: publicProfile.profileRevision + 1,
          publicProfile: {
            ...publicProfile.publicProfile,
            ...patch,
            media: publicProfile.publicProfile.media,
          },
        };
        canonicalProfile = {
          ...canonicalProfile,
          profileRevision: publicProfile.profileRevision,
        };
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: publicProfile,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: publicProfile,
      });
    },
  );
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/media/presentation`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const request = route.request().postDataJSON() as {
        expectedProfileRevision: number;
        assignments: Array<{
          mediaObjectId: string;
          role: "cover" | "gallery";
          altText: string | null;
          sortOrder: number;
        }>;
      };
      writes?.propertyPresentation?.push(request);
      expect(request.expectedProfileRevision).toBe(publicProfile.profileRevision);
      const existingMedia = new Map(
        publicProfile.publicProfile.media.map((item) => [item.mediaObjectId, item]),
      );
      publicProfile = {
        propertyId,
        profileRevision: publicProfile.profileRevision + 1,
        publicProfile: {
          ...publicProfile.publicProfile,
          media: request.assignments.map((assignment) => ({
            mediaObjectId: assignment.mediaObjectId,
            mediaType: assignment.role === "cover" ? "hero_image" : "gallery_image",
            url:
              existingMedia.get(assignment.mediaObjectId)?.url ??
              "https://media.example/uploaded-cover.webp",
            altText: assignment.altText,
            sortOrder: assignment.sortOrder,
          })),
        },
      };
      canonicalProfile = {
        ...canonicalProfile,
        profileRevision: publicProfile.profileRevision,
      };
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          outcome: "updated",
          profileRevision: publicProfile.profileRevision,
          logoAssignment: null,
          presentationAssignments: request.assignments,
        },
      });
    },
  );
}

function canonicalHeroMedia() {
  return {
    mediaType: "hero_image",
    url: "https://media.example/alpenrose-hero.webp",
    altText: "Hotel Alpenrose",
    sortOrder: 0,
  };
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
}
function hotelBasicsOpenStatus(): AdaptiveHotelSetupStatus {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "booking",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations"],
    propertyId,
    propertyDisplayName: "Alpenrose Munich",
    taskOverrides: {
      shared_identity: {
        ownerProgress: "not_started",
        readiness: "actionable",
        actionableBy: "owner",
      },
    },
  });
}

// A hotel whose basics are complete: setup goes straight into the adaptive steps.
function readySetupStatus(): AdaptiveHotelSetupStatus {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "booking",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations"],
    propertyId,
    publicId: "alpenrose-munich",
    propertyDisplayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    recommendedTaskId: null,
  });
}

function emptySharedSetupStatus(): AdaptiveHotelSetupStatus {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "booking",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: [],
    trackRevision: 0,
    propertyId: null,
  });
}

function sharedPropertyProfile(payload: Record<string, unknown>) {
  return {
    propertyId,
    profileRevision: 1,
    profile: payload,
  };
}
