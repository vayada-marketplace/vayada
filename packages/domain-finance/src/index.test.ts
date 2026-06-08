import { describe, expect, it } from "vitest";

import {
  FINANCE_BILLING_PLANS,
  FINANCE_PAYMENT_METHODS,
  buildUpdateAddOnPriceIdempotencyKey,
  calculatePayoutSplit,
  financeCommandIdempotencyKey,
  financeCommandTypes,
  type AddOnPricingReadPort,
  type BillingConfigReadModel,
  type BillingConfigReadPort,
  type FinanceCommandBus,
  type FinanceCommandResult,
  type PaymentSettingsReadModel,
  type PaymentSettingsReadPort,
  type UpdateAddOnPriceCommand,
  type UpdatePaymentMethodsCommand,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_BILLING_CONFIG: BillingConfigReadModel = {
  propertyId: "prop_abc123",
  activePlan: "fixed",
  bookingEngineFeePercent: 0,
  channelManagerFeePercent: 0,
  affiliatePlatformFeePercent: 0,
  updatedAt: "2026-06-07T10:00:00.000Z",
};

const COMMISSION_BILLING_CONFIG: BillingConfigReadModel = {
  propertyId: "prop_abc123",
  activePlan: "commission",
  bookingEngineFeePercent: 3,
  channelManagerFeePercent: 5,
  affiliatePlatformFeePercent: 2,
  updatedAt: "2026-06-07T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Enum / constant tests
// ---------------------------------------------------------------------------

describe("@vayada/domain-finance constants", () => {
  it("exports billing plans", () => {
    expect(FINANCE_BILLING_PLANS).toContain("fixed");
    expect(FINANCE_BILLING_PLANS).toContain("commission");
  });

  it("exports payment methods that replace the booking_hotels flag columns", () => {
    expect(FINANCE_PAYMENT_METHODS).toContain("card");
    expect(FINANCE_PAYMENT_METHODS).toContain("pay_at_property");
    expect(FINANCE_PAYMENT_METHODS).toContain("bank_transfer");
    expect(FINANCE_PAYMENT_METHODS).toContain("paypal");
  });

  it("exports finance command types", () => {
    expect(financeCommandTypes).toContain("finance.payment.methods.update");
    expect(financeCommandTypes).toContain("finance.payment.instant_book.update");
    expect(financeCommandTypes).toContain("finance.currency.update");
    expect(financeCommandTypes).toContain("finance.billing.plan.update");
    expect(financeCommandTypes).toContain("finance.add_on.price.update");
  });
});

// ---------------------------------------------------------------------------
// calculatePayoutSplit — fixed plan
// ---------------------------------------------------------------------------

describe("calculatePayoutSplit — fixed plan", () => {
  it("charges 0% platform fee on a direct booking without affiliate", () => {
    const result = calculatePayoutSplit({
      totalAmount: "1000.00",
      currency: "EUR",
      billingConfig: BASE_BILLING_CONFIG,
      channel: "direct",
    });

    expect(result.platformFee).toBe("0");
    expect(result.affiliateCommission).toBe("0");
    expect(result.propertyPayout).toBe("1000");
  });

  it("charges the affiliate platform fee on a fixed plan with affiliate", () => {
    const config: BillingConfigReadModel = {
      ...BASE_BILLING_CONFIG,
      affiliatePlatformFeePercent: 2,
    };

    const result = calculatePayoutSplit({
      totalAmount: "500.00",
      currency: "EUR",
      billingConfig: config,
      channel: "direct",
      affiliate: { affiliateId: "aff_001", commissionPercent: 10 },
    });

    // 2% platform fee = 10.00, 10% affiliate commission = 50.00
    expect(result.platformFee).toBe("10");
    expect(result.affiliateCommission).toBe("50");
    expect(result.propertyPayout).toBe("440");
  });
});

// ---------------------------------------------------------------------------
// calculatePayoutSplit — commission plan
// ---------------------------------------------------------------------------

describe("calculatePayoutSplit — commission plan", () => {
  it("charges bookingEngineFeePercent on a direct booking", () => {
    const result = calculatePayoutSplit({
      totalAmount: "1000.00",
      currency: "EUR",
      billingConfig: COMMISSION_BILLING_CONFIG,
      channel: "direct",
    });

    // 3% booking engine fee = 30.00
    expect(result.platformFee).toBe("30");
    expect(result.affiliateCommission).toBe("0");
    expect(result.propertyPayout).toBe("970");
  });

  it("charges channelManagerFeePercent on a channel booking", () => {
    const result = calculatePayoutSplit({
      totalAmount: "1000.00",
      currency: "EUR",
      billingConfig: COMMISSION_BILLING_CONFIG,
      channel: "channel",
    });

    // 5% channel manager fee = 50.00
    expect(result.platformFee).toBe("50");
    expect(result.affiliateCommission).toBe("0");
    expect(result.propertyPayout).toBe("950");
  });

  it("does NOT add affiliatePlatformFee on a commission plan with affiliate", () => {
    const result = calculatePayoutSplit({
      totalAmount: "1000.00",
      currency: "EUR",
      billingConfig: COMMISSION_BILLING_CONFIG,
      channel: "direct",
      affiliate: { affiliateId: "aff_001", commissionPercent: 10 },
    });

    // Commission plan: 3% direct fee = 30.00, 10% affiliate = 100.00
    // affiliatePlatformFeePercent (2%) is NOT added on commission plan
    expect(result.platformFee).toBe("30");
    expect(result.affiliateCommission).toBe("100");
    expect(result.propertyPayout).toBe("870");
  });

  it("rounds amounts to 2 decimal places", () => {
    const result = calculatePayoutSplit({
      totalAmount: "333.33",
      currency: "EUR",
      billingConfig: COMMISSION_BILLING_CONFIG,
      channel: "direct",
    });

    // 3% of 333.33 = 9.9999 → rounded to 10
    const platformFee = Number(result.platformFee);
    const propertyPayout = Number(result.propertyPayout);
    expect(platformFee).toBe(10);
    expect(propertyPayout).toBeCloseTo(323.33, 2);
  });
});

// ---------------------------------------------------------------------------
// parseDecimalAmount — internal guard (exercised via calculatePayoutSplit)
// ---------------------------------------------------------------------------

describe("calculatePayoutSplit — invalid input guards", () => {
  it("throws when totalAmount is an empty string", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "",
        currency: "EUR",
        billingConfig: BASE_BILLING_CONFIG,
        channel: "direct",
      }),
    ).toThrow("Invalid decimal amount: empty string");
  });

  it("throws when totalAmount is whitespace only", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "   ",
        currency: "EUR",
        billingConfig: BASE_BILLING_CONFIG,
        channel: "direct",
      }),
    ).toThrow("Invalid decimal amount: empty string");
  });

  it("throws when totalAmount is negative", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "-100.00",
        currency: "EUR",
        billingConfig: BASE_BILLING_CONFIG,
        channel: "direct",
      }),
    ).toThrow("Invalid decimal amount: negative value: -100.00");
  });
});

