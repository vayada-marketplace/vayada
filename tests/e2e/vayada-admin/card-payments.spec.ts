import { expect, test, type Page, type Route } from "@playwright/test";

// VAY-2205 P2.2: Vayada finance turns card payments on or off per hotel on its Payments tab (Paper
// "VAY-2205 card refunds + card switch", approved by Flamur on 2026-10-18). Either change publishes
// the hotel's prices again by itself (VAY-2304); only when it can't must the hotel save them.
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

const off = (ready = true, prices = "current") => ({
  propertyId,
  providerAccount: { ready, cardCapabilityRevision: 3 },
  propertyReadinessRevision: 7,
  paymentSettings: { paymentsOn: true, cardChosen: true, currencyEligible: true },
  evidence: null,
  cardReady: false,
  prices,
});
// Right after a change the server has published the hotel's prices again (VAY-2304).
const on = {
  ...off(),
  evidence: {
    evidenceId,
    acceptedAt: "2026-10-18T19:40:00.000Z",
    acceptedByUserId: approverId,
    current: true,
  },
  cardReady: true,
};

test("turns card payments on as vayada's approval, then off, each time with the prices published again", async ({
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
  // Escape closes the confirm without sending anything.
  await card.getByRole("button", { name: "Turn on card payments" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.getByRole("button", { name: "Turn on card payments" }).click();
  const confirmOn = page.getByRole("dialog", {
    name: "Turn on card payments for Hotel Alpenrose Munich?",
  });
  await expect(confirmOn.getByText(/This is vayada's approval\./)).toBeVisible();
  await expect(
    confirmOn.getByText(
      /The system then publishes the hotel's prices again by itself, now with card\. If it can't, this page says so and the hotel saves them\. Tell the hotel that card is on\./,
    ),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("payments-turn-on-confirm.png"),
    fullPage: true,
  });
  expect(accepted).toBeNull();
  await confirmOn.getByRole("button", { name: "Turn on card payments" }).click();

  await expect(
    page.getByText("Card payments are on. The hotel's prices are published again, now with card."),
  ).toBeVisible();
  await expect(
    page.getByText("The hotel's prices couldn't be published again by themselves."),
  ).toHaveCount(0);
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect(card.getByText(/Given .* by Mara Vogel\./)).toBeVisible();
  // The page names the revisions it showed; the server records the time and the fingerprint.
  expect(accepted).toEqual({
    commandId: expect.any(String),
    idempotencyKey: expect.any(String),
    expectedCardCapabilityRevision: 3,
    expectedPropertyReadinessRevision: 7,
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
  await expect(
    confirmOff.getByText(/Rates with no other ready payment method stop selling\./),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("payments-turn-off-confirm.png"),
    fullPage: true,
  });
  await confirmOff.getByRole("button", { name: "Turn off card payments" }).click();
  await expect(
    page.getByText(
      "Card payments are off. The hotel's prices are published again; rates with no other ready payment method stopped selling.",
    ),
  ).toBeVisible();
  await expect(card.getByText("Not given. Turning card payments on gives it again.")).toBeVisible();
  expect(revoked).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("payments-turned-off.png"), fullPage: true });
});

// VAY-2205: a refused change used to vanish, because the reload after it cleared the message.
test("says why turning card on failed, in the server's words, and keeps it after the reload", async ({
  page,
  baseURL,
}) => {
  // After the failure the server answers a different state (prices to save), so the reload shows.
  let failed = false;
  const origin = await openPayments(page, baseURL, () =>
    failed ? off(true, "save_needed") : off(),
  );
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await page.route(
    api(`/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      failed = true;
      await fulfillJson(
        route,
        origin,
        {
          statusCode: 400,
          code: "invalid_command",
          category: "validation",
          message: "Online-card execution evidence is invalid.",
        },
        400,
      );
    },
  );
  await expect(
    page.getByText("The hotel's prices couldn't be published again by themselves."),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Turn on card payments" }).click();
  await page
    .getByRole("dialog", { name: "Turn on card payments for Hotel Alpenrose Munich?" })
    .getByRole("button", { name: "Turn on card payments" })
    .click();
  await expect(card.getByRole("alert")).toHaveText(
    "That didn't go through: Online-card execution evidence is invalid. (invalid_command)",
  );
  // The reload after the failure has landed, and the message stayed.
  await expect(
    page.getByText("The hotel's prices couldn't be published again by themselves."),
  ).toBeVisible();
  await expect(card.getByRole("alert")).toHaveText(
    "That didn't go through: Online-card execution evidence is invalid. (invalid_command)",
  );
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
});

// VAY-2304: the status claims re-published prices only when the server confirms them current.
test("turning card on for a hotel that never published says nothing about its prices", async ({
  page,
  baseURL,
}) => {
  let current: unknown = off(true, "not_published");
  const origin = await openPayments(page, baseURL, () => current);
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await page.route(
    api(`/api/finance/platform/properties/${propertyId}/online-card-execution-evidence`),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      current = { ...on, prices: "not_published" };
      await fulfillJson(route, origin, { ok: true }, 201);
    },
  );
  await card.getByRole("button", { name: "Turn on card payments" }).click();
  await page
    .getByRole("dialog", { name: "Turn on card payments for Hotel Alpenrose Munich?" })
    .getByRole("button", { name: "Turn on card payments" })
    .click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Card payments are on." })).toHaveText(
    "Card payments are on.",
  );
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

test("can't turn card on before the hotel chooses card in its payment settings", async ({
  page,
  baseURL,
}) => {
  await openPayments(page, baseURL, () => ({
    ...off(),
    paymentSettings: { paymentsOn: true, cardChosen: false, currencyEligible: true },
  }));
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(
    card.getByText("Not yet. The hotel turns on payments with card in its payment settings."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Turn on card payments" })).toBeDisabled();
  await expect(
    card.getByText("Possible once the hotel chooses card in its payment settings."),
  ).toBeVisible();
});

test("asks for the prices to be saved when the system couldn't publish them again", async ({
  page,
  baseURL,
}) => {
  await openPayments(page, baseURL, () => ({ ...on, prices: "save_needed" }));
  await expect(
    page.getByText("The hotel's prices couldn't be published again by themselves."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Card is on, but this hotel's booking page takes no bookings until its prices are saved again.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open the hotel's Prices in the PMS/ }),
  ).toHaveAttribute("href", /\/rooms$/);
});

test("an approval whose Stripe account changed since is out of date, and turning off clears it", async ({
  page,
  baseURL,
}) => {
  await openPayments(page, baseURL, () => ({
    ...on,
    evidence: { ...on.evidence, current: false },
    cardReady: false,
    prices: "current",
  }));
  const card = page.getByRole("region", { name: "Card payments" });
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await expect(
    card.getByText(/Out of date: the hotel's Stripe account or payment settings changed since\./),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Turn off card payments" })).toBeEnabled();
  await expect(card.getByRole("button", { name: "Turn on card payments" })).toHaveCount(0);
});
