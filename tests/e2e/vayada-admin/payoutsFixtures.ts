import type { Page, Route } from "@playwright/test";

// VAY-2442 P5: mocked payouts API answers for the Vayada Admin Payouts page specs.
export const ubud = "11111111-1111-4111-8111-111111111111";
export const startedPayoutId = "bbbbbbbb-0000-4000-8000-000000000001";
export const payoutsFixture = {
  mode: "live",
  cutoff: "2026-11-08",
  hotels: [
    {
      propertyId: ubud,
      name: "Villa Lumbung Ubud",
      currency: "IDR",
      payableMinor: "125000050",
      payNowMinor: "125000000",
      upcomingMinor: "48000000",
      destination: {
        id: "d0000000-0000-4000-8000-000000006789",
        accountLast4: "6789",
        countryCode: "ID",
      },
      sending: null,
      lastPayout: {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        amountMinor: "98000000",
        paidOn: "2026-11-02",
        reference: "WISE-48211907",
      },
    },
    {
      propertyId: "22222222-2222-4222-8222-222222222222",
      name: "Kandy Hills Retreat",
      currency: "LKR",
      payableMinor: "0",
      payNowMinor: "0",
      upcomingMinor: "6200000",
      destination: {
        id: "d0000000-0000-4000-8000-000000001234",
        accountLast4: "1234",
        countryCode: "LK",
      },
      sending: {
        id: "aaaaaaaa-0000-4000-8000-000000000009",
        amountMinor: "18450000",
        startedAt: "2026-11-09T08:40:00Z",
      },
      lastPayout: null,
    },
    {
      propertyId: "33333333-3333-4333-8333-333333333333",
      name: "Ella Rock Cabins",
      currency: "LKR",
      payableMinor: "-450000",
      payNowMinor: "0",
      upcomingMinor: "2300000",
      destination: {
        id: "d0000000-0000-4000-8000-000000005521",
        accountLast4: "5521",
        countryCode: "LK",
      },
      sending: null,
      lastPayout: {
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        amountMinor: "9100000",
        paidOn: "2026-11-02",
        reference: "WISE-48211955",
      },
    },
    {
      propertyId: "44444444-4444-4444-8444-444444444444",
      name: "Canggu Surf House",
      currency: "IDR",
      payableMinor: "36000000",
      payNowMinor: "36000000",
      upcomingMinor: "0",
      destination: null,
      sending: null,
      lastPayout: null,
    },
    {
      propertyId: "55555555-5555-4555-8555-555555555555",
      name: "Sidemen Rice Terraces",
      currency: "IDR",
      payableMinor: "0",
      payNowMinor: "0",
      upcomingMinor: "15500000",
      destination: {
        id: "d0000000-0000-4000-8000-000000000042",
        accountLast4: "0042",
        countryCode: "ID",
      },
      sending: null,
      lastPayout: {
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        amountMinor: "61500000",
        paidOn: "2026-11-02",
        reference: "BCA-77120",
      },
    },
  ],
};
export const ubudDetail = {
  mode: "live",
  cutoff: "2026-11-08",
  propertyId: ubud,
  name: "Villa Lumbung Ubud",
  balances: [payoutsFixture.hotels[0]],
  destination: {
    id: "d0000000-0000-4000-8000-000000006789",
    accountLast4: "6789",
    countryCode: "ID",
  },
  payouts: [
    {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      currency: "IDR",
      amountMinor: "98000000",
      cutoff: "2026-11-01",
      accountLast4: "6789",
      startedAt: "2026-11-02T09:05:00Z",
      reference: "WISE-48211907",
      paidOn: "2026-11-02",
      sentAt: "2026-11-02T09:12:00Z",
      returnedAt: null,
      returnReason: null,
    },
  ],
  // Checked out by Sunday 8 Nov: 980,000 − 980,000 (last payout) + 168,000 − 90,000 + 1,172,000.50
  // = 1,250,000.50 owed, 1,250,000 to pay now; the stay checking out on the 14th waits.
  entries: [
    [
      "e1",
      "charge",
      "139523900",
      "22323850",
      "117200050",
      "VAY-7H2K9Q",
      "2026-11-06",
      "2026-11-06T11:00:00Z",
    ],
    [
      "e2",
      "refund",
      "-10000000",
      "-1000000",
      "-9000000",
      "VAY-3MZ81C",
      "2026-11-04",
      "2026-11-03T08:00:00Z",
    ],
    ["e3", "payout", "-98000000", "0", "-98000000", null, null, "2026-11-02T09:12:00Z"],
    [
      "e4",
      "charge",
      "20000000",
      "3200000",
      "16800000",
      "VAY-3MZ81C",
      "2026-11-04",
      "2026-11-01T12:00:00Z",
    ],
    [
      "e5",
      "charge",
      "57142900",
      "9142900",
      "48000000",
      "VAY-Q8D4TX",
      "2026-11-14",
      "2026-10-30T16:20:00Z",
    ],
    [
      "e6",
      "charge",
      "116666700",
      "18666700",
      "98000000",
      "VAY-K2P7LM",
      "2026-10-31",
      "2026-10-28T15:00:00Z",
    ],
  ].map(([id, kind, grossMinor, feeMinor, netMinor, bookingReference, checkOut, occurredAt]) => ({
    id,
    kind,
    currency: "IDR",
    grossMinor,
    feeMinor,
    netMinor,
    bookingReference,
    checkOut,
    occurredAt,
  })),
};

export const api = (path: string) =>
  new RegExp(`https://api\\.localhost(?::\\d+)?${path.replace(/[?]/g, "\\?")}(?:\\?.*)?$`);

export async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
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

/** Signs in a platform admin and answers every other API read empty. */
export async function signIn(page: Page, baseURL: string | undefined) {
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
  await page.route(/https:\/\/api\.localhost(?::\d+)?\/.*/, (route) =>
    fulfillJson(route, origin, {}),
  );
  return { adminBaseURL, origin };
}

/** The payouts API as it answers with vayada Payment on. */
export async function mockPayouts(page: Page, origin: string, list = payoutsFixture) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  await page.route(api("/api/finance/platform/vayada-payment/payouts"), (route) =>
    fulfillJson(route, origin, {
      ...list,
      mode: new URL(route.request().url()).searchParams.get("mode") ?? "live",
    }),
  );
  await page.route(api(`/api/finance/platform/vayada-payment/payouts/${ubud}`), (route) =>
    route.request().method() === "GET" ? fulfillJson(route, origin, ubudDetail) : route.fallback(),
  );
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${ubud}/destination/reveal`),
    (route) =>
      fulfillJson(route, origin, {
        destinationId: "d0000000-0000-4000-8000-000000006789",
        countryCode: "ID",
        accountHolder: "PT Lumbung Ubud Lestari",
        accountNumber: "8730 1122 6789",
        bankName: "Bank Central Asia (BCA)",
        bankCode: "014",
        branchCode: "",
        bicSwift: "CENAIDJA",
        holderAddress: "",
      }),
  );
  await page.route(api(`/api/finance/platform/vayada-payment/payouts/${ubud}`), (route) =>
    route.request().method() === "POST"
      ? fulfillJson(route, origin, { payoutId: startedPayoutId }, 201)
      : route.fallback(),
  );
  await page.route(
    api(`/api/finance/platform/vayada-payment/payouts/${ubud}/${startedPayoutId}/sent`),
    (route) => fulfillJson(route, origin, { sent: true }),
  );
  return posts;
}
