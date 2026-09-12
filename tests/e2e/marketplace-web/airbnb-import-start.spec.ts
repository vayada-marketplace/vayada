import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";
const propertyId = "10090000-0000-4000-8000-000000000001";
const path = `/setup/airbnb-connect/${propertyId}`;
test.skip(process.env.E2E_AIRBNB_IMPORT_CALLBACK !== "1", "Airbnb preview is opt-in");
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

for (const adaptive of [false, true]) {
  test(`Airbnb entry for automatically selected hotel: adaptive=${adaptive}`, async ({ page }) => {
    await page.route(/\/(api|auth)\//, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const path = new URL(route.request().url()).pathname;
      const send = (json: unknown) => route.fulfill({ json, headers: corsHeaders(route) });
      if (path === "/auth/session")
        return send({
          accessToken: "synthetic-token",
          organizationId: propertyId,
          organizationKind: "hotel_group",
          workosOrganizationId: "org_synthetic",
          user: {
            id: propertyId,
            email: "owner@example.test",
            name: "Synthetic Owner",
            phone: "+49301234567",
            profilePictureUrl: "https://example.test/avatar.png",
            status: "active",
          },
        });
      if (path.endsWith("/imports/prepared")) return send({ import: null });
      if (path === "/api/hotel-setup/status")
        return send(
          createAdaptiveHotelSetupStatusMock({
            entryProduct: "pms",
            organizationId: propertyId,
            organizationDisplayName: "Test",
            propertyId,
            propertyDisplayName: "Test Hotel",
            selectedTracks: ["hotel_operations"],
            entryDecision: {
              propertyId,
              decision: "enter",
              destinationRouteKey: "pms.workspace",
              reasonCode: null,
            },
          }),
        );
      return route.fulfill({ status: 503, headers: corsHeaders(route), json: {} });
    });
    await page.goto(`/setup?entryProduct=pms${adaptive ? "&_adaptive=1" : ""}`);
    const link = page.getByRole("link", {
      name: "Connect Airbnb to import rooms (opens in a new tab)",
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", path);
    await expect(link).toHaveAttribute("target", "_blank");
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "Connect Airbnb" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/setup");
    await popup.close();
  });
}

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
