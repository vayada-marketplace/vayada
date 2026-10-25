import { expect, test, type Page, type Route } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

// VAY-2338: Rooms & Rates starts with the room types. What hosts set up once (Airbnb import, linked inventory,
// room order) sits in the ☰ menu; linked inventory opens in a drawer.
const types = [
  { ...pmsWebRoomType, roomTypeId: "room_type_alpine_suite", name: "Alpine Suite", sortOrder: 0 },
  {
    ...pmsWebRoomType,
    roomTypeId: "room_type_garden_villa",
    name: "Garden Villa",
    category: "villa",
    sortOrder: 1,
  },
  {
    ...pmsWebRoomType,
    roomTypeId: "room_type_lake_villa",
    name: "Lake Villa",
    category: "villa",
    sortOrder: 2,
  },
];
const rooms = types.flatMap((type, index) =>
  [1, 2].map((number) => ({
    roomId: `${type.roomTypeId}-${number}`,
    roomTypeId: type.roomTypeId,
    roomNumber: `${index + 1}0${number}`,
    floor: String(index + 1),
    status: "available",
    sortOrder: index * 2 + number,
    metadata: { roomTypeName: type.name },
  })),
);
const main = (page: Page) => page.locator("main");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

async function openRooms(page: Page) {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({ json: { items: types, propertyId: PMS_WEB_PROPERTY_ID } }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`, (route) =>
    route.fulfill({ json: { items: rooms, orderVersion: "v1", propertyId: PMS_WEB_PROPERTY_ID } }),
  );
  const groups: Record<string, unknown>[] = [];
  const respond = (route: Route, json: unknown) => route.fulfill({ json, headers: cors });
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/linked-inventory-groups**`,
    (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const group = {
          groupId: `group-${groups.length + 1}`,
          revision: 1,
          name: body.name,
          memberRoomTypeIds: body.memberRoomTypeIds,
        };
        groups.push(group);
        return respond(route, { group });
      }
      if (request.method() === "DELETE") {
        groups.splice(0, groups.length);
        return respond(route, {});
      }
      return respond(route, { propertyId: PMS_WEB_PROPERTY_ID, items: groups });
    },
  );
  await page.goto("/rooms");
  await expect(main(page).getByText("Lake Villa", { exact: true })).toBeVisible();
  return groups;
}

test.describe("Rooms & Rates list", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("starts with the room types, under a subtitle with the counts", async ({ page }) => {
    await openRooms(page);
    await expect(main(page).getByText("3 room types · 6 rooms", { exact: true })).toBeVisible();
    await expect(main(page).getByPlaceholder("Search room types...")).toHaveCount(0);
    await expect(main(page).getByText("Import rooms from Airbnb", { exact: false })).toHaveCount(0);
    await expect(main(page).getByRole("heading", { name: "Linked inventory" })).toHaveCount(0);
    // The first room type is on screen at 1440×900 without scrolling.
    const first = await main(page).getByText("Alpine Suite", { exact: true }).boundingBox();
    expect(first!.y + first!.height).toBeLessThan(900);
    await expect(main(page).getByText("2 rooms · 3 guests").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Configure Alpine Suite" })).toHaveAttribute(
      "href",
      "/rooms/room_type_alpine_suite",
    );
    // The arrow (or a click on the row) still opens a room type's rooms.
    await page.getByRole("button", { name: "Show the rooms of Garden Villa" }).click();
    await expect(main(page).getByText("#201", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide the rooms of Garden Villa" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("the ☰ menu closes on Escape and on a click outside", async ({ page }) => {
    await openRooms(page);
    const menuButton = page.getByRole("button", { name: "More actions" });
    await menuButton.click();
    await expect(page.getByRole("button", { name: "Linked inventory" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Reorder room types/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Linked inventory" })).toHaveCount(0);
    await expect(menuButton).toBeFocused();
    await menuButton.click();
    await main(page).getByRole("heading", { name: "Rooms & Rates" }).click();
    await expect(page.getByRole("button", { name: "Linked inventory" })).toHaveCount(0);
  });

  // No page-health watch: the Rooms list's import panel calls setup APIs this spec does not mock.
  test("linked inventory opens in a drawer where groups are added and deleted", async ({ page }) => {
    const groups = await openRooms(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("button", { name: "Linked inventory" }).click();
    const drawer = page.getByRole("dialog", { name: "Linked inventory" });
    await expect(drawer.getByText("No groups yet")).toBeVisible();
    await drawer.getByRole("button", { name: "Add group" }).click();
    await drawer.getByLabel("Group name").fill("Villas");
    await drawer.getByLabel("Garden Villa").check();
    await drawer.getByLabel("Lake Villa").check();
    await drawer.getByRole("button", { name: "Save group" }).click();
    await expect(drawer.getByText("Garden Villa · Lake Villa")).toBeVisible();
    expect(groups).toHaveLength(1);
    // The rows show the group; a room type already in a group says which one.
    await expect(main(page).getByText("Linked", { exact: true })).toHaveCount(2);
    await drawer.getByRole("button", { name: "Add group" }).click();
    await expect(drawer.getByText("In “Villas”")).toHaveCount(2);
    await drawer.getByRole("button", { name: "Cancel" }).click();

    await drawer.getByRole("button", { name: "Delete Villas" }).click();
    await page.getByRole("dialog", { name: "Delete Villas" }).getByRole("button", { name: "Delete" }).click();
    await expect(drawer.getByText("No groups yet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More actions" })).toBeFocused();
  });

  test("Reorder room types opens the calendar in reorder mode", async ({ page }) => {
    await openRooms(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("link", { name: /Reorder room types/ }).click();
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe("/calendar");
    await expect(page.getByText("Reordering rooms", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save order" })).toBeVisible();
  });
});

test.describe("Rooms & Rates list on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacks the rows without sideways scrolling and leaves room order to wider screens", async ({
    page,
  }) => {
    await openRooms(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await expect(main(page).getByText("Room type", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("button", { name: "Linked inventory" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Reorder room types/ })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Linked inventory" }).click();
    const drawer = page.getByRole("dialog", { name: "Linked inventory" });
    expect((await drawer.boundingBox())!.width).toBe(390);
  });
});
