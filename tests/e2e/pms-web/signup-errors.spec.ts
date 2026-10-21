import { expect, test } from "@playwright/test";

// An email that already has an account offers to sign in instead (VAY-2250).
test("an email that already has an account says so and offers to sign in", async ({
  page,
}, testInfo) => {
  await page.route("**/auth/password/signup", (route) =>
    route.fulfill({
      status: 409,
      json: {
        state: "account_exists",
        message: "This email already has a vayada account. Sign in instead.",
      },
    }),
  );
  await page.goto("/signup");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: /create account/i }).click();

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "An account with this email already exists." });
  await expect(alert).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-signup-email-exists.png") });

  await alert.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("a Google sign-up for an existing account offers to sign in", async ({ page }) => {
  await page.goto(
    `/signup?auth_error=${encodeURIComponent("This email already has a vayada account. Sign in instead.")}&auth_error_code=account_exists`,
  );
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "An account with this email already exists." });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});
