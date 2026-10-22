import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_TYPE_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

test("first pricing setup takes the ways to pay from Payment settings and lets staff change them (VAY-2188)", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ status: 404, json: { code: "not_found" } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${PMS_WEB_ROOM_TYPE_ID}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: pmsWebRoomType,
          sourceFreshness: {},
        },
      }),
  );

  await page.goto(`/rooms/${PMS_WEB_ROOM_TYPE_ID}?tab=prices`);
  // VAY-2188: the first price is the simple card; how guests pay is under More options, from Payment settings
  // (the shared mock: at the property only).
  // The first price is still the first-price card (VAY-2280 restyles it later).
  await expect(page.getByRole("heading", { name: "Price per night", exact: true })).toBeVisible();
  await expect(page.getByText("Guests pay at the hotel", { exact: false })).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^More options/ })
    .click();
  const card = page.getByRole("checkbox", { name: "Card online" });
  const atProperty = page.getByRole("checkbox", { name: "Pay at property" });
  await expect(atProperty).toBeChecked();
  await expect(card).not.toBeChecked();
  await card.check();
  await expect(card).toBeChecked();
  await expect(atProperty).toBeChecked();
});

test("first pricing setup asks how guests pay when Payment settings can't be read (VAY-2188)", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/payment-settings`, (route) =>
    route.fulfill({ status: 403, json: { message: "Forbidden" } }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ status: 404, json: { code: "not_found" } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${PMS_WEB_ROOM_TYPE_ID}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: pmsWebRoomType,
          sourceFreshness: {},
        },
      }),
  );
  await page.goto(`/rooms/${PMS_WEB_ROOM_TYPE_ID}?tab=prices`);
  // More options opens at once on How guests pay and says why.
  await expect(
    page.getByText("Your Payment settings couldn't be read, so choose how guests pay."),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Pay at property" })).not.toBeChecked();
  await page.getByLabel("Room price per night").fill("120");
  await page.getByRole("button", { name: "Save and publish" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "How guests pay" })).toBeVisible();
});

test("first pricing setup offers bank transfer once the hotel can use it, and takes it by default (VAY-2139, VAY-2188)", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route("**/api/identity/staff/self-access", (route) =>
    route.fulfill({
      json: {
        membershipId: "test-owner",
        roleKey: "hotel_owner",
        permissions: ["pms.operations.read", "pms.operations.manage"],
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2`, (route) =>
    route.fulfill({ status: 404, json: { code: "not_found" } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-v2/payment-methods`,
    (route) =>
      route.fulfill({ json: { acceptanceEnabled: true, readyMethods: ["bank_transfer"] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${PMS_WEB_ROOM_TYPE_ID}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: pmsWebRoomType,
          sourceFreshness: {},
        },
      }),
  );

  await page.goto(`/rooms/${PMS_WEB_ROOM_TYPE_ID}?tab=prices`);
  // The first price is still the first-price card (VAY-2280 restyles it later).
  await expect(page.getByRole("heading", { name: "Price per night", exact: true })).toBeVisible();
  // Ready bank transfer is one of the hotel's ways to pay, like in setup's pricing step.
  await expect(
    page.getByText("Guests pay at the hotel or by bank transfer", { exact: false }),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: /^More options/ })
    .click();
  const bank = page.getByRole("checkbox", { name: "Bank transfer" });
  await expect(bank).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "PayPal" })).toHaveCount(0);
  await bank.uncheck();
  await expect(bank).not.toBeChecked();
});
