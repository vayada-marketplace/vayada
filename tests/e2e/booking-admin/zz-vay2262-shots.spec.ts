import { test, type Page, type Route } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// Throwaway: full-page screenshots of the VAY-2262 pages for the Linear comment. Never committed.
const session = {
  accessToken: "shot-token",
  csrfToken: "shot-csrf",
  organizationId: "org_hotel_group",
  resources: { hotel: ["booking_hotel_alpenrose"] },
  user: { id: "user_hotel", email: "owner@example.test", status: "active" },
};

function cors(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  };
}

async function shot(page: Page, name: string, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/shots/${name}-${width}.png`, fullPage: true });
  if (width === 1440) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/shots/${name}-390.png`, fullPage: true });
  }
}

test("verify-email", async ({ page }) => {
  await page.route("**/auth/password/signup", (route) =>
    route.fulfill({
      status: 403,
      json: {
        state: "email_verification_required",
        message: "Verify your email address to continue.",
        pendingAuthenticationToken: "pending-email-token",
        email: "owner@example.test",
        emailVerificationId: "email_verification_123",
      },
    }),
  );
  await page.goto("/signup");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/verify-email$/);
  await page.getByLabel("Verification code").fill("482913");
  await shot(page, "verify-email");
  await page.goto("/verify-email");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await shot(page, "verify-email-expired");
});

test("invite", async ({ page }) => {
  await page.route(/\/api\/marketplace\/hotel-account-invites\/lookup$/, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors(route) })
      : route.fulfill({
          headers: cors(route),
          json: {
            contractVersion: "hotel-account-invite.v1",
            identity: { emailHint: "o****@example.test" },
            organization: { displayName: "Alpenrose Hospitality" },
            property: { displayName: "Hotel Alpenrose" },
            selectedTracks: ["hotel_operations"],
            handoffPath: "/setup",
            expiresAt: "2027-01-20T12:00:00.000Z",
          },
        }),
  );
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, json: { error: "missing_session" } }),
  );
  await page.goto("/invite#code=VAY-browser-invite-1050");
  await page.getByRole("heading", { name: "Hotel Alpenrose" }).waitFor();
  await shot(page, "invite-signed-out");
  await page.goto("/invite");
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("heading", { name: "Open your hotel invitation" }).waitFor();
  await shot(page, "invite-code-form");
});

test("airbnb", async ({ page }) => {
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: session }),
  );
  await page.goto("/setup/airbnb-connect/10090000-0000-4000-8000-000000000001");
  await page.getByRole("heading", { name: "Connect Airbnb" }).waitFor();
  await shot(page, "airbnb-connect");
  await page.goto(
    "/setup/airbnb-return/10090000-0000-4000-8000-000000000001/10090000-0000-4000-8000-000000000002?success=false",
  );
  await page.getByText("The connection was cancelled").waitFor();
  await shot(page, "airbnb-return-cancelled");
});

test("settings pages", async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: session }),
  );
  await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors(route) })
      : route.fulfill({
          headers: cors(route),
          json: route.request().url().includes("/history")
            ? {
                history: [
                  {
                    id: "h1",
                    consent_type: "marketing",
                    consent_given: true,
                    version: null,
                    created_at: "2026-09-06T00:00:00Z",
                  },
                  {
                    id: "h2",
                    consent_type: "terms",
                    consent_given: true,
                    version: "1",
                    created_at: "2026-09-01T00:00:00Z",
                  },
                ],
                total: 2,
              }
            : {
                terms_accepted: true,
                terms_accepted_at: "2026-09-01T00:00:00Z",
                terms_version: "1",
                privacy_accepted: true,
                privacy_accepted_at: "2026-09-01T00:00:00Z",
                privacy_version: "1",
                marketing_consent: true,
                marketing_consent_at: "2026-09-06T00:00:00Z",
              },
        }),
  );
  await page.route(/\/api\/identity\/gdpr\/export-status(?:\?|$)/, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors(route) })
      : route.fulfill({
          headers: cors(route),
          json: {
            id: "export-1",
            request_type: "export",
            status: "completed",
            requested_at: "2026-10-17T10:00:00Z",
            processed_at: "2026-10-17T10:05:00Z",
            expires_at: "2026-10-24T10:00:00Z",
            download_token: "download-token-1",
          },
        }),
  );
  await page.route(/\/api\/identity\/gdpr\/delete-status(?:\?|$)/, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors(route) })
      : route.fulfill({ status: 404, headers: cors(route), json: { detail: "none" } }),
  );
  await page.goto("/settings");
  await page.getByRole("link", { name: /Privacy & data/ }).waitFor();
  await shot(page, "settings-grid");
  await page.goto("/settings/privacy");
  await page.getByText("Terms of Service").waitFor();
  await shot(page, "settings-privacy");
  await page.goto("/settings/data-export");
  await page.getByRole("button", { name: "Download export" }).waitFor();
  await shot(page, "settings-data-export");
  await page.goto("/settings/delete-account");
  await page.getByRole("button", { name: "Request account deletion" }).waitFor();
  await page.getByRole("button", { name: "Request account deletion" }).click();
  await shot(page, "settings-delete-account");
});