// ---------------------------------------------------------------------------
// calculatePayoutSplit — invalid percent guards
// ---------------------------------------------------------------------------

describe("calculatePayoutSplit — invalid percent guards", () => {
  it("throws when bookingEngineFeePercent is NaN (commission plan, direct)", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: { ...COMMISSION_BILLING_CONFIG, bookingEngineFeePercent: NaN },
        channel: "direct",
      }),
    ).toThrow("Invalid percent for platformFeePct");
  });

  it("throws when channelManagerFeePercent is NaN (commission plan, channel)", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: { ...COMMISSION_BILLING_CONFIG, channelManagerFeePercent: NaN },
        channel: "channel",
      }),
    ).toThrow("Invalid percent for platformFeePct");
  });

  it("throws when affiliatePlatformFeePercent is NaN (fixed plan with affiliate)", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: { ...BASE_BILLING_CONFIG, affiliatePlatformFeePercent: NaN },
        channel: "direct",
        affiliate: { affiliateId: "aff_001", commissionPercent: 10 },
      }),
    ).toThrow("Invalid percent for platformFeePct");
  });

  it("throws when bookingEngineFeePercent is negative", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: { ...COMMISSION_BILLING_CONFIG, bookingEngineFeePercent: -1 },
        channel: "direct",
      }),
    ).toThrow("Invalid percent for platformFeePct");
  });

  it("throws when bookingEngineFeePercent is greater than 100", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: { ...COMMISSION_BILLING_CONFIG, bookingEngineFeePercent: 101 },
        channel: "direct",
      }),
    ).toThrow("Invalid percent for platformFeePct");
  });

  it("throws when affiliate commissionPercent is NaN", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: COMMISSION_BILLING_CONFIG,
        channel: "direct",
        affiliate: { affiliateId: "aff_001", commissionPercent: NaN },
      }),
    ).toThrow("Invalid percent for affiliate.commissionPercent");
  });

  it("throws when affiliate commissionPercent is negative", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: COMMISSION_BILLING_CONFIG,
        channel: "direct",
        affiliate: { affiliateId: "aff_001", commissionPercent: -5 },
      }),
    ).toThrow("Invalid percent for affiliate.commissionPercent");
  });

  it("throws when affiliate commissionPercent is greater than 100", () => {
    expect(() =>
      calculatePayoutSplit({
        totalAmount: "100.00",
        currency: "EUR",
        billingConfig: COMMISSION_BILLING_CONFIG,
        channel: "direct",
        affiliate: { affiliateId: "aff_001", commissionPercent: 150 },
      }),
    ).toThrow("Invalid percent for affiliate.commissionPercent");
  });
});

