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

// VAY-2604: WorkOS slow or down, or the sign-in gateway giving up, gets a clear "try again".
for (const [name, status, json] of [
  ["WorkOS is slow", 503, { state: "auth_unavailable", message: "SERVER TEXT THAT IS NOT SHOWN" }],
  ["the sign-in gateway times out", 504, { error: "auth_gateway_upstream_timeout" }],
] as const) {
  test(`password login says to try again when ${name}`, async ({ page }) => {
    await page.route("**/auth/password/login", (route) => route.fulfill({ status, json }));

    await page.goto("/login");
    await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(
      page.getByText("Signing in is taking longer than usual. Please try again in a moment."),
    ).toBeVisible();
    await expect(page.getByText("SERVER TEXT THAT IS NOT SHOWN")).toHaveCount(0);
  });
}

const NO_HOTEL_MESSAGE = "No active hotel_group organization is available for this surface";

test("password login without a hotel workspace offers hotel setup", async ({ page }) => {
  await page.route("**/auth/password/login", (route) =>
    route.fulfill({
      status: 403,
      json: {
        error: "auth_session_rejected",
        state: "hotel_workspace_required",
        message: NO_HOTEL_MESSAGE,
      },
    }),
  );

  await page.goto("/login");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  await expect(page.getByText(/isn't connected to a hotel yet/)).toBeVisible();
  await expect(page.getByText(NO_HOTEL_MESSAGE)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Set up your hotel" })).toHaveAttribute(
    "href",
    /^https?:\/\/[^/]+\/login$/,
  );
});

test("Google login without a hotel workspace offers hotel setup", async ({ page }) => {
  await page.goto(
    `/login?auth_error=${encodeURIComponent(NO_HOTEL_MESSAGE)}&auth_error_code=hotel_workspace_required`,
  );
  await expect(page.getByText(/isn't connected to a hotel yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up your hotel" })).toBeVisible();
});
