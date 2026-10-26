import { expect, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./cors";

export async function mockSetupExitHandoff(
  page: Page,
  baseURL: string | undefined,
  propertyId: string,
  targetPath = `/dashboard?setup=incomplete&propertyId=${propertyId}`,
  options: { sourceSurface?: "booking-admin" } = {},
) {
  const sourceSurface = options.sourceSurface ?? "booking-admin";
  const destination = new URL(baseURL ?? "http://admin.booking.localhost:3003");
  destination.hostname = "pms.localhost";
  destination.pathname = "/handoff";
  destination.hash = `code=${"a".repeat(40)}`;
  await page.route("**/auth/handoff/create", async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      sourceSurface,
      targetSurface: "pms-web",
      targetPath,
      routingHints: { propertyId },
    });
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: { destination: destination.toString() },
    });
  });
  await page.route(`${destination.origin}/handoff`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>PMS handoff</title>",
    }),
  );
  return destination.toString();
}

/**
 * Booking Admin hosts the setup wizard (VAY-2261): a booking hotel leaves setup for this app's
 * own dashboard with the setup-exit marker. Mocks that page and returns the expected URL.
 */
export async function mockBookingDashboardExit(
  page: Page,
  baseURL: string | undefined,
  propertyId: string,
) {
  const destination = new URL(baseURL ?? "http://127.0.0.1:3003");
  if (destination.hostname === "127.0.0.1" && destination.port === "3003") {
    destination.hostname = "localhost";
  }
  destination.pathname = "/dashboard";
  destination.search = new URLSearchParams({ setup: "incomplete", propertyId }).toString();
  await page.route(
    (url) => url.href === destination.href,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Booking dashboard</title>",
      }),
  );
  return destination.href;
}
