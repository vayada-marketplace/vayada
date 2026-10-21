import { expect, test, type Page } from "@playwright/test";

// The sign-up form says why it failed instead of "An unexpected error occurred" (VAY-2250).
async function submitSignup(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: /create account/i }).click();
}

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
  await submitSignup(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "This email already has a vayada account." });
  await expect(alert).toBeVisible();
  await expect(page.getByText("An unexpected error occurred")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("signup-email-exists.png") });

  await alert.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("a weak password is explained", async ({ page }) => {
  await page.route("**/auth/password/signup", (route) =>
    route.fulfill({
      status: 400,
      json: {
        state: "auth_failed",
        message:
          "This password isn't strong enough. Try several unrelated words or generate a unique password with a password manager.",
      },
    }),
  );
  await submitSignup(page);
  await expect(page.getByText(/This password isn't strong enough/)).toBeVisible();
});

test("other rejected sign-ups ask to check the details, server errors stay generic", async ({
  page,
}) => {
  let status = 400;
  await page.route("**/auth/password/signup", (route) =>
    route.fulfill({
      status,
      json: {
        state: "auth_failed",
        message: "Signup failed. Please check your details and try again.",
      },
    }),
  );
  await submitSignup(page);
  await expect(
    page.getByText("Sign-up failed. Please check your details and try again."),
  ).toBeVisible();

  status = 500;
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page.getByText("An unexpected error occurred. Please try again.")).toBeVisible();
});

test("a Google sign-up for an existing account explains it", async ({ page }) => {
  await page.goto(
    `/signup?auth_error=${encodeURIComponent("This email already has a vayada account. Sign in instead.")}&auth_error_code=account_exists`,
  );
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "This email already has a vayada account." });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
});
