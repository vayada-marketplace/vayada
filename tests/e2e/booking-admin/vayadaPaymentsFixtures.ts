import type { Page } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_WINDOWS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const PAYOUT_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/payout-destination`;

/** Payments with vayada Payment chosen for card (VAY-2442 P6). */
export async function mockVayadaPayments(
  page: Page,
  options: {
    available: boolean;
    provider?: "stripe" | "vayada";
    destination?: Record<string, unknown> | null;
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
          ? { available: true, feePercent: 6 }
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
  // Payout account writes, and the page's payment-settings saves.
  return { writes, settingsWrites };
}