// ---------------------------------------------------------------------------
// Read ports — verify that PMS code can use these without a DB pool
// ---------------------------------------------------------------------------

describe("PaymentSettingsReadPort", () => {
  it("allows PMS code to retrieve payment settings without querying booking_hotels", async () => {
    const mockSettings: PaymentSettingsReadModel = {
      propertyId: "prop_abc123",
      enabledPaymentMethods: ["card", "pay_at_property"],
      instantBook: true,
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR", "USD"],
      updatedAt: "2026-06-07T10:00:00.000Z",
    };

    const fakePort: PaymentSettingsReadPort = {
      async getPaymentSettings(propertyId) {
        return propertyId === "prop_abc123" ? mockSettings : null;
      },
    };

    const settings = await fakePort.getPaymentSettings("prop_abc123");
    expect(settings?.enabledPaymentMethods).toContain("card");
    expect(settings?.enabledPaymentMethods).toContain("pay_at_property");
    expect(settings?.instantBook).toBe(true);
    expect(settings?.defaultCurrency).toBe("EUR");

    const missing = await fakePort.getPaymentSettings("prop_missing");
    expect(missing).toBeNull();
  });
});

describe("BillingConfigReadPort", () => {
  it("returns null (not zero-fee defaults) for unknown properties", async () => {
    // The contract intentionally returns null rather than a zero-fee default
    // so callers must handle missing billing config explicitly — silently
    // applying 0% fees previously caused billing errors (see VAY-318 note in
    // payout_service.py).
    const fakePort: BillingConfigReadPort = {
      async getBillingConfig(propertyId) {
        return propertyId === "prop_abc123" ? COMMISSION_BILLING_CONFIG : null;
      },
    };

    const config = await fakePort.getBillingConfig("prop_abc123");
    expect(config?.activePlan).toBe("commission");
    expect(config?.bookingEngineFeePercent).toBe(3);

    const missing = await fakePort.getBillingConfig("prop_unknown");
    expect(missing).toBeNull();
  });
});

