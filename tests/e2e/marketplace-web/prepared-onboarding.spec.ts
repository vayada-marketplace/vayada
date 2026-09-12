import { expect, test, type Route } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";
async function json(route: Route, body: unknown) {
  if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
  await route.fulfill({ headers: corsHeaders(route), json: body });
}
test("accepted invitation suggests hotel details without creating a property", async ({ page }) => {
  const org = "11111111-1111-4111-8111-111111111111";
  let writes = 0;
  await page.addInitScript(() => {
    localStorage.setItem("userType", "hotel");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    json(route, {
      accessToken: "hotel-test-token",
      csrfToken: "csrf",
      organizationId: org,
      organizationKind: "hotel_group",
      user: {
        id: "owner",
        email: "owner@example.test",
        name: "Hotel Owner",
        phone: "+49301234567",
        profilePictureUrl: "https://example.test/avatar.png",
        profilePictureMediaObjectId: null,
        status: "active",
      },
    }),
  );
  await page.route(/\/api\/hotel-setup\/imports\/prepared/, (route) =>
    json(route, {
      import: {
        sourceId: "invite",
        propertyId: null,
        results: {},
        data: {
          contractVersion: "prepared-hotel-import.v1",
          property: {
            displayName: "Prepared Garden Hotel",
            propertyType: "hotel",
            city: "Berlin",
            countryCode: "DE",
            timezone: "Europe/Berlin",
          },
          rooms: [],
        },
      },
    }),
  );
  await page.route(/\/api\/hotel-setup\/status/, (route) =>
    json(
      route,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: org,
        organizationDisplayName: "Hotel Group",
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        propertyId: null,
      }),
    ),
  );
  await page.route(/\/api\/hotel-setup\/property-types/, (route) =>
    json(route, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    }),
  );
  await page.route(/\/api\/hotel-setup\/properties$/, async (route) => {
    writes++;
    await json(route, {});
  });
  await page.goto("/setup?entryProduct=marketplace&returnProduct=marketplace");
  await expect(page.getByLabel("Hotel name", { exact: true })).toHaveValue("Prepared Garden Hotel");
  await page.getByLabel("Hotel name", { exact: true }).fill("Owner Edited Hotel");
  await expect(page.getByLabel("Hotel name", { exact: true })).toHaveValue("Owner Edited Hotel");
  expect(writes).toBe(0);
});
