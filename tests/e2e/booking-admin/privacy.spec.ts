import { expect, test, type Route } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// The privacy page in Booking Admin (VAY-2262): consent status, marketing consent, history.
const status = {
  terms_accepted: true,
  terms_accepted_at: "2026-09-01T00:00:00Z",
  terms_version: "1",
  privacy_accepted: true,
  privacy_accepted_at: "2026-09-01T00:00:00Z",
  privacy_version: "1",
  marketing_consent: false,
  marketing_consent_at: null,
};

const session = {
  accessToken: "privacy-test-token",
  csrfToken: "privacy-test-csrf",
  organizationId: "org_hotel_group",
  resources: { hotel: ["booking_hotel_alpenrose"] },
  user: { id: "user_hotel", email: "owner@example.test", status: "active" },
};

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  };
}

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: session }),
  );
});

test("the privacy page shows consent status and saves a marketing choice", async ({ page }) => {
  let marketing = false;
  let authorizedReads = 0;
  let marketingUpdate: unknown = null;
  await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders(route) });
    }
    if (route.request().headers().authorization !== "Bearer privacy-test-token") {
      return route.fulfill({
        status: 401,
        headers: corsHeaders(route),
        json: { detail: "A valid access token is required." },
      });
    }
    if (route.request().method() === "PUT") {
      marketingUpdate = route.request().postDataJSON();
      marketing = (marketingUpdate as { marketing_consent: boolean }).marketing_consent;
      return route.fulfill({
        headers: corsHeaders(route),
        json: {
          marketing_consent: marketing,
          marketing_consent_at: "2026-09-06T00:00:00Z",
          message: "Preferences saved",
        },
      });
    }
    authorizedReads++;
    return route.fulfill({
      headers: corsHeaders(route),
      json: route.request().url().includes("/history")
        ? {
            history: [
              {
                id: "history-1",
                consent_type: "marketing",
                consent_given: marketing,
                version: null,
                created_at: "2026-09-06T00:00:00Z",
              },
            ],
            total: 1,
          }
        : { ...status, marketing_consent: marketing },
    });
  });

  await page.goto("/settings/privacy");
  await expect(page.getByRole("heading", { name: "Privacy & data", level: 1 })).toBeVisible();
  await expect(page.getByText("Terms of Service")).toBeVisible();
  await expect(page.getByText(/Accepted on/).first()).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Marketing communications" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Withdrawn")).toBeVisible();
  expect(authorizedReads).toBeGreaterThanOrEqual(2);

  await toggle.click();
  await expect(page.getByText("Preferences saved")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Given")).toBeVisible();
  expect(marketingUpdate).toEqual({ marketing_consent: true });

  await expect(page.getByRole("link", { name: /Export your data/ })).toHaveAttribute(
    "href",
    "/settings/data-export",
  );
  await expect(page.getByRole("link", { name: /Delete account/ })).toHaveAttribute(
    "href",
    "/settings/delete-account",
  );
});

test("the Settings grid links to the privacy page", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Privacy & data/ })).toHaveAttribute(
    "href",
    "/settings/privacy",
  );
});

test("a failed consent load shows an error instead of an empty page", async ({ page }) => {
  await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: corsHeaders(route) })
      : route.fulfill({ status: 500, headers: corsHeaders(route), json: { detail: "boom" } }),
  );
  await page.goto("/settings/privacy");
  await expect(
    page.getByText("Failed to load your consent settings. Please try again."),
  ).toBeVisible();
});
