import { expect, test, type Page, type Route } from "@playwright/test";

// VAY-2205 P2.2: Vayada finance sees a hotel's card payments on its Payments tab. Read only since
// VAY-2442 (Flamur, 2026-11-03): card works as soon as the hotel's own steps are done, with no
// Vayada approval, so there is nothing to turn on or off here.
const propertyId = "11111111-1111-4111-8111-111111111111";
const api = (path: string) =>
  new RegExp(`https://api\\.localhost(?::\\d+)?${path.replace(/[?]/g, "\\?")}(?:\\?.*)?$`);

async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function openPayments(page: Page, baseURL: string | undefined, state: () => unknown) {
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const origin = new URL(adminBaseURL).origin;
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_platform_admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({
        id: "user_platform_admin",
        email: "platform-admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
  // The other tabs' reads answer empty; this spec is about Payments.
  await page.route(/https:\/\/api\.localhost(?::\d+)?\/.*/, (route) =>
    fulfillJson(route, origin, {}),
  );
  await page.route(api("/api/platform/admin/growth"), (route) =>
    fulfillJson(route, origin, {
      properties: [
        {
          id: propertyId,
          name: "Hotel Alpenrose Munich",
          slug: "hotel-alpenrose-munich",
          status: "live",
          lifecycleStatus: "active",
          lifecycleRevision: 4,
          ownerAccountUserIds: [],
          createdAt: "2026-08-13T12:00:00.000Z",
        },
      ],
    }),
  );
  await page.route(
    api(`/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`),
    (route) =>
      route.request().method() === "GET" ? fulfillJson(route, origin, state()) : route.fallback(),
  );
  await page.goto(new URL(`/dashboard/hotels/${propertyId}`, adminBaseURL).toString());
  await expect(page.getByRole("heading", { name: "Hotel Alpenrose Munich" })).toBeVisible();
  await page.getByRole("button", { name: "Payments", exact: true }).click();
  return origin;
}

const state = (change: Record<string, unknown> = {}) => ({
  propertyId,
  providerAccount: { ready: true, cardCapabilityRevision: 3 },
  propertyReadinessRevision: 7,
  paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: true },
  evidence: null,
  cardReady: true,
  prices: "current",
  ...change,
});

test("card is on once the hotel's own steps are done, with no vayada approval and no switch", async ({
  page,
  baseURL,
}, testInfo) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("online-card-execution-evidence"))
      writes.push(request.url());
  });
  await openPayments(page, baseURL, () => state());
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect(card).toContainText("Guests can pay by card on this hotel's booking page.");
  for (const step of [
    "Payment account linked",
    "Ready to take cards",
    "Card chosen in the hotel's payment settings",
  ])
    await expect(card.getByText(step, { exact: true })).toBeVisible();
  await expect(card).not.toContainText("approval");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card).toContainText(
    "To stop card payments for this hotel, the hotel turns card off in its payment settings.",
  );
  await page.screenshot({ path: testInfo.outputPath("vay2442-card-on.png"), fullPage: true });
  expect(writes).toEqual([]);
});

test("says which of the hotel's own steps is still missing", async ({
  page,
  baseURL,
}, testInfo) => {
  let current = state({ cardReady: false, providerAccount: null });
  await openPayments(page, baseURL, () => current);
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await expect(card).toContainText(
    "Guests can pay by card on this hotel's booking page as soon as the hotel finishes these steps. vayada doesn't need to approve it.",
  );
  await expect(card).toContainText("Not yet. The hotel does this in its payment settings.");
  await page.screenshot({ path: testInfo.outputPath("vay2442-card-off.png"), fullPage: true });

  current = state({
    cardReady: false,
    providerAccount: { ready: false, cardCapabilityRevision: 2 },
  });
  await page.reload();
  await page.getByRole("button", { name: "Payments", exact: true }).click();
  await expect(card).toContainText(
    "The hotel connected its Stripe account, or saved its bank account for vayada Payment, in its payment settings.",
  );
  await expect(card).toContainText(
    "Not yet. The hotel still has to finish its Stripe setup, or save its bank account for vayada Payment.",
  );

  current = state({
    cardReady: false,
    paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: false },
  });
  await page.reload();
  await page.getByRole("button", { name: "Payments", exact: true }).click();
  await expect(card).toContainText("The hotel's currency can't take card payments.");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("asks for the prices to be saved when the system couldn't publish them again", async ({
  page,
  baseURL,
}) => {
  await openPayments(page, baseURL, () => state({ prices: "save_needed" }));
  await expect(
    page.getByText("The hotel's prices couldn't be published again by themselves."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the hotel's Prices in the PMS" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Card payments" })).toContainText(
    "Card is on, but this hotel's booking page takes no bookings until its prices are saved again.",
  );
});

test("an approval from before VAY-2442 changes nothing on the page", async ({ page, baseURL }) => {
  await openPayments(page, baseURL, () =>
    state({
      evidence: {
        evidenceId: "22222222-2222-4222-8222-222222222222",
        acceptedAt: "2026-10-18T19:40:00.000Z",
        acceptedByUserId: "33333333-3333-4333-8333-333333333333",
        current: false,
      },
    }),
  );
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect(card).not.toContainText("approval");
  await expect(card).not.toContainText("Out of date");
});
