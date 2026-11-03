// Ported from tests/e2e/marketplace-web/adaptive-room-authoring.spec.ts (VAY-2261): Booking Admin hosts the
// hotel setup wizard. The original stays until the marketplace-web spec folder is deleted.
import { mockBookingDashboardExit } from "../support/setupExitHandoff";
import {
  createAdaptiveHotelSetupStatusMock,
  mockHotelSetupPrerequisites,
} from "../support/sharedHotelSetupMocks";
import { expect, test, type Page } from "@playwright/test";
import type { PropertySetupRouteReadModel, PropertySetupStepDraft } from "@vayada/domain-hotels";

import { createPropertySetupRouteMock } from "../support/propertySetupRouteMocks";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
import { mockRoomOwnerApis } from "../support/roomOwnerMocks";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const roomTypeIds = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
];
const now = "2026-08-03T12:00:00.000Z";

test.describe("adaptive room authoring", () => {
  test.describe.configure({ timeout: 120_000 });

  test("authors, resumes, and safely removes multiple typed rooms without pricing traffic", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeState = await mockRoute(page, () => routeWithRoomsDraft(emptyRoomsDraft()));
    const owner = await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Add your room types", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    const assertHealthy = watchPageHealth(page, testInfo);
    await fillCoreRoom(page, "Garden Suite", "3", "2");
    await page.getByLabel("No additional room amenities apply.").check();
    await uploadPhoto(page, "garden-suite.jpg");
    await page.getByRole("button", { name: "Save and add another" }).click();

    await expect(page.getByRole("heading", { name: "Garden Suite", level: 3 })).toBeVisible();
    await fillCoreRoom(page, "Courtyard Twin", "2", "2");
    await page.getByRole("button", { name: "Wi-Fi" }).click();
    await uploadPhoto(page, "courtyard-twin.jpg");
    await page.getByRole("button", { name: "Save and add another" }).click();

    const savedRooms = page.getByRole("heading", { level: 3 });
    await expect(savedRooms.filter({ hasText: "Garden Suite" })).toBeVisible();
    await expect(savedRooms.filter({ hasText: "Courtyard Twin" })).toBeVisible();
    await page.getByRole("button", { name: "Discard blank room" }).click();
    const courtyardCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Courtyard Twin" }) });
    await courtyardCard.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Remove room type" }).click();
    await expect(page.getByRole("dialog", { name: "Remove this room type?" })).toContainText(
      /operational references/i,
    );
    await page.getByRole("dialog").getByRole("button", { name: "Remove room type" }).click();

    await expect(page.getByRole("heading", { name: "Courtyard Twin", level: 3 })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Garden Suite", level: 3 })).toBeVisible();
    expect(owner.createdDraftIds).toHaveLength(2);
    expect(new Set(owner.createdDraftIds).size).toBe(2);
    expect(owner.mediaTargets).toEqual(roomTypeIds);
    expect(owner.draftWrites).toBeGreaterThanOrEqual(4);
    expect(owner.events.indexOf("draft")).toBeLessThan(owner.events.indexOf("facts:create"));
    expect(owner.events).toContain("units:reconcile");
    expect(owner.events.filter((event) => event === "units:label")).toHaveLength(5);
    expect(owner.events).toContain("media:assign");
    expect(owner.events).toContain("amenities:confirm-empty");
    expect(owner.events.join(" ")).not.toMatch(/pricing|calendar|retired-room-route/);
    expect(routeState.reads).toBe(1);
    await assertHealthy();
  });

  for (const lostResponse of [false, true]) {
    test(`refreshes imported rooms while preserving local input (mock APIs, lost response: ${lostResponse})`, async ({
      page,
      baseURL,
    }, testInfo) => {
      await primeBrowserState(page);
      await mockAuthSession(page);
      await mockRoute(page, () => routeWithRoomsDraft(emptyRoomsDraft()));
      const owner = await mockRoomOwnerApis(page);
      let saved = false;
      const prepared = {
        contractVersion: "prepared-hotel-import.v1",
        property: {},
        rooms: [
          {
            id: "garden",
            name: "Imported Suite",
            description: "",
            maxGuests: 2,
            maxAdults: 2,
            maxChildren: 0,
            bedType: "queen",
            bedQuantity: 1,
            bathroomType: "private",
            sizeSquareMetres: null,
          },
        ],
      };
      await page.route(
        /\/api\/hotel-setup\/(?:imports\/prepared|properties\/[^/]+\/import)(?:\?|$)/,
        async (route) => {
          if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
          const item = { itemId: "room:garden", status: "applied", resourceId: roomTypeIds[0] };
          if (route.request().method() === "POST") {
            owner.insertImportedRoom();
            saved = true;
            if (lostResponse) return route.abort("failed");
            return route.fulfill({ headers: corsHeaders(route), json: { items: [item] } });
          }
          return route.fulfill({
            headers: corsHeaders(route),
            json: {
              import: {
                sourceId: "synthetic-source",
                propertyId,
                data: prepared,
                results: saved ? { "room:garden": item } : {},
              },
              profile: { propertyId, profileRevision: 1, profile: { displayName: "Test Hotel" } },
              canImportRooms: true,
              canImportProperty: false,
              existingRooms: saved ? [{ id: roomTypeIds[0], name: "Imported Suite" }] : [],
            },
          });
        },
      );
      await page.goto(setupUrl(baseURL));
      await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
      await page.getByLabel("Room type name").fill("Unfinished local room");
      const panel = page.getByRole("region", { name: "Prepared hotel data" });
      await panel.getByRole("button", { name: "Review prepared hotel data" }).click();
      await panel.getByRole("checkbox", { name: "Imported Suite", exact: true }).check();
      await panel.getByRole("button", { name: "Save selected items" }).click();
      if (lostResponse) {
        await expect(panel.getByRole("alert")).toContainText("Import could not finish");
        await panel.getByRole("button", { name: "Refresh", exact: true }).click();
      }
      await expect(
        page.getByRole("heading", { name: "Imported Suite", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Room type name")).toHaveValue("Unfinished local room");
      expect(owner.createdDraftIds).toHaveLength(0);
      expect(owner.draftWrites).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("import-refresh.png"), fullPage: true });
    });
  }

  test("retains first-visit values and exits with the exact current manifest", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const initialRoute = routeWithRoomsDraft(null);
    const routeState = await mockRoute(page, () => initialRoute);
    const destination = await mockBookingDashboardExit(page, baseURL, propertyId);
    const owner = await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    const name = page.getByLabel("Room type name");
    await expect(name).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    await name.fill("Locally retained room");
    await expect(
      page.getByRole("heading", { name: "Setup data is still unavailable" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add or arrange photos" })).toBeDisabled();
    await expect(
      page.getByText("Complete the required room details before uploading."),
    ).toBeVisible();

    expect(owner.draftWrites).toBe(0);
    expect(owner.createdDraftIds).toEqual([]);
    expect(owner.mediaTargets).toEqual([]);

    const assertHealthy = watchPageHealth(page, testInfo);
    await expect(name).toHaveValue("Locally retained room");
    await assertHealthy();
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();

    await expect(page).toHaveURL(destination);
    expect(owner.draftWrites).toBe(1);
    expect(owner.lastDraftPayload?.["room.name"]).toEqual(
      expect.objectContaining({ [owner.lastDraftRoomId!]: "Locally retained room" }),
    );
    expect(routeState.reads).toBe(1);
    expect(owner.lastDraftRequest).toMatchObject({
      expectedBaseRevisions: initialRoute.steps.find((step) => step.stepId === "rooms")!
        .currentBaseRevisions,
      expectedDraftRevision: 0,
      expectedTrackRevision: 3,
      expectedSessionRevision: 7,
    });
  });

  test("keeps the mobile dialogs keyboard-contained and returns focus without overflow", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockRoute(page, () => routeWithRoomsDraft(emptyRoomsDraft()));
    await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    const allAmenities = page.getByRole("button", { name: /View all amenities/ });
    await expect(allAmenities).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    const assertHealthy = watchPageHealth(page, testInfo);
    await allAmenities.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "All room amenities" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("checkbox", { name: "Laptop-friendly workspace" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(allAmenities).toBeFocused();

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    await assertHealthy();
  });
});

async function fillCoreRoom(page: Page, name: string, unitCount: string, maxGuests: string) {
  await page.getByLabel("Room type name").fill(name);
  await page.getByLabel("Number of rooms of this type").fill(unitCount);
  await page.getByLabel("Maximum guests").fill(maxGuests);
  await page.getByRole("radio", { name: "Private bathroom" }).check();
  await page.getByLabel("Bed type").selectOption("king");
}

async function uploadPhoto(page: Page, filename: string) {
  const open = page.getByRole("button", { name: "Add or arrange photos" });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Room photos" });
  await dialog.getByLabel("Upload photos").setInputFiles({
    name: filename,
    mimeType: "image/jpeg",
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(dialog.getByLabel("Room photo 1")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
}

async function primeBrowserState(page: Page) {
  await mockHotelSetupPrerequisites(
    page,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "booking",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Test hotel group",
      propertyId,
      selectedTracks: ["hotel_operations"],
    }),
  );
  await page.addInitScript(
    ({ selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
    },
    { selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        organizationKind: "hotel_group",
        user: {
          id: "user-room-owner",
          email: "owner@example.com",
          name: "Room Owner",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          status: "active",
        },
      },
    });
  });
}

async function mockRoute(page: Page, current: () => PropertySetupRouteReadModel) {
  let reads = 0;
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/route(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      reads += 1;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: current() });
    },
  );
  return {
    get reads() {
      return reads;
    },
  };
}

function routeWithRoomsDraft(
  draft: Extract<PropertySetupStepDraft, { stepId: "rooms" }> | null,
): PropertySetupRouteReadModel {
  const route = createPropertySetupRouteMock({
    propertyId,
    selectedTracks: ["hotel_operations"],
    resumeStepId: "rooms",
  });
  return {
    ...route,
    steps: route.steps.map((step) =>
      step.stepId === "rooms" ? { ...step, state: draft ? "draft" : "not_started", draft } : step,
    ),
  };
}

function emptyRoomsDraft(): Extract<PropertySetupStepDraft, { stepId: "rooms" }> {
  return {
    stepId: "rooms",
    payload: {},
    dirtyFields: [],
    baseRevisions: {
      "pms.room_types": "types:1",
      "pms.room_units": "units:1",
      "pms.room_media": "media:1",
    },
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-01T00:00:00.000Z",
    revision: 4,
    updatedAt: now,
  };
}

function setupUrl(baseURL: string | undefined) {
  const query = new URLSearchParams({
    entryProduct: "booking",
    returnProduct: "booking",
    returnTo: "/dashboard",
    propertyId,
    step: "rooms",
  });
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3003") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}
