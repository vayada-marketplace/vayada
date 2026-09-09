import { expect, test } from "@playwright/test";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

test("reviews example details before opening the editable room form", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.NEXT_PUBLIC_ROOM_IMPORT_PREVIEW_ENABLED !== "true",
    "Local example preview is opt-in",
  );
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/room-types"))
      writes.push(request.url());
  });
  await page.goto("/rooms/new");
  await page.getByRole("button", { name: "Review example" }).click();
  await page.getByRole("button", { name: "Cancel preview" }).click();
  await page.getByRole("button", { name: "Review example" }).click();
  const apply = page.getByRole("button", { name: "Use selected details" });
  await expect(apply).toBeDisabled();
  await page.getByLabel("Room name", { exact: true }).fill("Reviewed Garden Suite");
  await page.getByLabel("Copy description", { exact: true }).uncheck();
  await page.getByLabel("I reviewed the selected values").check();
  await page.screenshot({ path: testInfo.outputPath("review.png") });
  await apply.click();
  await expect(page.getByRole("region", { name: "Review room import" })).toHaveCount(0);
  await expect(page.locator('input[value="Reviewed Garden Suite"]')).toBeVisible();
  await expect(page.locator("textarea").first()).toHaveValue("");
  await expect(
    page
      .locator("div")
      .filter({ has: page.locator("label", { hasText: "Total Max Occupancy" }) })
      .filter({ has: page.locator("input") })
      .last()
      .locator("input"),
  ).toHaveValue("3");
  await page.locator('input[value="Reviewed Garden Suite"]').fill("My edited suite");
  await expect(page.locator('input[value="My edited suite"]')).toBeVisible();
  expect(writes).toEqual([]);
});

test("manual start opens the original empty room form", async ({ page }) => {
  test.skip(
    process.env.NEXT_PUBLIC_ROOM_IMPORT_PREVIEW_ENABLED !== "true",
    "Local example preview is opt-in",
  );
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.goto("/rooms/new");
  await page.getByRole("button", { name: "Start manually" }).click();
  await expect(page.getByRole("button", { name: "Create Room Type" })).toBeVisible();
  await expect(page.locator('input[value="Example Garden Suite"]')).toHaveCount(0);
});

test("onboarding room creation skips the experiment", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.goto("/rooms/new?onboarding=pms-activation");
  await expect(page.locator("form").filter({ hasText: "Room Type Basics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review example" })).toHaveCount(0);
});
