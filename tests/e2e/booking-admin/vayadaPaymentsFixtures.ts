import type { Page } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_WINDOWS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const PAYOUT_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/payout-destination`;
const STATEMENT_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/payout-statement`;

/** A hotel's payout statement (VAY-2584): made-up money, as the design shows it. */
export const PAYOUT_STATEMENT = {
  totals: [
    {
      currency: "IDR",
      nextPayout: {
        on: "2026-11-30",
        cutoff: "2026-11-29",
        amountMinor: "1845000000",
        balanceMinor: "1845000000",
      },
      upcomingMinor: "720000000",
      paidOutMinor: "3410000000",
      firstPaidOn: "2026-11-02",
    },
  ],
  account: { accountLast4: "6789", countryCode: "ID" },
  payouts: [
    payout("p23", "912000000", "6789", "2026-11-23", "sent"),
    payout("p16", "1240000000", "6789", "2026-11-16", "sent"),
    { ...payout("p9", "800000000", "1102", "2026-11-09", "returned"), returnedOn: "2026-11-12" },
    payout("p2", "1258000000", "1102", "2026-11-02", "sent"),
  ],
  lines: [
    line("charge", "320000000", "44800000", "2026-11-24", "VAY-7KQ2C", "2026-11-28", {
      fees: { planMinor: "25600000", vayadaMinor: "19200000", vayadaPercent: 6 },
    }),
    line("payout", "-912000000", "0", "2026-11-23", null, null, { payoutId: "p23" }),
    line("refund", "-150000000", "-12000000", "2026-11-22", "VAY-5MX9P", "2026-11-25"),
    line("dispute", "-240000000", "40500000", "2026-11-21", "VAY-3HD4K", "2026-11-19"),
    line("dispute_fee", "0", "40500000", "2026-11-20", "VAY-1QZ8M", "2026-11-09"),
    line("dispute_reversal", "175000000", "0", "2026-11-15", "VAY-8WE2T", "2026-11-03"),
    line("payout_returned", "800000000", "0", "2026-11-12", null, null, { payoutId: "p9" }),
  ],
};

function payout(
  id: string,
  amountMinor: string,
  accountLast4: string,
  day: string,
  status: string,
) {
  return {
    id,
    currency: "IDR",
    amountMinor,
    accountLast4,
    startedOn: day,
    paidOn: day,
    returnedOn: null,
    status,
  };
}

function line(
  kind: string,
  grossMinor: string,
  feeMinor: string,
  day: string,
  bookingReference: string | null,
  checkOut: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `${kind}-${day}`,
    kind,
    currency: "IDR",
    grossMinor,
    feeMinor,
    netMinor: String(BigInt(grossMinor) - BigInt(feeMinor)),
    bookingReference,
    checkOut,
    occurredAt: `${day}T08:00:00Z`,
    fees: null,
    payoutId: null,
    ...extra,
  };
}

/** The statement route: a statement, or a refusal (403 not the owner, 404 no vayada Payment). */
export async function mockPayoutStatement(
  page: Page,
  answer: typeof PAYOUT_STATEMENT | 403 | 404 = PAYOUT_STATEMENT,
) {
  await page.route(`**${STATEMENT_PATH}`, (route) =>
    typeof answer === "number"
      ? route.fulfill({
          status: answer,
          json: { code: answer === 403 ? "forbidden" : "vayada_payment_unavailable" },
        })
      : route.fulfill({ json: answer }),
  );
}

/** Payments with vayada Payment chosen for card (VAY-2442 P6). */
export async function mockVayadaPayments(
  page: Page,
  options: {
    available: boolean;
    /** On the stop list: no new card charges, the setup stays manageable (VAY-2570). */
    stopped?: boolean;
    provider?: "stripe" | "vayada";
    destination?: Record<string, unknown> | null;
    /** The owner's statement behind the Payments link (VAY-2584); none by default. */
    statement?: typeof PAYOUT_STATEMENT;
  },
) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "finance-route-contracts.v1",
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        paymentSettings: {
          paymentsEnabled: true,
          paymentProvider: options.provider ?? (options.available ? "vayada" : "stripe"),
          acceptedMethods: ["card", "pay_at_property"],
          defaultCurrency: "IDR",
          supportedCurrencies: ["IDR"],
          requiresManualReview: false,
          providerAccount: {
            providerAccountId: null,
            provider: null,
            status: "not_configured",
            onboardingStatus: "not_started",
            chargesEnabled: false,
            payoutsEnabled: false,
            capabilities: [],
          },
        },
        vayadaPayment: options.available
          ? { available: true, feePercent: 6, ...(options.stopped ? { stopped: true } : {}) }
          : { available: false },
      },
    }),
  );
  // The page's one Save waits for the booking windows (VAY-2424).
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_WINDOWS_PATH}`, (route) =>
    route.fulfill({
      json: { propertyId: BOOKING_ADMIN_PROPERTY_ID, paymentDeadlineHours: 48, windows: {} },
    }),
  );
  const writes: Record<string, unknown>[] = [];
  const settingsWrites: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/payment-settings"))
      settingsWrites.push(request.postDataJSON() as Record<string, unknown>);
  });
  let destination = options.destination ?? null;
  await page.route(`**${PAYOUT_PATH}`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(body);
      destination =
        body.action === "delete"
          ? { ...destination, enabled: false, deleted: true, maskedAccount: null, version: 2 }
          : {
              id: "d0000000-0000-4000-8000-000000000001",
              revision: 1,
              version: 1,
              enabled: true,
              deleted: false,
              countryCode: body.countryCode,
              maskedAccount: "•••• 6789",
            };
    }
    await route.fulfill({ json: { destination } });
  });
  await mockPayoutStatement(page, options.statement ?? 404);
  // Payout account writes, and the page's payment-settings saves.
  return { writes, settingsWrites };
}
