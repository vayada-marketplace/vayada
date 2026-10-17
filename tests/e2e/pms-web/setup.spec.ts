import { expect, test, type Page } from "@playwright/test";

import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

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

  test("a setup-required guard decision reaches Booking Admin through the alias", async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId: "org_pms_owner",
          organizationDisplayName: "PMS Owner Group",
          propertyId: PMS_WEB_PROPERTY_ID,
          entryDecision: {
            decision: "setup_required",
            destinationRouteKey: "hotel_setup",
            reasonCode: "product_access_pending",
          },
        }),
      }),
    );
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/");

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs.map((handoff) => handoff.targetPath)).toEqual([
      canonicalSetupPath({
        entryProduct: "pms",
        returnTo: "/dashboard",
        propertyId: PMS_WEB_PROPERTY_ID,
      }),
    ]);
  });

  test("the PMS login returns a signed-out visitor to the alias without nesting the guard", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    let sessionReads = 0;
    await page.route("**/auth/session?surface=pms-web", (route) => {
      sessionReads += 1;
      if (sessionReads === 1) {
        return route.fulfill({ status: 401, json: { error: "missing_session" } });
      }
      return route.fallback();
    });
    await page.route("**/auth/password/login", (route) =>
      route.fulfill({
        json: {
          accessToken: "e2e-pms-token",
          csrfToken: "e2e-pms-csrf-token",
          organizationId: "org_pms_owner",
          workosOrganizationId: "org_workos_pms_owner",
          resources: { "pms:pms_property": [PMS_WEB_PROPERTY_ID] },
          user: {
            id: "user_pms_owner",
            email: "owner@example.com",
            name: "PMS Owner",
            status: "active",
            workosUserId: "workos_user_pms_owner",
          },
        },
      }),
    );
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsetup%3Fmode%3Dadd$/);
    await page.getByLabel("Email address", { exact: true }).fill("owner@example.com");
    await page.getByLabel("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();

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

  test("sends a signed-out visitor to the PMS login and back to the alias", async ({ page }) => {
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({ status: 401, json: { error: "missing_session" } }),
    );
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add");

    await expect(page).toHaveURL(/\/login\?returnTo=%2Fsetup%3Fmode%3Dadd$/);
    await expect(page.getByRole("heading", { name: "Sign in to vayada" })).toBeVisible();
    expect(handoffs).toEqual([]);
  });

  test("sends a pending workspace choice to the PMS login's picker, not another app", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({
        json: {
          organizationSelectionRequired: true,
          csrfToken: "e2e-pms-csrf-token",
          organizations: [
            {
              organizationId: "org_a",
              workosOrganizationId: "org_workos_a",
              displayName: "Hotel Group A",
              kind: "hotel_group",
            },
            {
              organizationId: "org_b",
              workosOrganizationId: "org_workos_b",
              displayName: "Hotel Group B",
              kind: "hotel_group",
            },
          ],
          user: { id: "user_pms_owner", email: "owner@example.com", name: "PMS Owner" },
        },
      }),
    );
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add");

    await expect(page).toHaveURL(/\/login\?auth=callback&returnTo=%2Fsetup%3Fmode%3Dadd$/);
    await expect(page.getByRole("heading", { name: "Choose hotel group" })).toBeVisible();
    expect(handoffs).toEqual([]);
  });

  test("offers a retry when the session read is temporarily unavailable", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    let sessionReads = 0;
    await page.route("**/auth/session?surface=pms-web", (route) => {
      sessionReads += 1;
      if (sessionReads === 1) return route.fulfill({ status: 503, json: { error: "down" } });
      return route.fallback();
    });
    const handoffs = await mockSetupHandoff(page);

    await page.goto("/setup?mode=add");

    await expect(page.getByText("Your session transfer is temporarily unavailable.")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/setup");
    expect(handoffs).toEqual([]);
    await page.getByRole("button", { name: "Retry" }).click();

    await expect.poll(() => page.url()).toBe(handoffDestination());
    expect(handoffs).toHaveLength(1);
  });

  test("sends a signed-in visitor through Booking Admin's login after a terminal handoff failure", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/auth/handoff/create", (route) =>
      route.fulfill({ status: 409, json: { error: "handoff_not_enabled" } }),
    );
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
    await expect(page.getByRole("heading", { name: "Booking Admin login" })).toBeVisible();
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
    await mockHandoffLanding(page);

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
  await mockHandoffLanding(page);
  return handoffs;
}

// A document request carries no fragment, so the landing route matches origin and path only.
async function mockHandoffLanding(page: Page) {
  await page.route(
    (url) => url.origin === bookingAdminOrigin() && url.pathname === "/handoff",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Booking Admin handoff</title><h1>Booking Admin handoff</h1>",
      }),
  );
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
