import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin smoke", () => {
  test("login page renders the AuthKit booking engine admin shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /booking engine/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with workos/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /use legacy password fallback/i })).toHaveCount(0);

    await assertHealthy();
  });
});
