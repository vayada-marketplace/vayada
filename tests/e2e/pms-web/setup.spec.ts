import { expect, test, type Page } from "@playwright/test";

import { PMS_WEB_PROPERTY_ID, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

// Booking Admin hosts the shared setup wizard (VAY-2261). The PMS alias never navigates there
// directly: it mints a one-time session handoff (VAY-2266) and lands on Booking Admin's /handoff,
// or sends the user through Booking Admin's login with the setup path preserved.
const HANDOFF_CODE = "a".repeat(40);

test.describe("pms-web canonical setup redirect", () => {
  test("hands the session to Booking Admin and preserves the exact product return path", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    const handoffs = await mockSetupHandoff(page);
    await page.route("**/__before-local-setup", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Before local setup</title><h1>Before local setup</h1>",
      }),
    );

    await page.goto("/__before-local-setup");
    await page.goto(
      `/setup?entryProduct=pms&returnTo=${encodeURIComponent("/reservations?view=arrivals")}&propertyId=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect.poll(() => page.url()).toBe(handoffDestination());
    await expect(page.getByRole("heading", { name: "Booking Admin handoff" })).toBeVisible();
    expect(handoffs).toEqual([
      {
        routingHints: {},
        sourceSurface: "pms-web",
        targetPath: canonicalSetupPath({
          entryProduct: "pms",
          returnTo: "/reservations?view=arrivals",
          propertyId: PMS_WEB_PROPERTY_ID,
        }),
        targetSurface: "booking-admin",
      },
    ]);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Before local setup" })).toBeVisible();
  });

  test("preserves another valid entry product while defaulting an unsafe return path", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    const handoffs = await mockSetupHandoff(page);

    await page.goto(
      `/setup?entryProduct=marketplace&returnTo=${encodeURIComponent("https://attacker.example/dashboard")}&propertyId=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs.map((handoff) => handoff.targetPath)).toEqual([
      canonicalSetupPath({
        entryProduct: "marketplace",
        returnTo: "/dashboard",
        propertyId: PMS_WEB_PROPERTY_ID,
      }),
    ]);
  });

  test("defaults a missing entry product to PMS", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add");

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs.map((handoff) => handoff.targetPath)).toEqual([
      canonicalSetupPath({ entryProduct: "pms", returnTo: "/dashboard", mode: "add" }),
    ]);
  });

  test("forwards a calendar recovery step and marker to Booking Admin", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    const handoffs = await mockSetupHandoff(page);

    await page.goto(
      `/setup?entryProduct=pms&returnTo=${encodeURIComponent("/settings#calendar")}&propertyId=${PMS_WEB_PROPERTY_ID}&recovery=pms-calendar&step=calendar`,
    );

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs.map((handoff) => handoff.targetPath)).toEqual([
      `${canonicalSetupPath({
        entryProduct: "pms",
        returnTo: "/settings#calendar",
        propertyId: PMS_WEB_PROPERTY_ID,
      })}&step=calendar&recovery=pms-calendar`,
    ]);
  });

  test("drops an unknown step but keeps the rest of the path", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add&step=not-a-step");

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs.map((handoff) => handoff.targetPath)).toEqual([
      canonicalSetupPath({ entryProduct: "pms", returnTo: "/dashboard", mode: "add" }),
    ]);
  });

  test("sends a signed-out visitor through Booking Admin's login with the setup path", async ({
    page,
  }) => {
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({ status: 401, json: { error: "missing_session" } }),
    );
    const handoffs = await mockSetupHandoff(page);
    const loginUrl = new URL("/login", bookingAdminOrigin());
    loginUrl.searchParams.set(
      "returnTo",
      canonicalSetupPath({ entryProduct: "pms", returnTo: "/dashboard", mode: "add" }),
    );
    await page.route(
      (url) => url.toString() === loginUrl.toString(),
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Booking Admin login</title><h1>Booking Admin login</h1>",
        }),
    );

    await page.goto("/setup?mode=add");

    await expect.poll(() => page.url()).toBe(loginUrl.toString());
    expect(handoffs).toEqual([]);
  });

  test("offers a retry when the handoff is temporarily unavailable", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    let attempts = 0;
    await page.route("**/auth/handoff/create", (route) => {
      attempts += 1;
      if (attempts === 1)
        return route.fulfill({ status: 503, json: { error: "handoff_retryable" } });
      return route.fulfill({ json: { destination: handoffDestination() } });
    });
    await page.route(
      (url) => url.toString() === handoffDestination(),
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Booking Admin handoff</title><h1>Booking Admin handoff</h1>",
        }),
    );

    await page.goto("/setup?mode=add");

    await expect(page.getByText("Your session transfer is temporarily unavailable.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/setup");
    await page.getByRole("button", { name: "Retry" }).click();

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(attempts).toBe(2);
  });
});

async function mockSetupHandoff(page: Page) {
  const handoffs: { targetPath: string }[] = [];
  await page.route("**/auth/handoff/create", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-vayada-csrf"]).toBe("e2e-pms-csrf-token");
    handoffs.push(route.request().postDataJSON() as { targetPath: string });
    return route.fulfill({ json: { destination: handoffDestination() } });
  });
  await page.route(
    (url) => url.toString() === handoffDestination(),
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Booking Admin handoff</title><h1>Booking Admin handoff</h1>",
      }),
  );
  return handoffs;
}

// The pms-web dev server points at Booking Admin through NEXT_PUBLIC_BOOKING_ADMIN_URL
// (playwright.config.ts, PR Checks).
function bookingAdminOrigin(): string {
  return (
    process.env.E2E_SETUP_HOST_BASE_URL ||
    process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL ||
    (process.env.CI === "true" || process.env.E2E_START_SERVERS === "1"
      ? "http://admin.booking.localhost:3003"
      : "https://admin.booking.localhost")
  );
}

function handoffDestination(): string {
  return `${new URL("/handoff", bookingAdminOrigin()).toString()}#code=${HANDOFF_CODE}`;
}

function canonicalSetupPath(input: {
  entryProduct: "booking" | "marketplace" | "pms";
  returnTo: string;
  propertyId?: string;
  mode?: "add";
}): string {
  const query = new URLSearchParams({ entryProduct: input.entryProduct, returnProduct: "pms" });
  query.set("returnTo", input.returnTo);
  if (input.propertyId) query.set("propertyId", input.propertyId);
  if (input.mode) query.set("mode", input.mode);
  return `/setup?${query.toString()}`;
}
