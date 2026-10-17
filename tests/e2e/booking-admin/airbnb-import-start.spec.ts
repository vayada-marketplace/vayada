import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "../support/cors";
const propertyId = "10090000-0000-4000-8000-000000000001";
const path = `/setup/airbnb-connect/${propertyId}`;
test.skip(process.env.E2E_AIRBNB_IMPORT_CALLBACK !== "1", "Airbnb preview is opt-in");
// A signed-in hotel owner; the expired-session test below overrides this route.
test.beforeEach(async ({ page }) => {
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({
      headers: corsHeaders(route),
      json: {
        accessToken: "synthetic-access-token",
        organizationId: "10090000-0000-4000-8000-000000000099",
        organizationKind: "hotel_group",
        user: { id: propertyId, email: "owner@example.test", status: "active" },
      },
    }),
  );
});
for (const scenario of ["success", "not-ready", "failure", "unsafe-url", "retry"] as const) {
  test(`Airbnb start: ${scenario}`, async ({ page }) => {
    let posts = 0;
    await page.route("https://www.airbnb.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Simulated Airbnb authorization</h1>" }),
    );
    await page.route(/\/api\/hotel-setup\/properties\/.*\/airbnb-import\/start$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      posts++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      await route.fulfill({
        status:
          scenario === "not-ready"
            ? 409
            : scenario === "failure" || (scenario === "retry" && posts === 1)
              ? 502
              : 200,
        headers: corsHeaders(route),
        json: {
          sourceId: propertyId,
          url:
            scenario === "unsafe-url"
              ? "https://evil.example.test/"
              : "https://www.airbnb.com/oauth2/auth?synthetic=true",
        },
      });
    });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Connect Airbnb" })).toBeVisible();
    expect(posts).toBe(0);
    await page.getByRole("button", { name: "Continue to Airbnb" }).click();
    if (scenario === "retry") {
      await expect(page.getByRole("main").getByRole("alert")).toContainText("couldn’t start");
      await page.getByRole("button", { name: "Continue to Airbnb" }).click();
    }
    if (scenario === "success" || scenario === "retry") {
      await expect(
        page.getByRole("heading", { name: "Simulated Airbnb authorization" }),
      ).toBeVisible();
    } else {
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        scenario === "not-ready" ? "not ready" : "couldn’t start",
      );
      await expect(page.getByRole("button", { name: "Continue to Airbnb" })).toBeEnabled();
      await expect(page).toHaveURL(new RegExp(path));
    }
    expect(posts).toBe(scenario === "retry" ? 2 : 1);
  });
}

// The setup wizard's own "Connect Airbnb" link is covered with the setup pages (VAY-2261).

for (const outcome of ["succeeded", "failed", "existing"] as const) {
  test(`Airbnb preparation: ${outcome}`, async ({ page }) => {
    let starts = 0;
    let commands = 0;
    let commandId = "";
    await page.route("https://www.airbnb.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Simulated Airbnb authorization</h1>" }),
    );
    await page.route(/\/api\/(hotel-setup|pms)\/properties\//, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const pathname = new URL(route.request().url()).pathname;
      const send = (json: unknown, status = 200) =>
        route.fulfill({ status, headers: corsHeaders(route), json });
      if (pathname.endsWith("/start")) {
        starts++;
        return starts === 1
          ? send({ code: "channex_binding_required" }, 409)
          : send({
              sourceId: propertyId,
              url: "https://www.airbnb.com/oauth2/auth?synthetic=true",
            });
      }
      if (pathname.endsWith("/channex"))
        return send({
          propertyId,
          connection: {
            status: outcome === "existing" ? "connected" : "disconnected",
            externalPropertyId: outcome === "existing" ? propertyId : null,
          },
        });
      if (pathname.endsWith("/commands")) {
        commands++;
        commandId = route.request().postDataJSON().commandId;
        return send(
          {
            operationId: propertyId,
            propertyId,
            commandId,
            operationType: "enable",
            status: "queued",
          },
          202,
        );
      }
      if (pathname.endsWith(`/operations/${propertyId}`))
        return send({
          operationId: propertyId,
          propertyId,
          commandId,
          operationType: "enable",
          status: outcome,
        });
      return send({}, 404);
    });
    await page.goto(path);
    await page.getByRole("button", { name: "Continue to Airbnb" }).click();
    if (outcome === "succeeded")
      await expect(
        page.getByRole("heading", { name: "Simulated Airbnb authorization" }),
      ).toBeVisible();
    else
      await expect(page.getByRole("main").getByRole("alert")).toContainText(
        outcome === "existing" ? "existing connection" : "did not finish",
      );
    expect(commands).toBe(outcome === "existing" ? 0 : 1);
    expect(starts).toBe(outcome === "succeeded" ? 2 : 1);
  });
}

test("Airbnb start: an expired session goes to login and comes back here", async ({ page }) => {
  let starts = 0;
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, headers: corsHeaders(route), json: { error: "missing_session" } }),
  );
  await page.route(/\/api\/hotel-setup\/properties\/.*\/airbnb-import\/start$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    starts++;
    await route.fulfill({ status: 401, headers: corsHeaders(route), json: {} });
  });
  await page.goto(path);
  await page.getByRole("button", { name: "Continue to Airbnb" }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/login\\?returnTo=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    ),
  );
  expect(starts).toBe(0);
});
