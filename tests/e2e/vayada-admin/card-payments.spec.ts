import { expect, test, type Page, type Route } from "@playwright/test";

// VAY-2205 P2.2: Vayada finance turns card payments on or off per hotel on its Payments tab (Paper
// "VAY-2205 card refunds + card switch", approved by Flamur on 2026-10-18). Either change means the
// hotel's prices must be saved again.
const propertyId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const approverId = "33333333-3333-4333-8333-333333333333";
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
  await page.route(api(`/api/identity/admin/users/${approverId}`), (route) =>
    fulfillJson(route, origin, { id: approverId, email: "mara@vayada.test", name: "Mara Vogel" }),
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

const off = (ready = true) => ({
  propertyId,
  providerAccount: { ready, cardCapabilityRevision: 3 },
  propertyReadinessRevision: 7,
  evidence: null,
  cardReady: false,
});
const on = {
  ...off(),
  evidence: { evidenceId, acceptedAt: "2026-10-18T19:40:00.000Z", acceptedByUserId: approverId },
  cardReady: true,
};

test("turns card payments on as vayada's approval, then off, each time asking for prices to be saved again", async ({
  page,
  baseURL,
}, testInfo) => {
  let current: unknown = off();
  const origin = await openPayments(page, baseURL, () => current);
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await expect(card.getByText("Not given. You give it by turning card payments on.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("payments-ready.png"), fullPage: true });

  let accepted: Record<string, unknown> | null = null;
  await page.route(
    api(`/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      accepted = route.request().postDataJSON();
      current = on;
      await fulfillJson(route, origin, { ok: true }, 201);
    },
  );
  await card.getByRole("button", { name: "Turn on card payments" }).click();
  const confirmOn = page.getByRole("dialog", {
    name: "Turn on card payments for Hotel Alpenrose Munich?",
  });
  await expect(confirmOn.getByText(/This is vayada's approval\./)).toBeVisible();
  await expect(
    confirmOn.getByText(
      /The hotel's prices must be saved again before its booking page takes bookings\. Tell the hotel first\./,
    ),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("payments-turn-on-confirm.png"),
    fullPage: true,
  });
  expect(accepted).toBeNull();
  await confirmOn.getByRole("button", { name: "Turn on card payments" }).click();

  await expect(
    page.getByText("Card payments are on. The hotel's prices must be saved again."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open the hotel's Prices in the PMS/ }),
  ).toHaveAttribute("href", /\/rooms$/);
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect(card.getByText(/Given .* by Mara Vogel\./)).toBeVisible();
  expect(accepted).toMatchObject({
    expectedCardCapabilityRevision: 3,
    expectedPropertyReadinessRevision: 7,
    evidenceFingerprintHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  await page.screenshot({ path: testInfo.outputPath("payments-on.png"), fullPage: true });

  let revoked = false;
  await page.route(
    api(
      `/api/finance/platform/properties/${propertyId}/online-card-execution-evidence/${evidenceId}/revoke`,
    ),
    async (route) => {
      revoked = true;
      current = off();
      await fulfillJson(route, origin, { ok: true });
    },
  );
  await card.getByRole("button", { name: "Turn off card payments" }).click();
  const confirmOff = page.getByRole("dialog", {
    name: "Turn off card payments for Hotel Alpenrose Munich?",
  });
  await expect(confirmOff.getByText(/Rates that only take card stop selling\./)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("payments-turn-off-confirm.png"),
    fullPage: true,
  });
  await confirmOff.getByRole("button", { name: "Turn off card payments" }).click();
  await expect(
    page.getByText("Card payments are off. The hotel's prices must be saved again."),
  ).toBeVisible();
  await expect(card.getByText("Not given. Turning card payments on gives it again.")).toBeVisible();
  expect(revoked).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("payments-turned-off.png"), fullPage: true });
});

test("can't turn card on before the hotel's Stripe account is ready", async ({
  page,
  baseURL,
}, testInfo) => {
  await openPayments(page, baseURL, () => off(false));
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(
    card.getByText("Not yet. The hotel still has to finish its Stripe setup."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Turn on card payments" })).toBeDisabled();
  await expect(card.getByText("Possible once the hotel's Stripe account is ready.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("payments-not-ready.png"), fullPage: true });
});
