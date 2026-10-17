import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ORGANIZATION_ID,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// VAY-2266: a redeemed handoff keeps its target when the hotel list is temporarily unavailable.
// A PMS hotel adding a property must still land on /setup?…&mode=add&returnProduct=pms.
const ADD_PROPERTY = "/setup?entryProduct=pms&returnProduct=pms&returnTo=%2Fdashboard&mode=add";
const WORKOS_ORGANIZATION_ID = "org_workos_hotel_group";

test("a failed hotel list after redemption offers a retry and keeps the handoff target", async ({
  page,
}) => {
  await mockBookingAdminShellRoutes(page);
  await page.route("**/auth/session?surface=booking-admin", (route) =>
    route.fulfill({
      json: {
        accessToken: "e2e-booking-authkit-token",
        csrfToken: "e2e-booking-csrf-token",
        organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
        workosOrganizationId: WORKOS_ORGANIZATION_ID,
        resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
        user: {
          id: "user_booking_owner",
          email: "owner@example.com",
          name: "Booking Owner",
          status: "active",
          workosUserId: "workos_user_booking_owner",
        },
      },
    }),
  );
  const redemptions: unknown[] = [];
  await page.route("**/auth/handoff/redeem", (route) => {
    redemptions.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        routingHints: {
          organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
          workosOrganizationId: WORKOS_ORGANIZATION_ID,
        },
        targetPath: ADD_PROPERTY,
      },
    });
  });
  let statusReads = 0;
  await page.route("**/api/hotel-setup/status**", (route) => {
    statusReads += 1;
    if (statusReads === 1) return route.fulfill({ status: 503, json: { detail: "down" } });
    return route.fallback();
  });

  await page.goto(`/handoff#code=${"a".repeat(40)}`);

  await expect(page.getByText("Your session transfer is temporarily unavailable.")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/handoff");
  expect(redemptions).toHaveLength(1);
  await page.getByRole("button", { name: "Try again" }).click();

  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(ADD_PROPERTY);
  // The one-time code was not redeemed a second time: the retry only re-read the hotel list.
  expect(redemptions).toHaveLength(1);
});
