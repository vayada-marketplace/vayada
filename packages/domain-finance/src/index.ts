/**
 * domain-finance — Finance domain contracts.
 *
 * This package defines the target read models and commands for payment
 * settings, billing plan configuration, currency, payout split calculation,
 * and add-on pricing — the fields previously accessed by PMS API services via
 * a cross-domain `BookingEngineDatabase` pool.
 *
 * Owner: Finance domain.
 * Migration note: the authoritative data currently lives in `booking_hotels`
 * (payment flags, billing plan, fee percentages, currency, add-ons) and
 * `pms.hotel_payment_settings`.  After VAY-605 cutover, finance-owned tables
 * become the single source of truth and PMS must consume this package's ports.
 *
 * Rules:
 * - PMS target code must never open a BookingEngineDatabase pool to read
 *   payment or billing data.  Use the read ports defined here instead.
 * - Cross-domain writes to payment settings are expressed as commands with
 *   explicit idempotency keys and audit trails.
 * - Payout account numbers, IBAN, SWIFT, and payment-provider secrets are
 *   NOT part of any public or cross-domain read model — they are accessed only
 *   through permissioned finance services.
 */

// ---------------------------------------------------------------------------
// Scalar aliases
// ---------------------------------------------------------------------------

export type FinancePropertyId = string;
export type FinanceUtcDateTime = string;
export type FinanceCurrencyCode = string;

/** Decimal representation of a monetary amount, e.g. "150.00". */
export type FinanceDecimalAmount = string;

// ---------------------------------------------------------------------------
// Billing plan
// ---------------------------------------------------------------------------

export const FINANCE_BILLING_PLANS = ["fixed", "commission"] as const;

export type FinanceBillingPlan = (typeof FINANCE_BILLING_PLANS)[number];

// ---------------------------------------------------------------------------
// Payment method tokens
//
// These token strings correspond to the flags previously stored in
// `booking_hotels` (pay_at_property_enabled, online_card_payment,
// bank_transfer, paypal_enabled).  Finance owns which methods are enabled;
// booking/checkout reads this through the PaymentSettingsReadPort.
// ---------------------------------------------------------------------------

export const FINANCE_PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "bank_transfer",
  "paypal",
] as const;

export type FinancePaymentMethod = (typeof FINANCE_PAYMENT_METHODS)[number];

// ---------------------------------------------------------------------------
// Payment settings read model
//
// Replaces PMS reads of `booking_hotels.pay_at_property_enabled`,
// `online_card_payment`, `bank_transfer`, `paypal_enabled`, and
// `instant_book`.  Does NOT include account numbers, IBAN, or credentials —
// those stay behind permissioned finance read models.
// ---------------------------------------------------------------------------

export type PaymentSettingsReadModel = {
  propertyId: FinancePropertyId;
  /** Which payment methods are currently enabled for this property. */
  enabledPaymentMethods: FinancePaymentMethod[];
  /** Whether the booking engine shows an "instant book" CTA. */
  instantBook: boolean;
  /** Default transaction currency for this property. */
  defaultCurrency: FinanceCurrencyCode;
  /** All currencies the property accepts (includes defaultCurrency). */
  supportedCurrencies: FinanceCurrencyCode[];
  updatedAt: FinanceUtcDateTime;
};

// ---------------------------------------------------------------------------
// Billing config read model
//
// Replaces PMS reads of `booking_hotels.billing_active_plan`,
// `booking_engine_fee_pct`, `channel_manager_fee_pct`, and
// `affiliate_platform_fee_pct` (currently used by payout_service.py).
// ---------------------------------------------------------------------------

export type BillingConfigReadModel = {
  propertyId: FinancePropertyId;
  activePlan: FinanceBillingPlan;
  /**
   * Platform fee percentage charged on direct bookings under a commission plan.
   * Zero on fixed plans unless an affiliate is involved.
   */
  bookingEngineFeePercent: number;
  /**
   * Platform fee percentage charged on OTA / channel-manager bookings under a
   * commission plan.
   */
  channelManagerFeePercent: number;
  /**
   * Extra platform fee charged on any booking that includes an affiliate
   * referral under a fixed plan.
   */
  affiliatePlatformFeePercent: number;
  updatedAt: FinanceUtcDateTime;
};

