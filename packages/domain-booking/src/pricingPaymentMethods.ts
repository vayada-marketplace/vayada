export const PRICING_PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "bank_transfer",
  "paypal",
] as const;
export type PricingPaymentMethod = (typeof PRICING_PAYMENT_METHODS)[number];
/** The guest pays the hotel directly before a deadline and the hotel confirms receipt (VAY-2139). */
export const MANUAL_PRICING_PAYMENT_METHODS = ["bank_transfer", "paypal"] as const;
export type ManualPricingPaymentMethod = (typeof MANUAL_PRICING_PAYMENT_METHODS)[number];

export function isPricingPaymentMethod(method: unknown): method is PricingPaymentMethod {
  return (PRICING_PAYMENT_METHODS as readonly unknown[]).includes(method);
}

export function isManualPricingPaymentMethod(
  method: unknown,
): method is ManualPricingPaymentMethod {
  return (MANUAL_PRICING_PAYMENT_METHODS as readonly unknown[]).includes(method);
}

/** Missing methods remain historical data, never permission to execute payment. */
export function validOptionalPricingPaymentMethods(payment: object): boolean {
  if (!Object.hasOwn(payment, "acceptedMethods")) return true;
  const methods = (payment as { acceptedMethods: unknown }).acceptedMethods;
  return (
    Array.isArray(methods) &&
    methods.length > 0 &&
    methods.length <= PRICING_PAYMENT_METHODS.length &&
    new Set(methods).size === methods.length &&
    Array.from(methods).every(isPricingPaymentMethod)
  );
}
