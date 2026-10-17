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

const NO_HOTEL_MESSAGE = "No active hotel_group organization is available for this surface";

// Booking Admin hosts hotel setup itself (VAY-2261): the login page explains the missing
// workspace and no longer links to the Marketplace login (plan G8).
test("password login without a hotel workspace explains it without a Marketplace link", async ({
  page,
}) => {
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
  await expect(page.getByRole("link", { name: "Set up your hotel" })).toHaveCount(0);
});

test("Google login without a hotel workspace explains it without a Marketplace link", async ({
  page,
}) => {
  await page.goto(
    `/login?auth_error=${encodeURIComponent(NO_HOTEL_MESSAGE)}&auth_error_code=hotel_workspace_required`,
  );
  await expect(page.getByText(/isn't connected to a hotel yet/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up your hotel" })).toHaveCount(0);
});

// A PMS hotel sent to Booking Admin's setup without a session arrives at
// /login?returnTo=/setup?… (VAY-2261). After login the setup URL is honoured as is: the booking
// guard must not rewrite it, or mode=add / returnProduct=pms would be lost.
test("password login returns to a /setup returnTo untouched", async ({ page }) => {
  const setupReturnTo = "/setup?entryProduct=pms&returnProduct=pms&mode=add";
  await page.route("**/auth/password/login", (route) =>
    route.fulfill({
      status: 200,
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId: "11111111-1111-4111-8111-111111111111",
        workosOrganizationId: "org_workos_hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@example.test",
          name: "Hotel Owner",
          phone: "+49 89 123456",
          status: "active",
        },
      },
    }),
  );
  const guardReads: string[] = [];
  await page.route(/\/api\/hotel-setup\//, (route) => {
    guardReads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, json: {} });
  });

  await page.goto(`/login?returnTo=${encodeURIComponent(setupReturnTo)}`);
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`${setupReturnTo.replace(/[?+]/g, "\\$&")}$`));
  // The login page itself asked the setup API for nothing; only the setup page reads it later.
  expect(guardReads.filter((path) => path.endsWith("/status") && page.url().includes("/login")))
    .toEqual([]);
});