describe("AddOnPricingReadPort", () => {
  it("returns empty array for properties with no add-ons", async () => {
    const fakePort: AddOnPricingReadPort = {
      async listAddOnPricing(_propertyId) {
        return [];
      },
    };
    const addOns = await fakePort.listAddOnPricing("prop_abc123");
    expect(addOns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FinanceCommandBus
// ---------------------------------------------------------------------------

describe("FinanceCommandBus", () => {
  it("allows downstream code to issue payment method updates without direct DB writes", async () => {
    const received: UpdatePaymentMethodsCommand[] = [];

    const fakeBus: FinanceCommandBus = {
      async execute(command): Promise<FinanceCommandResult> {
        if (command.commandType === "finance.payment.methods.update") {
          received.push(command);
        }
        return {
          status: "accepted",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          propertyId: command.propertyId,
        };
      },
    };

    const cmd: UpdatePaymentMethodsCommand = {
      commandType: "finance.payment.methods.update",
      commandId: "cmd_pm_001",
      idempotencyKey: financeCommandIdempotencyKey(
        "finance.payment.methods.update",
        "prop_abc123",
        "update-001",
      ),
      propertyId: "prop_abc123",
      audit: {
        actor: { kind: "user", userId: "user_123", organizationId: "org_456" },
        requestId: "req_001",
        reason: "Hotel enabled bank transfer",
        requestedAt: "2026-06-07T12:00:00.000Z",
      },
      payload: {
        enabledPaymentMethods: ["card", "pay_at_property", "bank_transfer"],
      },
    };

    const result = await fakeBus.execute(cmd);
    expect(result.status).toBe("accepted");
    expect(result.propertyId).toBe("prop_abc123");
    expect(received).toHaveLength(1);
    expect(received[0].payload.enabledPaymentMethods).toContain("bank_transfer");
  });
});

// ---------------------------------------------------------------------------
// financeCommandIdempotencyKey
// ---------------------------------------------------------------------------

describe("financeCommandIdempotencyKey", () => {
  it("builds a stable scoped key", () => {
    const key = financeCommandIdempotencyKey(
      "finance.billing.plan.update",
      "prop_abc123",
      "switch-to-commission-2026-07",
    );
    expect(key).toBe(
      "finance.billing.plan.update:property:prop_abc123:switch-to-commission-2026-07",
    );
  });
});

// ---------------------------------------------------------------------------
// UpdateAddOnPriceCommand
// ---------------------------------------------------------------------------

describe("UpdateAddOnPriceCommand", () => {
  it("is dispatchable through FinanceCommandBus and carries idempotency key", async () => {
    const received: UpdateAddOnPriceCommand[] = [];

    const fakeBus: FinanceCommandBus = {
      async execute(command): Promise<FinanceCommandResult> {
        if (command.commandType === "finance.add_on.price.update") {
          received.push(command as UpdateAddOnPriceCommand);
        }
        return {
          status: "accepted",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          propertyId: command.propertyId,
        };
      },
    };

    const cmd: UpdateAddOnPriceCommand = {
      commandType: "finance.add_on.price.update",
      commandId: "cmd_addon_001",
      idempotencyKey: buildUpdateAddOnPriceIdempotencyKey("prop_abc123", "addon_breakfast"),
      propertyId: "prop_abc123",
      audit: {
        actor: { kind: "user", userId: "user_123", organizationId: "org_456" },
        requestId: "req_addon_001",
        reason: "Hotel manager updated breakfast add-on price",
        requestedAt: "2026-06-08T09:00:00.000Z",
      },
      payload: {
        addOnId: "addon_breakfast",
        price: "25.00",
        currency: "EUR",
      },
    };

    const result = await fakeBus.execute(cmd);
    expect(result.status).toBe("accepted");
    expect(result.propertyId).toBe("prop_abc123");
    expect(received).toHaveLength(1);
    expect(received[0].payload.addOnId).toBe("addon_breakfast");
    expect(received[0].payload.price).toBe("25.00");
    expect(received[0].payload.currency).toBe("EUR");
  });

  it("produces a stable idempotency key scoped to property and add-on", () => {
    const key = buildUpdateAddOnPriceIdempotencyKey("prop_abc123", "addon_breakfast");
    expect(key).toBe("finance.add_on.price.update:property:prop_abc123:add_on:addon_breakfast");
  });

  it("produces distinct keys for different add-ons on the same property", () => {
    const key1 = buildUpdateAddOnPriceIdempotencyKey("prop_abc123", "addon_breakfast");
    const key2 = buildUpdateAddOnPriceIdempotencyKey("prop_abc123", "addon_parking");
    expect(key1).not.toBe(key2);
  });
});
