import { expect, test, type Page } from "@playwright/test";

import { watchPageHealth } from "../support/pageHealth";

// VAY-2246: a new hotel accepts the hotel terms and the data processing agreement with a required tickbox
// between the password and "Create account"; it gates "Continue with Google" too (Paper: VAY-2246, row 2).
const BOX = /I accept the Terms and the Data Processing Agreement for my hotel/;
const ERROR = "Tick the box to accept the Terms and the Data Processing Agreement first.";
const accepted = { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" };

async function fillForm(page: Page) {
  await page.goto("/signup");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
}

test("Create account needs the tick and then sends the accepted versions", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const bodies: unknown[] = [];
  await page.route("**/auth/password/signup", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 409,
      json: {
        state: "account_exists",
        message: "This email already has a vayada account. Sign in instead.",
      },
    });
  });
  await fillForm(page);

  const box = page.getByRole("checkbox", { name: BOX });
  await expect(box).not.toBeChecked();
  for (const [name, href] of [
    ["Terms", /\/terms$/],
    ["Data Processing Agreement", /\/terms\/dpa$/],
    ["Privacy Policy", /\/privacy$/],
  ] as const) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
  }
  // The old footer line is gone: the tickbox replaces it.
  await expect(page.getByText("By continuing, you agree to our")).toHaveCount(0);

  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: ERROR })).toBeVisible();
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  expect(bodies).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("signup-without-tick-1440.png") });

  await box.check();
  await expect(page.getByRole("alert").filter({ hasText: ERROR })).toHaveCount(0);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({
    email: "owner@example.test",
    surface: "booking-admin",
    type: "hotel",
    acceptedAgreements: accepted,
  });
  await assertHealthy();
});

test("Continue with Google needs the tick and carries the accepted versions", async ({ page }) => {
  const starts: URL[] = [];
  await page.route("**/auth/oauth/google/start**", (route) => {
    starts.push(new URL(route.request().url()));
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><body>Google</body>" });
  });
  await page.goto("/signup");

  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("alert").filter({ hasText: ERROR })).toBeVisible();
  await expect(page).toHaveURL(/\/signup$/);
  expect(starts).toEqual([]);

  await page.getByRole("checkbox", { name: BOX }).check();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]!.searchParams.get("flow")).toBe("signup");
  expect(starts[0]!.searchParams.get("accepted_terms")).toBe(accepted.termsVersion);
  expect(starts[0]!.searchParams.get("accepted_dpa")).toBe(accepted.dpaVersion);
});

test("on a phone the error shows at the box", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fillForm(page);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const error = page.getByRole("alert").filter({ hasText: ERROR });
  await expect(error).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("signup-without-tick-390.png") });
});
