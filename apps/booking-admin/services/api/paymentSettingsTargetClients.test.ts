import { describe, expect, it } from "vitest";

import {
  getBookingHotelPropertyLink,
  type BookingHotelPropertyLink,
} from "./bookingPropertyLinkClient";
import { omitHotelContext, type ApiClient } from "./client";
import {
  buildFinancePaymentSettingsBody,
  updateFinancePaymentSettings,
  type UpdateFinancePaymentSettingsBody,
} from "./financePaymentSettingsClient";

describe("payment settings target clients", () => {
  it("resolves the booking hotel property link without legacy hotel context", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const link: BookingHotelPropertyLink = {
      hotelId: "hotel/with space",
      propertyId: "property_target_123",
      resourceLinks: {
        bookingHotel: true,
        pmsProperty: true,
        financeProperty: true,
      },
    };
    const client = {
      get: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return link as T;
      },
    } satisfies Pick<ApiClient, "get">;

    const result = await getBookingHotelPropertyLink({ hotelId: " hotel/with space " }, client);

    expect(result).toBe(link);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/hotel%2Fwith%20space/property-link",
        options: omitHotelContext,
      },
    ]);
  });

  it("patches Finance payment settings without legacy hotel context", async () => {
    const body: UpdateFinancePaymentSettingsBody = {
      commandId: "cmd-payment-settings",
      idempotencyKey: "idem-payment-settings",
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "stripe",
        acceptedMethods: ["card"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
      },
    };
    const calls: Array<{ endpoint: string; body?: unknown; options?: RequestInit }> = [];
    const client = {
      patch: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return {
          contractVersion: "finance-route-contracts.v1",
          propertyId: "property/with space",
          paymentSettings: {},
          commandMeta: {
            commandId: body.commandId,
            idempotencyKey: body.idempotencyKey,
            sideEffects: ["audit_event"],
            outboxEvents: [],
            jobs: [],
          },
        } as T;
      },
    } satisfies Pick<ApiClient, "patch">;

    await updateFinancePaymentSettings({ propertyId: " property/with space ", body }, client);

    expect(calls).toEqual([
      {
        endpoint: "/api/finance/properties/property%2Fwith%20space/payment-settings",
        body,
        options: omitHotelContext,
      },
    ]);
  });

  it("maps Booking Admin toggles to strict Finance payment methods", () => {
    const body = buildFinancePaymentSettingsBody({
      payAtPropertyEnabled: true,
      payAtHotelMethods: ["cash", "card"],
      onlineCardPayment: true,
      bankTransfer: true,
      paymentProvider: "xendit",
      defaultCurrency: "chf",
      commandPrefix: "test-command",
    });

    expect(body.commandId).toMatch(/^test-command-/);
    expect(body.idempotencyKey).toBe(body.commandId);
    expect(body.paymentSettings).toMatchObject({
      paymentsEnabled: true,
      paymentProvider: "xendit",
      acceptedMethods: ["pay_at_property", "cash", "manual_card", "xendit", "bank_transfer"],
      defaultCurrency: "CHF",
      supportedCurrencies: ["CHF"],
      requiresManualReview: false,
    });
  });
});
