import { expect, test } from "@playwright/test";

test("password login lets a hotel user choose a workspace", async ({ page }) => {
  let submissions = 0;
  await page.route("**/auth/password/login", async (route) => {
    const body = route.request().postDataJSON();
    submissions++;
    if (submissions === 1) {
      await route.fulfill({
        status: 403,
        json: {
          state: "organization_selection_required",
          message: "Choose workspace",
          organizations: [{ id: "org_one" }, { id: "org_two", name: "   " }],
        },
      });
      return;
    }

    expect(body).toMatchObject({
      organizationId: "org_two",
      email: "owner@example.test",
      password: "test-password",
    });
    await route.fulfill({
      status: 401,
      json: { state: "invalid_credentials", message: "Please sign in again." },
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose hotel group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hotel group 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hotel group 2", exact: true }).click();
  await expect(page.getByText("Please sign in again.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use another account" }).click();
  await expect(page.getByLabel("Email address", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  expect(submissions).toBe(2);
});