// ---------------------------------------------------------------------------
// Add-on read model
//
// Replaces PMS reads of `booking_addons` for price/currency display.
// Add-on configuration ownership stays in the Booking domain; Finance
// exposes the pricing surface consumed by checkout and PMS financial views.
// ---------------------------------------------------------------------------

export type AddOnPricingReadModel = {
  addOnId: string;
  propertyId: FinancePropertyId;
  /** Human-readable label in the property default locale. */
  name: string;
  price: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  updatedAt: FinanceUtcDateTime;
};

// ---------------------------------------------------------------------------
// Payout split result
//
// Pure value type for the output of the billing split calculation.
// Replaces the ad-hoc dict returned by payout_service.calculate_split().
// ---------------------------------------------------------------------------

export type PayoutSplitResult = {
  /** Share retained by the Vayada platform. */
  platformFee: FinanceDecimalAmount;
  /** Commission paid to the affiliate referrer (0 when no affiliate). */
  affiliateCommission: FinanceDecimalAmount;
  /** Net amount transferred to the property. */
  propertyPayout: FinanceDecimalAmount;
};

// ---------------------------------------------------------------------------
// Payout split input
//
// Typed input for the deterministic split calculation, replacing the loose
// dict arguments in payout_service.calculate_split().
// ---------------------------------------------------------------------------

export const FINANCE_BOOKING_CHANNELS = ["direct", "channel"] as const;

export type FinanceBookingChannel = (typeof FINANCE_BOOKING_CHANNELS)[number];

export type PayoutSplitInput = {
  /** Total booking amount (pre-split). */
  totalAmount: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
  billingConfig: BillingConfigReadModel;
  /**
   * Channel that originated the booking.
   *
   * Mapping note: domain-pms uses the token `"direct_booking"` for the same
   * concept.  Adapters must translate `"direct_booking"` → `"direct"` before
   * passing a split input to this package.  The distinction is intentional:
   * domain-finance uses the shortest unambiguous token; domain-pms preserves
   * the legacy Channex-sourced channel name.
   */
  channel: FinanceBookingChannel;
  affiliate?: {
    affiliateId: string;
    /** Agreed commission rate for this affiliate in percent. */
    commissionPercent: number;
  } | null;
};

// ---------------------------------------------------------------------------
// Finance read ports
//
// TypeScript PMS code consumes these ports instead of querying the
// BookingEngineDatabase directly.
// ---------------------------------------------------------------------------

export type PaymentSettingsReadPort = {
  /**
   * Fetch payment settings for a property.
   * Returns null when the property has no finance configuration yet.
   */
  getPaymentSettings(propertyId: FinancePropertyId): Promise<PaymentSettingsReadModel | null>;
};

export type BillingConfigReadPort = {
  /**
   * Fetch billing plan and fee configuration for a property.
   * Returns null when no billing row exists (treat as configuration error
   * rather than silently applying defaults — callers must handle this case
   * explicitly and log it, as mis-billing is worse than an explicit error).
   */
  getBillingConfig(propertyId: FinancePropertyId): Promise<BillingConfigReadModel | null>;
};

export type AddOnPricingReadPort = {
  /**
   * List all add-ons for a property with current pricing.
   * Returns an empty array when the property has no add-ons.
   */
  listAddOnPricing(propertyId: FinancePropertyId): Promise<AddOnPricingReadModel[]>;
};

// ---------------------------------------------------------------------------
// Finance command types
//
// Cross-domain writes to finance-owned settings are expressed as commands with
// idempotency keys and audit trails, not as direct SQL writes from PMS code.
// ---------------------------------------------------------------------------

export type FinanceCommandActor =
  | { kind: "user"; userId: string; organizationId: string }
  | { kind: "system"; service: string }
  | { kind: "migration"; runId: string };

