import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("marketplace-web smoke", () => {
  test("login page renders the marketplace sign-in shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });
});
