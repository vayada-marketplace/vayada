import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin smoke", () => {
  test("login page renders the booking engine admin shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /booking engine/i, level: 1 })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });
});
