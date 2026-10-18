import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPaymentSettings } = vi.hoisted(() => ({ getPaymentSettings: vi.fn() }));
vi.mock("@/services/bookings", () => ({ bookingsService: { getPaymentSettings } }));

import { paymentSettingsMethods } from "./pricingPaymentDefaults";

const settings = (paymentSettings: Record<string, boolean>) => ({ paymentSettings });
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

beforeEach(() => getPaymentSettings.mockReset());

describe("paymentSettingsMethods (VAY-2205)", () => {
  it("offers card only once the booking page can take it", async () => {
    getPaymentSettings.mockResolvedValue(
      settings({
        payAtPropertyEnabled: true,
        onlineCardPayment: true,
        stripeConnectOnboarded: true,
      }),
    );
    // Stripe is connected, but Vayada hasn't approved card for the hotel yet.
    expect(await paymentSettingsMethods(client(Promise.resolve(readiness(false))))).toEqual([
      "pay_at_property",
    ]);
    expect(
      await paymentSettingsMethods(client(Promise.resolve(readiness(true)), ["paypal"])),
    ).toEqual(["pay_at_property", "card", "paypal"]);
    // A failed read offers no card but keeps the other ways to pay.
    expect(await paymentSettingsMethods(client(Promise.reject(new Error("offline"))))).toEqual([
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
    expect(await paymentSettingsMethods(client(Promise.resolve(readiness(true))))).toBeNull();
  });
});
