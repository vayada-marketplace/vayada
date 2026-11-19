import { expect, test, type Route } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

// VAY-2436: a hotel connects a partner app once on Booking Admin's approval page, and disconnects it
// in Settings › Connected apps.
const alpina = "a0000000-0000-4000-8000-000000000001";
const seeblick = "b0000000-0000-4000-8000-000000000002";
const authorizeQuery = new URLSearchParams({
  response_type: "code",
  client_id: "partner_abc",
  redirect_uri: "https://partner.example/callback",
  scope: "promo_codes bookings",
  state: "state-123",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
});

const headers = (route: Route) => ({
  "access-control-allow-credentials": "true",
  "access-control-allow-headers":
    "authorization, content-type, x-vayada-csrf, x-vayada-omit-hotel-context",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-origin": route.request().headers().origin ?? "http://127.0.0.1:3003",
  "content-type": "application/json",
});

test("a hotel with two properties picks one, switches on Promos and is sent back to the app with a code", async ({
  page,
}, testInfo) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const decisions: unknown[] = [];
  const promoSwitches: string[] = [];
  await page.route("**/api/booking/partner-authorizations**", async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: headers(route) });
    if (method === "POST") {
      decisions.push(route.request().postDataJSON());
      return route.fulfill({
        headers: headers(route),
        json: { redirectTo: "https://partner.example/callback?code=vyp_ac_x&state=state-123" },
      });
    }
    expect(new URL(route.request().url()).searchParams.get("client_id")).toBe("partner_abc");
    return route.fulfill({
      headers: headers(route),
      json: {
        app: { name: "Partner Test App" },
        scopes: ["promo_codes", "bookings"],
        properties: [
          { propertyId: alpina, name: "Hotel Alpina", promoCodesEnabled: true },
          { propertyId: seeblick, name: "Seeblick", promoCodesEnabled: false },
        ],
      },
    });
  });
  await page.route("**/api/pms/properties/*/booking-modules/promos", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: headers(route) });
    promoSwitches.push(route.request().url());
    return route.fulfill({
      headers: headers(route),
      json: {
        moduleId: "promos",
        isActive: true,
        activatedAt: null,
        deactivatedAt: null,
        updatedAt: "2026-11-20T10:00:00.000Z",
      },
    });
  });
  await page.route("https://partner.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Back at the partner</h1>" }),
  );

  const response = await page.goto(`/partner/oauth/authorize?${authorizeQuery}`);
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: "Connect Partner Test App" })).toBeVisible();
  await expect(
    page.getByText(
      "Allow Partner Test App to make discount codes and see the bookings that use them?",
    ),
  ).toBeVisible();
  await expect(page.getByText(/No guest names or contact details\./)).toBeVisible();
  await page.getByLabel("Hotel").selectOption(seeblick);
  const turnOn = page.getByRole("checkbox", { name: /Switch on Promos for this hotel/ });
  await expect(turnOn).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("partner-authorize.png"), fullPage: true });

  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL("https://partner.example/callback?code=vyp_ac_x&state=state-123");
  expect(promoSwitches).toEqual([
    expect.stringContaining(`/api/pms/properties/${seeblick}/booking-modules/promos`),
  ]);
  expect(decisions).toEqual([
    {
      authorization: Object.fromEntries(authorizeQuery),
      decision: "allow",
      propertyId: seeblick,
    },
  ]);
});

test("Settings › Connected apps lists the app and Disconnect removes it", async ({
  page,
}, testInfo) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const connectionId = "c0000000-0000-4000-8000-000000000003";
  let connected = true;
  const deletes: string[] = [];
  await page.route(
    `**/api/booking/properties/${BOOKING_ADMIN_PROPERTY_ID}/partner-connections**`,
    async (route) => {
      const method = route.request().method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: headers(route) });
      if (method === "DELETE") {
        deletes.push(route.request().url());
        connected = false;
        return route.fulfill({ status: 204, headers: headers(route) });
      }
      return route.fulfill({
        headers: headers(route),
        json: {
          canManage: true,
          connections: connected
            ? [
                {
                  connectionId,
                  appName: "Partner Test App",
                  scopes: ["promo_codes", "bookings"],
                  approvedAt: "2026-11-20T10:00:00.000Z",
                  approvedByName: "Anna Keller",
                },
              ]
            : [],
        },
      });
    },
  );

  await page.goto("/settings");
  await page
    .getByRole("main")
    .getByRole("link", { name: /^Connected apps/ })
    .click();
  await expect(page).toHaveURL(/\/settings\/connected-apps$/);
  await expect(page.getByRole("heading", { name: "Connected apps", level: 1 })).toBeVisible();
  await expect(page.getByText("Partner Test App", { exact: true })).toBeVisible();
  await expect(page.getByText(/Connected on .* by Anna Keller/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connected-apps.png"), fullPage: true });

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnect Partner Test App?")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).last().click();
  await expect(page.getByText("Partner Test App is disconnected.")).toBeVisible();
  await expect(page.getByText("No apps are connected to this hotel.")).toBeVisible();
  expect(deletes).toEqual([expect.stringContaining(`/partner-connections/${connectionId}`)]);
});
