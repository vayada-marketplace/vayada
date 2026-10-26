import type pg from "pg";
import type { ManualPricingPaymentMethod } from "@vayada/domain-booking";

/** Bank transfer and PayPal for booking launch (VAY-2139), read only while their acceptance is on.
 * Ready on a committed Finance row (payment methods saved through either writer) that takes them,
 * with an enabled bank destination or a valid PayPal email. Like the pricing check, they count
 * only for a hotel that takes neither card nor pay at property; such a hotel keeps the usual
 * Finance readiness. Property-scoped only: callers ask after Finance's own organization-scoped
 * snapshot matched the property. */
export type FinanceManualPaymentReadinessReadPort = {
  readyMethods(request: { propertyId: string }): Promise<readonly ManualPricingPaymentMethod[]>;
};

/** For the owner's setup and rate screens: bank transfer and PayPal the hotel takes with their
 * details in place, also next to card or pay at property. */
export type FinanceManualPaymentMethodsReadPort = {
  acceptedMethods(request: { propertyId: string }): Promise<readonly ManualPricingPaymentMethod[]>;
};

type QueryPool = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

export function createFinanceManualPaymentReadinessReader(config: {
  pool: Pick<pg.Pool, "query"> | QueryPool;
}): FinanceManualPaymentReadinessReadPort & FinanceManualPaymentMethodsReadPort {
  const { pool } = config;
  const read = async (propertyId: string) => {
    const row = (
      await pool.query(
        `SELECT settings.accepted_methods,settings.deposit_policy->>'paypalEmail' AS paypal_email,
            EXISTS(SELECT 1 FROM finance.bank_transfer_destinations destination
              WHERE destination.property_id=settings.property_id AND destination.enabled) AS bank_destination
          FROM finance.payment_settings settings
          WHERE settings.property_id=$1 AND settings.payments_enabled
            AND settings.payment_methods_revision IS NOT NULL`,
        [propertyId],
      )
    ).rows[0];
    const accepted: unknown[] = Array.isArray(row?.accepted_methods) ? row.accepted_methods : [];
    const methods: ManualPricingPaymentMethod[] = [];
    if (accepted.includes("bank_transfer") && row.bank_destination === true)
      methods.push("bank_transfer");
    const email = typeof row?.paypal_email === "string" ? row.paypal_email.trim() : "";
    if (accepted.includes("paypal") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      methods.push("paypal");
    return {
      methods,
      otherAccepted: accepted.includes("card") || accepted.includes("pay_at_property"),
    };
  };
  return {
    async readyMethods({ propertyId }) {
      const { methods, otherAccepted } = await read(propertyId);
      return otherAccepted ? [] : methods;
    },
    async acceptedMethods({ propertyId }) {
      return (await read(propertyId)).methods;
    },
  };
}

/**
 * VAY-2139: a published page that lists only bank transfer or PayPal is served only while the hotel
 * still takes at least one of them with its details in place (an enabled bank destination, a valid
 * PayPal email). It comes back by itself once they are restored. Other pages always pass, including
 * one that also lists card or pay at property (Finance doesn't publish those mixed today).
 */
export async function manualPublishedPagePayable(
  pool: Pick<pg.Pool, "query"> | QueryPool,
  propertyId: string,
  readyMethods: readonly string[],
): Promise<boolean> {
  if (readyMethods.some((method) => method === "card" || method === "pay_at_property")) return true;
  const manual = readyMethods.filter((method) => method === "bank_transfer" || method === "paypal");
  if (!manual.length) return true;
  const accepted = await createFinanceManualPaymentReadinessReader({ pool }).acceptedMethods({
    propertyId,
  });
  return manual.some((method) => accepted.includes(method as (typeof accepted)[number]));
}
