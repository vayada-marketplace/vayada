import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "10090000-0000-4000-8000-000000000001";
const sourceId = "10090000-0000-4000-8000-000000000002";
const channelId = "10090000-0000-4000-8000-000000000003";
const token = "x".repeat(43);
const path = `/setup/airbnb-return/${propertyId}/${sourceId}`;
const success = `?success=true&channel_id=${channelId}&token=${token}`;
// Requires AIRBNB_IMPORT_CALLBACK_ENABLED=true in the isolated frontend.
test.skip(process.env.E2E_AIRBNB_IMPORT_CALLBACK !== "1", "Callback preview is opt-in");
for (const scenario of [
  "success",
  "lost-response",
  "reload",
  "cancelled",
  "duplicate",
  "missing-token",
  "wrong-source",
  "denied",
] as const) {
  test(`Airbnb return: ${scenario}`, async ({ page }) => {
    let posts = 0;
    let reads = 0;
    let refreshes = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      refreshes++;
      expect(new URL(page.url()).search).toBe("");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "synthetic-access-token",
          organizationId: propertyId,
          organizationKind: "hotel_group",
          user: { id: propertyId, email: "owner@example.test", status: "active" },
        },
      });
    });
    await page.route(/\/api\/hotel-setup\/properties\/.*\/airbnb-import\//, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      expect(new URL(page.url()).search).toBe("");
      expect(new URL(page.url()).hash).toBe("");
      expect(route.request().headers().referer).toBeUndefined();
      if (route.request().headers().authorization !== "Bearer synthetic-access-token") {
        return route.fulfill({ status: 401, headers: corsHeaders(route), json: {} });
      }
      if (route.request().method() === "POST") {
        posts++;
        expect(route.request().postDataJSON()).toEqual({ state: token, channelId });
        return route.fulfill({
          status: scenario === "lost-response" ? 502 : 200,
          headers: corsHeaders(route),
          json: { sourceId },
        });
      }
      reads++;
      await route.fulfill({
        status: scenario === "denied" ? 403 : 200,
        headers: corsHeaders(route),
        json: { sourceId: scenario === "wrong-source" ? propertyId : sourceId, data: {} },
      });
    });
    const query =
      scenario === "reload"
        ? ""
        : scenario === "cancelled"
          ? "?success=false"
          : scenario === "duplicate"
            ? `${success}&token=other`
            : scenario === "missing-token"
              ? `?success=true&channel_id=${channelId}`
              : success;
    const response = await page.goto(`${path}${query}#discard`);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    const ready = ["success", "lost-response", "reload"].includes(scenario);
    await expect(page.getByRole("status")).toContainText(
      ready ? "saved for review" : scenario === "cancelled" ? "cancelled" : "could not confirm",
    );
    expect(new URL(page.url()).search).toBe("");
    const skipped = ["cancelled", "duplicate", "missing-token"].includes(scenario);
    expect(posts).toBe(skipped || scenario === "reload" ? 0 : 1);
    expect(reads).toBe(skipped ? 0 : 1);
    expect(refreshes).toBe(skipped ? 0 : 1);
    await expect(page.getByRole("link", { name: "Return to hotel setup" })).toHaveAttribute(
      "href",
      `/setup?propertyId=${propertyId}`,
    );
    if (scenario === "success") {
      await page.reload();
      await expect(page.getByRole("status")).toContainText("saved for review");
      expect(posts).toBe(1);
      expect(reads).toBe(2);
    }
  });
}
