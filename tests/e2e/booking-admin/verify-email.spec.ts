import { expect, test, type Page } from "@playwright/test";
import { mockBookingAdminShellRoutes } from "../support/bookingAdminMocks";

// Password sign-up with e-mail verification, the same flow pms-web has (VAY-2262).
const pendingVerification = {
  state: "email_verification_required",
  message: "Verify your email address to continue.",
  pendingAuthenticationToken: "pending-email-token",
  email: "owner@example.test",
  emailVerificationId: "email_verification_123",
};

const verifiedSession = {
  accessToken: "verified-access-token",
  csrfToken: "verified-csrf-token",
  organizationId: "org_hotel_group",
  resources: { hotel: ["booking_hotel_alpenrose"] },
  user: { id: "user_hotel", email: "owner@example.test", status: "active" },
};

async function signUpUntilVerification(page: Page) {
  await page.route("**/auth/password/signup", (route) =>
    route.fulfill({ status: 403, json: pendingVerification }),
  );
  await page.goto("/signup");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText("Enter the code sent to owner@example.test.")).toBeVisible();
}

test("sign-up with a pending e-mail verification confirms the code and enters the dashboard", async ({
  page,
}) => {
  await mockBookingAdminShellRoutes(page);
  let confirmBody: unknown = null;
  await page.route("**/auth/email-verification/confirm", (route) => {
    confirmBody = route.request().postDataJSON();
    return route.fulfill({ json: verifiedSession });
  });
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: verifiedSession }),
  );

  await signUpUntilVerification(page);

  await page.getByLabel("Verification code").fill("123456");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByText("Email verified. Redirecting…")).toBeVisible();
  expect(confirmBody).toEqual({
    pendingAuthenticationToken: "pending-email-token",
    code: "123456",
    flow: "signup",
    intent: "hotel",
    surface: "booking-admin",
  });
  await expect(page).toHaveURL(/\/dashboard/);
});

test("a wrong code shows the backend message and a new code can be requested", async ({ page }) => {
  await page.route("**/auth/email-verification/confirm", (route) =>
    route.fulfill({
      status: 401,
      json: { state: "auth_failed", message: "That code is not valid." },
    }),
  );
  let resendBody: unknown = null;
  await page.route("**/auth/email-verification/resend", (route) => {
    resendBody = route.request().postDataJSON();
    return route.fulfill({ json: { message: "We sent a new code." } });
  });

  await signUpUntilVerification(page);

  await page.getByLabel("Verification code").fill("000000");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByText("That code is not valid.")).toBeVisible();

  await page.getByRole("button", { name: "Send new code", exact: true }).click();
  await expect(page.getByText("We sent a new code.")).toBeVisible();
  expect(resendBody).toEqual({ emailVerificationId: "email_verification_123" });
});

test("opening /verify-email without a pending sign-up offers the way back to sign in", async ({
  page,
}) => {
  await page.goto("/verify-email");
  await expect(page.getByText("Verification has expired. Please sign in again.")).toBeVisible();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
