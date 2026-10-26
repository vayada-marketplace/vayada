import { expect, test, type Page } from "@playwright/test";

// VAY-2274: the team invitation page. The API is mocked; the routes and their WorkOS side are
// covered by apps/api staffInvitationJoinRoutes.test.ts.

const preview = {
  state: "invitation_ready",
  email: "maria.huber@example.com",
  accountExists: false,
  hotelNames: ["Hotel Alpenrose"],
  inviterName: "Anna Keller",
  inviteeName: null,
  roleKey: "front_desk",
  roleName: "Reservation manager",
};

const joinedSession = {
  accessToken: "invitee-token",
  csrfToken: "csrf-token",
  organizationId: "org_hotel_group",
  user: { id: "user_maria", email: "maria.huber@example.com", status: "active" },
};

async function stubDashboard(page: Page) {
  await page.route(
    (url) => url.pathname === "/dashboard",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Dashboard</h1>" }),
  );
}

test("a new address creates an account and joins the hotel", async ({ page }) => {
  const previewBodies: unknown[] = [];
  const acceptBodies: unknown[] = [];
  await page.route("**/auth/invitations/preview", async (route) => {
    previewBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: preview });
  });
  await page.route("**/auth/invitations/accept", async (route) => {
    acceptBodies.push(route.request().postDataJSON());
    await route.fulfill({ json: joinedSession });
  });
  await stubDashboard(page);

  await page.goto("/invite?invitation_token=tok_new_123");

  await expect(page.getByRole("heading", { name: "Join Hotel Alpenrose" })).toBeVisible();
  await expect(
    page.getByText("Anna Keller invited you to join Hotel Alpenrose as Reservation manager."),
  ).toBeVisible();
  // The one-time token leaves the address bar and is sent in the body only.
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect(previewBodies).toEqual([{ invitationToken: "tok_new_123", surface: "pms-web" }]);
  await expect(page.getByLabel("Email address")).toHaveValue("maria.huber@example.com");
  await expect(page.getByLabel("Email address")).toHaveAttribute("readonly", "");
  await expect(page.getByText("You already have a vayada account")).toHaveCount(0);

  await page.getByLabel("Full name").fill("Maria Huber");
  await page.getByLabel("Password", { exact: true }).fill("long enough password");
  await page.getByLabel("Confirm password").fill("long enough passwort");
  await page.getByRole("button", { name: "Create account and join" }).click();
  await expect(page.getByText("The passwords don't match.")).toBeVisible();
  expect(acceptBodies).toEqual([]);

  await page.getByLabel("Confirm password").fill("long enough password");
  await page.getByRole("button", { name: "Create account and join" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(acceptBodies).toEqual([
    {
      invitationToken: "tok_new_123",
      password: "long enough password",
      name: "Maria Huber",
      surface: "pms-web",
    },
  ]);
});

test("an existing account logs in to accept, and a wrong password keeps the form", async ({
  page,
}) => {
  const acceptBodies: Record<string, unknown>[] = [];
  await page.route("**/auth/invitations/preview", (route) =>
    route.fulfill({ json: { ...preview, accountExists: true } }),
  );
  await page.route("**/auth/invitations/accept", async (route) => {
    acceptBodies.push(route.request().postDataJSON());
    await route.fulfill(
      acceptBodies.length === 1
        ? {
            status: 401,
            json: { state: "invalid_credentials", message: "Email or password is incorrect." },
          }
        : { json: joinedSession },
    );
  });
  await stubDashboard(page);

  await page.goto("/invite?invitation_token=tok_existing");

  await expect(
    page.getByText("You already have a vayada account. Log in to accept this invitation."),
  ).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
    "href",
    "/forgot-password",
  );

  await page.getByLabel("Password", { exact: true }).fill("wrong password");
  await page.getByRole("button", { name: "Log in and join" }).click();
  await expect(page.getByText("That password is not right. Try again or reset it.")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill("right password");
  await page.getByRole("button", { name: "Log in and join" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(acceptBodies.map((body) => body.password)).toEqual(["wrong password", "right password"]);
  expect(acceptBodies.every((body) => !("name" in body))).toBe(true);
});

test("an expired or replaced link explains itself and offers login", async ({ page }) => {
  await page.route("**/auth/invitations/preview", (route) =>
    route.fulfill({
      status: 410,
      json: {
        state: "invitation_unavailable",
        reason: "replaced",
        message: "This invitation link no longer works.",
      },
    }),
  );

  await page.goto("/invite?invitation_token=tok_old");

  await expect(
    page.getByRole("heading", { name: "This invitation link no longer works" }),
  ).toBeVisible();
  await expect(page.getByText("It has expired, or a newer invitation replaced it.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to login" })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("a link without a token never calls the API", async ({ page }) => {
  let calls = 0;
  await page.route("**/auth/invitations/**", (route) => {
    calls++;
    return route.abort();
  });

  await page.goto("/invite");

  await expect(
    page.getByRole("heading", { name: "This invitation link no longer works" }),
  ).toBeVisible();
  expect(calls).toBe(0);
});
