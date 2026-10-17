import { expect, test } from "@playwright/test";

import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

// VAY-2266: "+ Add Property" opens the Booking Admin wizard in add mode through the one-time
// session handoff, so the host stays signed in and never sees another app's login.
const HANDOFF_CODE = "b".repeat(40);
const ADD_PROPERTY_PATH =
  "/setup?entryProduct=pms&returnProduct=pms&returnTo=%2Fdashboard&mode=add";

test("the header's Add Property hands the session to Booking Admin's setup in add mode", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const destination = `${new URL("/handoff", bookingAdminOrigin()).toString()}#code=${HANDOFF_CODE}`;
  const handoffs: unknown[] = [];
  await page.route("**/auth/handoff/create", (route) => {
    handoffs.push(route.request().postDataJSON());
    return route.fulfill({ json: { destination } });
  });
  // A document request carries no fragment, so the landing route matches origin and path only.
  await page.route(
    (url) => url.origin === bookingAdminOrigin() && url.pathname === "/handoff",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Booking Admin handoff</title><h1>Booking Admin handoff</h1>",
      }),
  );

  await page.goto("/dashboard");
  const switcher = page.locator("header button[title]").first();
  await expect(switcher).toContainText("Alpenrose Munich");
  await switcher.click();
  await page.getByRole("button", { name: "Add Property" }).click();

  await expect.poll(() => page.url()).toBe(destination);
  await expect(page.getByRole("heading", { name: "Booking Admin handoff" })).toBeVisible();
  expect(handoffs).toEqual([
    {
      routingHints: {},
      sourceSurface: "pms-web",
      targetPath: ADD_PROPERTY_PATH,
      targetSurface: "booking-admin",
    },
  ]);
});

function bookingAdminOrigin(): string {
  return (
    process.env.E2E_SETUP_HOST_BASE_URL ||
    process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL ||
    (process.env.CI === "true" || process.env.E2E_START_SERVERS === "1"
      ? "http://admin.booking.localhost:3003"
      : "https://admin.booking.localhost")
  );
}
