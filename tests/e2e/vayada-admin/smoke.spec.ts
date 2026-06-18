import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("vayada-admin smoke", () => {
  test("login page redirects to AuthKit", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /vayada admin/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/redirecting to sign in/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue with workos/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /use legacy password fallback/i })).toHaveCount(0);

    await assertHealthy();
  });
});
