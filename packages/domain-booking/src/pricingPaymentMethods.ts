/** Missing methods remain historical data, never permission to execute payment. */
export function validOptionalPricingPaymentMethods(payment: object): boolean {
  if (!Object.hasOwn(payment, "acceptedMethods")) return true;
  const methods = (payment as { acceptedMethods: unknown }).acceptedMethods;
  return (
    Array.isArray(methods) &&
    methods.length > 0 &&
    methods.length <= 2 &&
    new Set(methods).size === methods.length &&
    Array.from(methods).every((method) => method === "card" || method === "pay_at_property")
  );
}
