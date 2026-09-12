import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
test("reviews prepared room facts and applies only checked rooms", async ({ page, baseURL }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const room = {
    id: "prepared-room",
    name: "Prepared Garden Suite",
    description: "Garden view",
    maxGuests: 2,
    maxAdults: 2,
    maxChildren: 0,
    bedType: "queen",
    bedQuantity: 1,
    bathroomType: "private",
    sizeSquareMetres: 28,
  };
  let saved = false;
  let writes = 0;
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/import`, async (route) => {
    const headers = {
      "access-control-allow-origin": baseURL!,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization,content-type",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.data.property).toEqual({});
      expect(body.data.rooms).toEqual([room]);
      writes++;
      saved = true;
      await route.fulfill({
        headers,
        json: {
          items: [{ itemId: "room:prepared-room", status: "applied", resourceId: "created-room" }],
        },
      });
      return;
    }
    await route.fulfill({
      headers,
      json: {
        import: {
          sourceId: "invite",
          propertyId: null,
          data: {
            contractVersion: "prepared-hotel-import.v1",
            property: { displayName: "Prepared Hotel" },
            rooms: [room],
          },
          results: saved
            ? {
                "room:prepared-room": {
                  itemId: "room:prepared-room",
                  status: "applied",
                  resourceId: "created-room",
                },
              }
            : {},
        },
        profile: {
          propertyId: PMS_WEB_PROPERTY_ID,
          profileRevision: 1,
          profile: {
            displayName: "Current Hotel",
            propertyType: "hotel",
            location: { city: "Berlin" },
            contacts: [],
          },
        },
        canImportProperty: true,
        canImportRooms: true,
        existingRooms: [],
      },
    });
  });
  await page.goto("/rooms");
  await page.getByRole("button", { name: "Review prepared room data" }).click();
  await expect(page.getByRole("button", { name: "Save selected items" })).toBeDisabled();
  expect(writes).toBe(0);
  await expect(page.getByText("Current Hotel", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Prepared Garden Suite", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByText("Prepared Garden Suite: Saved", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await expect(page.getByText("Already imported. Your saved edits are preserved.")).toBeVisible();
});
