import { expect, test, type Page, type Route } from "@playwright/test";

// The hotel invitation page in Booking Admin (VAY-2262), with the API mocked.
const inviteCode = "VAY-browser-invite-1050";

const lookup = {
  contractVersion: "hotel-account-invite.v1",
  identity: { emailHint: "o****@example.test" },
  organization: { displayName: "Alpenrose Hospitality" },
  property: { displayName: "Hotel Alpenrose" },
  selectedTracks: ["hotel_operations"],
  handoffPath: "/setup",
  expiresAt: "2027-01-20T12:00:00.000Z",
};

const hotelSession = {
  accessToken: "test-access-token",
  csrfToken: "test-csrf-token",
  organizationId: "org_hotel_group",
  resources: { hotel: ["booking_hotel_alpenrose"] },
  user: { id: "user_hotel", email: "owner@example.test", status: "active" },
};

type InviteRequest = { path: string; body: unknown; authorization?: string };

// The invite API lives on the API origin, so the browser preflights its JSON POSTs.
function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "POST,OPTIONS",
  };
}

function fulfillCorsPreflight(route: Route) {
  return route.fulfill({ status: 204, headers: corsHeaders(route) });
}

async function mockInviteApi(page: Page, requests: InviteRequest[], lookupStatus = 200) {
  await page.route(/\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const url = new URL(route.request().url());
    requests.push({
      path: url.pathname,
      body: route.request().postDataJSON(),
      authorization: route.request().headers().authorization,
    });
    if (url.pathname.endsWith("/lookup")) {
      return route.fulfill({
        status: lookupStatus,
        headers: corsHeaders(route),
        json:
          lookupStatus === 200
            ? lookup
            : { code: "invite_not_available", detail: "This hotel account invitation is invalid." },
      });
    }
    return route.fulfill({
      headers: corsHeaders(route),
      json: {
        contractVersion: "hotel-account-invite.v1",
        status: "redeemed",
        selectedTracks: lookup.selectedTracks,
        handoffPath: "/setup",
      },
    });
  });
}

test("a signed-out owner sees the invitation and the way to create or open the account", async ({
  page,
}) => {
  const requests: InviteRequest[] = [];
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await mockInviteApi(page, requests);
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, json: { error: "missing_session" } }),
  );

  await page.goto(`/invite#code=${inviteCode}`);

  await expect(page.getByRole("heading", { name: "Hotel Alpenrose" })).toBeVisible();
  await expect(page.getByText("Alpenrose Hospitality")).toBeVisible();
  await expect(page.getByText("o****@example.test")).toBeVisible();
  await expect(page.getByText("Hotel Operations", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create hotel account" })).toHaveAttribute(
    "href",
    "/signup",
  );
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/login?returnTo=%2Finvite",
  );
  // The code travels in the fragment and session storage only, never in a request URL.
  expect(page.url().endsWith("/invite")).toBe(true);
  expect(requestedUrls.some((url) => url.includes(inviteCode))).toBe(false);
  expect(requests).toEqual([
    {
      path: "/api/marketplace/hotel-account-invites/lookup",
      body: { code: inviteCode },
      authorization: undefined,
    },
  ]);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("vayada.hotel-account-invite.v1")))
    .toBe(inviteCode);
});

test("a signed-in owner accepts the invitation and is handed to setup", async ({ page }) => {
  const requests: InviteRequest[] = [];
  let onboarding: { body: unknown; csrf?: string } | null = null;
  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  await mockInviteApi(page, requests);
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({ json: hotelSession }),
  );
  await page.route("**/auth/onboarding", (route) => {
    onboarding = {
      body: route.request().postDataJSON(),
      csrf: route.request().headers()["x-vayada-csrf"],
    };
    return route.fulfill({ json: { ...hotelSession, organizationId: "org_invited_hotel" } });
  });
  // Booking Admin's /setup forwards to the setup host; keep the browser inside the test.
  await page.route("**/setup?**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Setup host</h1>" }),
  );

  await page.goto(`/invite#code=${inviteCode}`);
  await expect(page.getByRole("heading", { name: "Hotel Alpenrose" })).toBeVisible();
  await page.getByRole("button", { name: "Accept and continue to setup" }).click();

  await expect(page.getByRole("heading", { name: "Setup host" })).toBeVisible();
  expect(visited.some((url) => url.endsWith("/setup?entryProduct=pms&returnProduct=pms"))).toBe(
    true,
  );
  expect(onboarding).toEqual({
    body: { type: "hotel", surface: "booking-admin", inviteCode },
    csrf: "test-csrf-token",
  });
  expect(requests.find((request) => request.path.endsWith("/redeem"))).toEqual({
    path: "/api/marketplace/hotel-account-invites/redeem",
    body: { code: inviteCode },
    authorization: "Bearer test-access-token",
  });
  expect(
    await page.evaluate(() => sessionStorage.getItem("vayada.hotel-account-invite.v1")),
  ).toBeNull();
});

test("an unknown code shows the manual entry form and checks a typed code", async ({ page }) => {
  const requests: InviteRequest[] = [];
  await mockInviteApi(page, requests, 404);
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    route.fulfill({ status: 401, json: { error: "missing_session" } }),
  );

  await page.goto(`/invite#code=${inviteCode}`);
  await expect(page.getByRole("heading", { name: "Open your hotel invitation" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "invalid, expired, revoked, or already used",
  );

  await page.getByLabel("Invitation code").fill("nope");
  await page.getByRole("button", { name: "Check invitation" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Enter the complete invitation code.",
  );

  await page.getByLabel("Invitation code").fill("VAY-typed-code-77");
  await page.getByRole("button", { name: "Check invitation" }).click();
  await expect
    .poll(() => requests.filter((request) => request.path.endsWith("/lookup")).length)
    .toBe(2);
  expect(requests[1]?.body).toEqual({ code: "VAY-typed-code-77" });
});
