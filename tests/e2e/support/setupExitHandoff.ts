import { expect, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "../marketplace-web/utils/cors";

export async function mockSetupExitHandoff(
  page: Page,
  baseURL: string | undefined,
  propertyId: string,
  targetPath = `/dashboard?setup=incomplete&propertyId=${propertyId}`,
) {
  const destination = new URL(baseURL ?? "http://marketplace.localhost:3000");
  destination.hostname = "pms.localhost";
  destination.pathname = "/handoff";
  destination.hash = `code=${"a".repeat(40)}`;
  await page.route("**/auth/handoff/create", async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      sourceSurface: "marketplace-web",
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
