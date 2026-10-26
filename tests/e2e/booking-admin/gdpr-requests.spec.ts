import { expect, test, type Route } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// Data export and account deletion in Booking Admin (VAY-2262).
const session = {
  accessToken: "gdpr-test-token",
  csrfToken: "gdpr-test-csrf",
  organizationId: "org_hotel_group",
  resources: { hotel: ["booking_hotel_alpenrose"] },
  user: { id: "user_hotel", email: "owner@example.test", status: "active" },
};

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

async function authorized(route: Route): Promise<boolean> {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: corsHeaders(route) });
    return false;
  }
  if (route.request().headers().authorization !== "Bearer gdpr-test-token") {
    await route.fulfill({ status: 401, headers: corsHeaders(route), json: { detail: "no" } });
    return false;
  }
  return true;
}

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: session }),
  );
});

test("a hotel owner requests a data export and downloads it once it is ready", async ({ page }) => {
  let requested = false;
  let downloaded = 0;
  await page.route(
    /\/api\/identity\/gdpr\/export-(request|status|download)(?:\?|$)/,
    async (route) => {
      if (!(await authorized(route))) return;
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/export-request")) {
        requested = true;
        return route.fulfill({
          headers: corsHeaders(route),
          json: {
            id: "export-1",
            status: "completed",
            requested_at: "2026-10-17T10:00:00Z",
            expires_at: "2026-10-24T10:00:00Z",
            download_token: "download-token-1",
            message: "Your export is ready.",
          },
        });
      }
      if (url.pathname.endsWith("/export-download")) {
        downloaded++;
        expect(url.searchParams.get("token")).toBe("download-token-1");
        return route.fulfill({
          headers: { ...corsHeaders(route), "content-type": "application/json" },
          body: JSON.stringify({ user: { email: "owner@example.test" } }),
        });
      }
      if (!requested) {
        return route.fulfill({
          status: 404,
          headers: corsHeaders(route),
          json: { detail: "none" },
        });
      }
      return route.fulfill({
        headers: corsHeaders(route),
        json: {
          id: "export-1",
          request_type: "export",
          status: "completed",
          requested_at: "2026-10-17T10:00:00Z",
          processed_at: "2026-10-17T10:05:00Z",
          expires_at: "2026-10-24T10:00:00Z",
          download_token: "download-token-1",
        },
      });
    },
  );

  await page.goto("/settings/data-export");
  await expect(page.getByRole("heading", { name: "Export your data", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request export" })).toBeEnabled();

  await page.getByRole("button", { name: "Request export" }).click();
  await expect(page.getByText("Your export is ready.")).toBeVisible();
  await expect(page.locator("dd", { hasText: "Completed" })).toBeVisible();
  // A completed export may be requested again; only pending/processing ones block the button.
  await expect(page.getByRole("button", { name: "Request export" })).toBeEnabled();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download export" }).click();
  expect((await download).suggestedFilename()).toBe("vayada-data-export.json");
  expect(downloaded).toBe(1);
});

test("account deletion needs the typed confirmation and can be cancelled in the grace period", async ({
  page,
}) => {
  let deletion: Record<string, unknown> | null = null;
  const calls: string[] = [];
  await page.route(
    /\/api\/identity\/gdpr\/delete-(request|cancel|status)(?:\?|$)/,
    async (route) => {
      if (!(await authorized(route))) return;
      const path = new URL(route.request().url()).pathname;
      calls.push(`${route.request().method()} ${path}`);
      if (path.endsWith("/delete-request")) {
        deletion = {
          id: "deletion-1",
          request_type: "deletion",
          status: "pending",
          requested_at: "2026-10-17T10:00:00Z",
          processed_at: null,
          expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        };
        return route.fulfill({
          headers: corsHeaders(route),
          json: {
            id: "deletion-1",
            status: "pending",
            requested_at: "2026-10-17T10:00:00Z",
            scheduled_deletion_at: deletion.expires_at,
            message: "Deletion scheduled in 30 days.",
          },
        });
      }
      if (path.endsWith("/delete-cancel")) {
        deletion = { ...deletion, status: "cancelled", processed_at: "2026-10-17T11:00:00Z" };
        return route.fulfill({
          headers: corsHeaders(route),
          json: { message: "Deletion request cancelled.", cancelled: true },
        });
      }
      return deletion
        ? route.fulfill({ headers: corsHeaders(route), json: deletion })
        : route.fulfill({ status: 404, headers: corsHeaders(route), json: { detail: "none" } });
    },
  );

  await page.goto("/settings/delete-account");
  await expect(page.getByRole("heading", { name: "Delete account", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Request account deletion" }).click();
  const confirm = page.getByRole("button", { name: "Confirm deletion" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/type DELETE below/).fill("delete");
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/type DELETE below/).fill("DELETE");
  await confirm.click();

  await expect(page.getByText("Deletion scheduled in 30 days.")).toBeVisible();
  await expect(page.getByText(/You have 30 days to cancel/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request account deletion" })).toHaveCount(0);

  await page.getByRole("button", { name: "Cancel deletion request" }).click();
  await expect(page.getByText("Deletion request cancelled.")).toBeVisible();
  await expect(page.getByText("Previous request cancelled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Request account deletion" })).toBeVisible();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
    "POST /api/identity/gdpr/delete-request",
    "POST /api/identity/gdpr/delete-cancel",
  ]);
});

test("the data-rights pages link back to the privacy page", async ({ page }) => {
  await page.route(/\/api\/identity\/gdpr\//, (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: corsHeaders(route) })
      : route.fulfill({ status: 404, headers: corsHeaders(route), json: { detail: "none" } }),
  );
  for (const path of ["/settings/data-export", "/settings/delete-account"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Privacy & data" })).toHaveAttribute(
      "href",
      "/settings/privacy",
    );
  }
});
