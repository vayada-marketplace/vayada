import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_CUSTOM_DOMAIN_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  defaultCustomDomain,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
  type BookingAdminCustomDomainFixture,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin settings no-legacy guard", () => {
  test("loads migrated settings surfaces without helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**/api/pms/properties/${BOOKING_ADMIN_HOTEL_ID}/payment-settings*`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentProvider: "vayada",
            payAtPropertyEnabled: true,
            onlineCardPayment: false,
            bankTransfer: false,
          },
        },
      }),
    );
    let customDomain: BookingAdminCustomDomainFixture = defaultCustomDomain;
    await page.route(`**${BOOKING_ADMIN_CUSTOM_DOMAIN_PATH}*`, async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { domain: string };
        customDomain = {
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: "f6853000-0000-0000-0000-000000000001",
          configured: true,
          domain: body.domain,
          status: "pending",
          sslStatus: "pending",
          dnsRecords: [
            {
              type: "CNAME",
              name: body.domain,
              value: "custom.booking.vayada.com",
              status: "pending",
            },
          ],
          verificationErrors: [],
          checkedAt: "2026-06-22T10:00:00.000Z",
          updatedAt: "2026-06-22T10:00:00.000Z",
        };
        await route.fulfill({ json: customDomain });
        return;
      }
      if (method === "DELETE") {
        customDomain = defaultCustomDomain;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ json: customDomain });
    });

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Booking", exact: true }).click();
    await page.getByPlaceholder("booking.yourdomain.com").fill("book.alpenrose.example");
    await page.getByRole("button", { name: "Connect Domain" }).click();
    await expect(page.getByText("book.alpenrose.example").first()).toBeVisible();
    await expect(page.getByText("custom.booking.vayada.com")).toBeVisible();
    await page.getByRole("button", { name: "Remove Domain" }).click();
    await expect(page.getByPlaceholder("booking.yourdomain.com")).toBeVisible();

    await page.getByRole("button", { name: "Location map", exact: true }).click();
    await expect(
      page.getByText("Automatic property map centering is not available on next-api yet."),
    ).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