export type FinanceCommandAudit = {
  actor: FinanceCommandActor;
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: FinanceUtcDateTime;
};

export type FinanceCommandBase<TCommandType extends string, TPayload> = {
  commandType: TCommandType;
  commandId: string;
  idempotencyKey: string;
  propertyId: FinancePropertyId;
  audit: FinanceCommandAudit;
  payload: TPayload;
};

/** Update which payment methods are enabled. Owner: Finance. */
export type UpdatePaymentMethodsPayload = {
  enabledPaymentMethods: FinancePaymentMethod[];
};

export type UpdatePaymentMethodsCommand = FinanceCommandBase<
  "finance.payment.methods.update",
  UpdatePaymentMethodsPayload
>;

/** Enable or disable the instant-book flag. Owner: Finance/Booking. */
export type UpdateInstantBookPayload = {
  instantBook: boolean;
};

export type UpdateInstantBookCommand = FinanceCommandBase<
  "finance.payment.instant_book.update",
  UpdateInstantBookPayload
>;

/** Update the property default currency. Owner: Finance. */
export type UpdatePropertyCurrencyPayload = {
  currency: FinanceCurrencyCode;
  /** All currencies the property accepts (includes the new default). Optional — omit to leave supported currencies unchanged. */
  supportedCurrencies?: FinanceCurrencyCode[];
};

export type UpdatePropertyCurrencyCommand = FinanceCommandBase<
  "finance.currency.update",
  UpdatePropertyCurrencyPayload
>;

/** Update billing plan. Owner: Finance/Platform-admin. */
export type UpdateBillingPlanPayload = {
  activePlan: FinanceBillingPlan;
  bookingEngineFeePercent: number;
  channelManagerFeePercent: number;
  affiliatePlatformFeePercent: number;
  /**
   * If set, the plan switch becomes effective on this date rather than
   * immediately.  The legacy Python path applied pending switches inline
   * during billing-config reads; the target Finance service should apply them
   * through a scheduled job.
   */
  effectiveDate?: FinanceUtcDateTime | null;
};

export type UpdateBillingPlanCommand = FinanceCommandBase<
  "finance.billing.plan.update",
  UpdateBillingPlanPayload
>;

/**
 * Update the price of a booking add-on. Owner: Finance.
 *
 * Replaces direct writes to `booking_addons` from
 * `hotel_identity_service.update_addon_price()`.  The command carries an
 * idempotency key so concurrent PMS saves cannot produce duplicate price rows.
 */
export type UpdateAddOnPricePayload = {
  addOnId: string;
  price: FinanceDecimalAmount;
  currency: FinanceCurrencyCode;
};

export type UpdateAddOnPriceCommand = FinanceCommandBase<
  "finance.add_on.price.update",
  UpdateAddOnPricePayload
>;

export type FinanceCommand =
  | UpdatePaymentMethodsCommand
  | UpdateInstantBookCommand
  | UpdatePropertyCurrencyCommand
  | UpdateBillingPlanCommand
  | UpdateAddOnPriceCommand;

export const financeCommandTypes = [
  "finance.payment.methods.update",
  "finance.payment.instant_book.update",
  "finance.currency.update",
  "finance.billing.plan.update",
  "finance.add_on.price.update",
] as const satisfies readonly FinanceCommand["commandType"][];

export type FinanceCommandType = (typeof financeCommandTypes)[number];

// ---------------------------------------------------------------------------
// Finance command result
// ---------------------------------------------------------------------------

export type FinanceCommandResult = {
  status: "accepted" | "idempotent_replay";
  commandId: string;
  idempotencyKey: string;
  propertyId: FinancePropertyId;
};

export interface FinanceCommandBus {
  execute(command: FinanceCommand): Promise<FinanceCommandResult>;
}

// ---------------------------------------------------------------------------
// Payout split pure calculation
//
// Replaces the Python payout_service.calculate_split() function.
// This is a pure function — no side effects, no DB access.
// Amounts are rounded to 2 decimal places.
// ---------------------------------------------------------------------------

const KNOWN_DIRECT_CHANNELS: ReadonlySet<FinanceBookingChannel> = new Set(["direct"]);

