import { expect, test, type Page } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2132: Delete on a room type does the cleanup in one step, or says what still stops it.
const roomTypeId = "33333333-3333-4333-8333-333333333333";
const name = "TEST ONLY calendar check (delete me)";
const impact = {
  contractVersion: "pms-room-type-lifecycle.v1",
  propertyId: PMS_WEB_PROPERTY_ID,
  roomTypeId,
  version: "room-type-facts-v3",
  canRetire: true,
  blockers: [] as Record<string, unknown>[],
  cleanup: { physicalUnits: 1, futureNights: 363, roomBlocks: 0, linkedGroups: 0 },
};
const main = (page: Page) => page.locator("main");

async function mockRoom(page: Page, preview: typeof impact) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const deletes: Record<string, unknown>[] = [];
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`,
    (route) => {
      if (route.request().method() !== "DELETE")
        return route.fulfill({
          json: {
            propertyId: PMS_WEB_PROPERTY_ID,
            item: { ...pmsWebRoomType, roomTypeId, name, version: "room-type-facts-v3" },
          },
        });
      deletes.push(route.request().postDataJSON());
      return route.fulfill({
        json: { ...preview, canRetire: false, version: "room-type-facts-v4", commandMeta: {} },
      });
    },
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}/retirement-impact`,
    (route) => route.fulfill({ json: preview }),
  );
  return deletes;
}

test("deletes a test room type with its rooms, future nights and calendar place in one step", async ({
  page,
}) => {
  const deletes = await mockRoom(page, impact);
  await page.goto(`/rooms/${roomTypeId}`);
  await main(page).getByRole("button", { name: "Delete", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Delete Room Type" });
  await expect(dialog).toContainText(
    `Delete “${name}”? This retires its rooms (1), closes its future nights (363) and removes it from the calendar. Past bookings stay in your records. This can't be undone.`,
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  expect(deletes).toEqual([expect.objectContaining({ expectedVersion: "room-type-facts-v3" })]);
});

test("says what still stops the Delete, without a confirmation", async ({ page }) => {
  const deletes = await mockRoom(page, {
    ...impact,
    canRetire: false,
    blockers: [
      { category: "reservations", code: "active_reservations", affectedCount: 2, action: "" },
      { category: "inventory", code: "last_room_type", affectedCount: 1, action: "" },
    ],
  });
  await page.goto(`/rooms/${roomTypeId}`);
  await main(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    main(page).getByText(
      "This room type can't be deleted yet. It has bookings or holds (2): cancel, check out or move them first. It is your only room type: add another room type first.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(deletes).toEqual([]);
});

test("points the last room of a room type to Delete on the room type", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const unitTypeId = "f1000000-0000-4000-8000-000000000002";
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [{ ...pmsWebRoomType, roomTypeId: unitTypeId }],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        sourceFreshness: {},
        items: [
          {
            roomId: "f1000000-0000-4000-8000-000000000001",
            roomTypeId: unitTypeId,
            roomNumber: "101",
            floor: "1",
            status: "available",
            sortOrder: 1,
            metadata: { roomUnitsRevision: 1 },
          },
        ],
      },
    }),
  );
  await page.route(
    `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${unitTypeId}/capacity`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: unitTypeId,
          roomUnitsRevision: 1,
          activeUnitCount: 1,
          capturedAt: new Date().toISOString(),
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${unitTypeId}/physical-units**`,
    (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 409,
            json: {
              code: "physical_room_protected",
              message:
                "The active operating calendar requires at least one physical room for this room type.",
              blockers: ["operating_calendar"],
            },
          })
        : route.fallback(),
  );
  await page.goto("/rooms");
  await page.getByText("Alpine Suite", { exact: true }).first().click();
  await page.getByRole("button", { name: /delete room/i }).click();
  await page
    .getByRole("button", { name: /delete room/i })
    .last()
    .click();
  await expect(page.locator('p[role="alert"]')).toHaveText(
    "This is the last room of this room type. To remove it, delete the room type.",
  );
});
