import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("affiliate-dashboard smoke", () => {
  test("login page renders the affiliate portal shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /vayada Affiliate Portal/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole("textbox", { name: /password/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });
});
