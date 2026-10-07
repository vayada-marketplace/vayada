import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

test("first pricing setup starts without a payment method and lets staff select one", async ({
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

  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Create your first room price" })).toBeVisible();
  const card = page.getByRole("checkbox", { name: "Card online" });
  const atProperty = page.getByRole("checkbox", { name: "Pay at property" });
  await expect(card).not.toBeChecked();
  await expect(atProperty).not.toBeChecked();
  await atProperty.check();
  await expect(atProperty).toBeChecked();
  await expect(card).not.toBeChecked();
});
