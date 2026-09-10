import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "../../tests/e2e/support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "../../tests/e2e/marketplace-web/utils/cors";
const database = "https://pms.localhost:1380";
const organizationId = "10090000-0000-4000-8000-000000000002";

// Real product pages and import/room APIs. Authentication and unrelated setup APIs are fixtures.
async function prepare(page: Page, request: APIRequestContext, propertyId: string) {
  await page.addInitScript((propertyId) => {
    localStorage.setItem("userType", "hotel");
    localStorage.setItem("selectedHotelId", propertyId);
    localStorage.setItem("selectedSharedPropertyId", propertyId);
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  }, propertyId);
  await page.route(/\/(api|auth)\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return fulfillCorsPreflight(route);
    const path = new URL(req.url()).pathname;
    const send = (json: unknown) => route.fulfill({ json, headers: corsHeaders(route) });
    if (path === "/auth/session")
      return send({
        accessToken: "synthetic-token",
        csrfToken: "synthetic-csrf",
        organizationId,
        organizationKind: "hotel_group",
        workosOrganizationId: "org_synthetic_import",
        user: {
          id: "10090000-0000-4000-8000-000000000001",
          email: "import-demo@example.test",
          name: "Synthetic Owner",
          phone: "+49 30 1234567",
          status: "active",
        },
      });
    if (
      path.endsWith("/imports/prepared") ||
      path.endsWith("/import") ||
      new RegExp(
        `/api/pms/properties/${propertyId}/(room-types|rooms|linked-inventory-groups)$`,
      ).test(path)
    ) {
      const response = await request.fetch(database + path, {
        method: req.method(),
        data: req.postData() ?? undefined,
        headers: { "Content-Type": "application/json", Origin: database },
      });
      return route.fulfill({
        status: response.status(),
        body: await response.body(),
        headers: corsHeaders(route),
      });
    }
    if (path === "/api/hotel-setup/status")
      return send(
        createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId,
          organizationDisplayName: "Synthetic Import Test",
          propertyId,
          propertyDisplayName: "Synthetic Import Hotel",
          selectedTracks: ["hotel_operations"],
          entryDecision: {
            propertyId,
            decision: "enter",
            destinationRouteKey: "pms.workspace",
            reasonCode: null,
          },
        }),
      );
    if (path === "/api/pms/properties")
      return send([
        {
          id: propertyId,
          name: "Synthetic Import Hotel",
          slug: "synthetic",
          location: "Berlin",
          country: "DE",
        },
      ]);
    if (path.endsWith("/profile") && path.includes("hotel-setup")) {
      const data = await (
        await request.get(`${database}/api/hotel-setup/properties/${propertyId}/import`)
      ).json();
      return send(data.profile);
    }
    if (path.endsWith("/property-types"))
      return send({ propertyTypes: [{ value: "hotel", label: "Hotel" }] });
    if (path.endsWith("/public-profile"))
      return send({ publicProfile: { media: [], description: "" } });
    if (path.endsWith("/module-activations"))
      return send({
        hotelId: propertyId,
        canManage: false,
        supportedModules: [],
        activeModules: [],
        activations: [],
      });
    // Unknown requests never escape to another local or remote API.
    return route.fulfill({
      status: 503,
      headers: corsHeaders(route),
      json: { code: "unconfigured_test_api", path },
    });
  });
}

test("import from actual onboarding appears in actual PMS room settings", async ({
  page,
  request,
}, testInfo) => {
  const { propertyId } = await (await request.get(`${database}/api/import-demo`)).json();
  const endpoint = `${database}/api/hotel-setup/properties/${propertyId}/import`;
  const before = await (await request.get(endpoint)).json();
  expect(
    Object.keys(before.import.results),
    "Use a fresh dedicated database; see PRODUCT-PAGES.md",
  ).toHaveLength(0);
  await prepare(page, request, propertyId);
  await page.goto(
    `https://marketplace.localhost:1382/setup?entryProduct=pms&propertyId=${propertyId}`,
  );
  await page.getByRole("button", { name: "Review prepared hotel data" }).click();
  const loft = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("checkbox", { name: /^(Demo Loft|Onboarding Imported Loft)$/ }) })
    .last();
  await loft.getByLabel("Room name", { exact: true }).fill("Onboarding Imported Loft");
  await loft.getByLabel("Maximum guests", { exact: true }).fill("3");
  await loft.getByLabel("Maximum adults", { exact: true }).fill("3");
  await loft.getByLabel("Maximum children", { exact: true }).fill("0");
  await loft.getByRole("combobox", { name: "Bathroom", exact: true }).selectOption("private");
  await loft.getByRole("checkbox", { name: "Onboarding Imported Loft", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Complete each selected room" }),
  ).toContainText("bed type, number of beds");
  await loft.getByRole("combobox", { name: "Bed type", exact: true }).selectOption("queen");
  await loft.getByLabel("Number of beds", { exact: true }).fill("2");
  await loft.getByRole("checkbox", { name: "Onboarding Imported Loft", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(endpoint)).json()).import.results["room:synthetic-loft"]?.status,
    )
    .toBe("applied");
  await page.screenshot({ path: testInfo.outputPath("onboarding-import.png"), fullPage: true });
  await page.goto("https://pms.localhost:1382/rooms");
  await expect(page.getByText("Onboarding Imported Loft", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Review prepared room data" }).click();
  const garden = page
    .locator("div.rounded-lg")
    .filter({
      has: page.getByRole("checkbox", { name: /^(Demo Garden Suite|Settings Imported Suite)$/ }),
    })
    .last();
  await garden.getByLabel("Room name", { exact: true }).fill("Settings Imported Suite");
  await garden.getByRole("checkbox", { name: "Settings Imported Suite", exact: true }).check();
  await page.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByText("Settings Imported Suite", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Onboarding Imported Loft", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Settings Imported Suite", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pms-imported-room.png"), fullPage: true });
  const after = await (await request.get(endpoint)).json();
  expect(after.existingRooms).toHaveLength(before.existingRooms.length + 2);
});

test("room settings recovers a failed refresh without another import", async ({
  page,
  request,
}, testInfo) => {
  const { propertyId } = await (await request.get(`${database}/api/import-demo`)).json();
  const endpoint = `${database}/api/hotel-setup/properties/${propertyId}/import`;
  const before = await (await request.get(endpoint)).json();
  expect(before.existingRooms.length, "Run the product-page import scenario first").toBeGreaterThan(
    0,
  );
  const existingName = before.existingRooms[0].name;
  await prepare(page, request, propertyId);
  let failReads = true;
  let writes = 0;
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    if (!["GET", "OPTIONS"].includes(req.method())) {
      writes++;
      return route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { code: "unexpected_write" },
      });
    }
    if (
      req.method() === "GET" &&
      new URL(req.url()).pathname.endsWith("/room-types") &&
      failReads
    ) {
      return route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { code: "simulated_read_failure" },
      });
    }
    return route.fallback();
  });
  await page.goto("https://pms.localhost:1382/rooms");
  const error = page.getByRole("alert").filter({ hasText: "Some room data could not be loaded" });
  await expect(error).toBeVisible();
  await expect(page.getByText("No room types yet.", { exact: false })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("settings-refresh-failure.png"),
    fullPage: true,
  });
  failReads = false;
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toHaveCount(0);
  await expect(page.getByText(existingName, { exact: true }).first()).toBeVisible();
  expect(writes).toBe(0);
  const after = await (await request.get(endpoint)).json();
  expect(after).toEqual(before);
});