/**
 * Calculate the billing split for a booking.
 *
 * Fee matrix:
 *   Fixed plan: 0% on non-affiliate bookings.
 *               affiliatePlatformFeePercent on affiliate bookings.
 *   Commission plan: bookingEngineFeePercent on direct bookings.
 *                    channelManagerFeePercent on OTA/channel bookings.
 *                    Affiliate bookings do NOT add affiliatePlatformFeePercent
 *                    (channel fee already covers the platform cut).
 *
 * Affiliate commission is additive — paid by the property on top of the
 * platform fee, regardless of plan.
 */
export function calculatePayoutSplit(input: PayoutSplitInput): PayoutSplitResult {
  const total = parseDecimalAmount(input.totalAmount);
  const isChannelBooking = !KNOWN_DIRECT_CHANNELS.has(input.channel);
  const config = input.billingConfig;

  let platformFeePct = 0;
  if (config.activePlan === "commission") {
    platformFeePct = isChannelBooking
      ? config.channelManagerFeePercent
      : config.bookingEngineFeePercent;
  } else if (input.affiliate) {
    platformFeePct = config.affiliatePlatformFeePercent;
  }
  platformFeePct = clampPercent(platformFeePct, "platformFeePct");

  const affiliateCommissionPct = input.affiliate
    ? clampPercent(input.affiliate.commissionPercent, "affiliate.commissionPercent")
    : 0;

  // Use integer-cent arithmetic to avoid floating-point accumulation errors.
  const centsTotal = Math.round(total * 100);
  const platformFeeCents = Math.round((centsTotal * platformFeePct) / 100);
  const affiliateCommissionCents = Math.round((centsTotal * affiliateCommissionPct) / 100);
  const propertyPayoutCents = centsTotal - platformFeeCents - affiliateCommissionCents;

  const platformFee = round2(platformFeeCents / 100);
  const affiliateCommission = round2(affiliateCommissionCents / 100);
  const propertyPayout = round2(propertyPayoutCents / 100);

  return {
    platformFee: String(platformFee),
    affiliateCommission: String(affiliateCommission),
    propertyPayout: String(propertyPayout),
  };
}

// ---------------------------------------------------------------------------
// Idempotency key helper
// ---------------------------------------------------------------------------

/**
 * Build a stable idempotency key for finance commands.
 * Format: `<commandType>:property:<propertyId>:<suffix>`.
 *
 * Example: `finance.billing.plan.update:property:prop_abc123:switch-to-commission-2026-07`
 */
export function financeCommandIdempotencyKey(
  commandType: FinanceCommandType,
  propertyId: FinancePropertyId,
  suffix: string,
): string {
  return `${commandType}:property:${propertyId}:${suffix}`;
}

/**
 * Build a stable idempotency key for UpdateAddOnPriceCommand.
 * Format: `finance.add_on.price.update:property:<propertyId>:add_on:<addOnId>`.
 *
 * Using the propertyId + addOnId pair as the natural key prevents duplicate
 * price-update commands when PMS retries a save after a transient failure.
 */
export function buildUpdateAddOnPriceIdempotencyKey(
  propertyId: FinancePropertyId,
  addOnId: string,
): string {
  return `finance.add_on.price.update:property:${propertyId}:add_on:${addOnId}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseDecimalAmount(value: FinanceDecimalAmount): number {
  if (value.trim() === "") {
    throw new Error("Invalid decimal amount: empty string");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  if (parsed < 0) {
    throw new Error(`Invalid decimal amount: negative value: ${value}`);
  }
  return parsed;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate that a percentage value is a finite number in the range [0, 100].
 * Throws a descriptive error for NaN, non-finite, negative, or >100 values.
 */
function clampPercent(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`Invalid percent for ${fieldName}: must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`Invalid percent for ${fieldName}: must be >= 0, got ${value}`);
  }
  if (value > 100) {
    throw new Error(`Invalid percent for ${fieldName}: must be <= 100, got ${value}`);
  }
  return value;
}
