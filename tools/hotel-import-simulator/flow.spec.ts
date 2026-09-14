import { test, expect, type Page } from "@playwright/test";
async function connect(page: Page, scenario = "normal") {
  await page.goto("/");
  await page.getByLabel("Test scenario").selectOption(scenario);
  await page.getByRole("button", { name: "Connect Airbnb (simulated)", exact: true }).click();
  await page.getByRole("button", { name: "Simulate approval" }).click();
}
async function review(page: Page, both = false) {
  await page.getByLabel("Demo Garden Suite").check();
  if (both) await page.getByLabel("Demo Loft").check();
  await page.getByRole("button", { name: "Review selected listings" }).click();
  await page.getByRole("button", { name: "Review prepared room data" }).click();
}
test("cancel, connection error, and empty account leave no rooms", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect Airbnb (simulated)", exact: true }).click();
  await page.getByRole("button", { name: "Cancel connection" }).click();
  await connect(page, "connection-error");
  await expect(page.getByRole("alert")).toContainText("Connection failed");
  await connect(page, "empty");
  await expect(page.getByText("No listings found.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Saved locally: 0 rooms" })).toBeVisible();
});
test("edits selected data, saves once and preserves results after reload", async ({ page }, testInfo) => {
  await connect(page);
  await review(page);
  await expect(page.getByRole("button", { name: "Save selected items" })).toBeDisabled();
  await page.getByLabel("Room name", { exact: true }).fill("Edited Suite");
  await page.screenshot({ path: testInfo.outputPath("review.png"), fullPage: true });
  await page.getByRole("checkbox", { name: "Edited Suite", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("heading", { name: "Saved locally: 1 rooms" })).toBeVisible();
  await connect(page);
  await page.getByLabel("Demo Garden Suite").check();
  await page.getByRole("button", { name: "Review selected listings" }).click();
  await expect(page.getByRole("status")).toContainText("already saved locally");
  await expect(page.getByText("Edited Suite · 2 guests")).toBeVisible();
});
test("missing values stay blank and partial failure retries only unsaved items", async ({
  page,
}) => {
  await connect(page, "partial-failure");
  await review(page, true);
  await expect(page.getByLabel("Maximum guests", { exact: true }).nth(1)).toHaveValue("");
  await expect(page.getByLabel("Size (m²)").nth(1)).toHaveValue("");
  await page.getByLabel("Maximum guests", { exact: true }).nth(1).fill("3");
  await page.getByLabel("Maximum adults", { exact: true }).nth(1).fill("3");
  await page.getByLabel("Maximum children", { exact: true }).nth(1).fill("0");
  await page.getByRole("combobox", { name: /^Bathroom/ }).nth(1).selectOption("private");
  await page.getByRole("checkbox", { name: "Demo Garden Suite", exact: true }).check();
  await page.getByRole("checkbox", { name: "Demo Loft", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("heading", { name: "Saved locally: 1 rooms" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Some items could not be saved");
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("heading", { name: "Saved locally: 2 rooms" })).toBeVisible();
});
test("lost response can be refreshed without duplicating the saved room", async ({ page }) => {
  await connect(page, "lost-response");
  await review(page);
  await page.getByRole("checkbox", { name: "Demo Garden Suite", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("alert")).toContainText("Import could not finish");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved locally: 1 rooms" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("already saved locally");
});
