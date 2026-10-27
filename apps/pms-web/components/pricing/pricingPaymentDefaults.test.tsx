import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPaymentSettings } = vi.hoisted(() => ({ getPaymentSettings: vi.fn() }));
vi.mock("@/services/bookings", () => ({ bookingsService: { getPaymentSettings } }));

import { paymentSettingsDefaults } from "./pricingPaymentDefaults";

const settings = (paymentSettings: Record<string, boolean | string>) => ({
  paymentSettings: { defaultCurrency: "EUR", ...paymentSettings },
});
const readiness = (ready: boolean) => ({
  card: { ready, reason: ready ? null : ("not_approved" as const), charge: "at_booking" as const },
  deposits: { ready: false },
});
const client = (
  card: Promise<ReturnType<typeof readiness>>,
  manual: ("bank_transfer" | "paypal")[] = [],
) => ({
  paymentMethods: vi.fn().mockResolvedValue(manual),
  cardReadiness: vi.fn().mockReturnValue(card),
});
const methods = async (...args: Parameters<typeof paymentSettingsDefaults>) =>
  (await paymentSettingsDefaults(...args)).methods;

beforeEach(() => getPaymentSettings.mockReset());

describe("paymentSettingsDefaults (VAY-2205)", () => {
  it("offers card only once the booking page can take it", async () => {
    getPaymentSettings.mockResolvedValue(
      settings({
        payAtPropertyEnabled: true,
        onlineCardPayment: true,
        stripeConnectOnboarded: true,
      }),
    );
    // Stripe is connected, but Vayada hasn't approved card for the hotel yet.
    expect(await methods(client(Promise.resolve(readiness(false))))).toEqual(["pay_at_property"]);
    expect(await methods(client(Promise.resolve(readiness(true)), ["paypal"]))).toEqual([
      "pay_at_property",
      "card",
      "paypal",
    ]);
    // A failed read offers no card but keeps the other ways to pay.
    expect(await methods(client(Promise.reject(new Error("offline"))))).toEqual([
      "pay_at_property",
    ]);
  });

  it("follows the hotel's own card switch", async () => {
    getPaymentSettings.mockResolvedValue(
      settings({
        payAtPropertyEnabled: false,
        onlineCardPayment: false,
        stripeConnectOnboarded: true,
      }),
    );
    expect(await methods(client(Promise.resolve(readiness(true))))).toBeNull();
  });
});

describe("paymentSettingsDefaults before the first price (VAY-2383)", () => {
  it("says the server would refuse the prices when no way to pay is on, with the payment currency", async () => {
    getPaymentSettings.mockResolvedValue(
      settings({ payAtPropertyEnabled: false, onlineCardPayment: false, defaultCurrency: "idr" }),
    );
    expect(await paymentSettingsDefaults(client(Promise.resolve(readiness(false))))).toEqual({
      methods: null,
      currency: "IDR",
      notReady: true,
    });
  });

  it("is quiet when a way to pay is on", async () => {
    getPaymentSettings.mockResolvedValue(
      settings({ payAtPropertyEnabled: true, onlineCardPayment: false }),
    );
    expect(await paymentSettingsDefaults(client(Promise.resolve(readiness(false))))).toEqual({
      methods: ["pay_at_property"],
      currency: "EUR",
      notReady: false,
    });
  });

  it("is quiet when Payment settings can't be read", async () => {
    getPaymentSettings.mockRejectedValueOnce(new Error("offline"));
    expect(await paymentSettingsDefaults(client(Promise.resolve(readiness(false))))).toEqual({
      methods: null,
      currency: null,
      notReady: false,
    });
  });
});
