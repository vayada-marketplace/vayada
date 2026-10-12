import type { PoolClient } from "pg";
import {
  isManualPricingPaymentMethod,
  type ManualPricingPaymentMethod,
} from "@vayada/domain-booking";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import type { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";

type Quote = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>["quote"];

/** Bank transfer has a fixed payment window (agreed 2026-10-12); PayPal uses the hotel's own. */
export const PRICING_BANK_TRANSFER_PAYMENT_HOURS = 48;

export type PricingManualPaymentTerms = Readonly<{
  method: ManualPricingPaymentMethod;
  paymentWindowHours: number;
  /** PayPal only: where the guest sends the money. */
  paypalEmail: string | null;
}>;

/** booking.guest_bookings.expected_payment_method for a pricing-v2 quote's method. */
export function pricingExpectedPaymentMethod(method: string): string {
  return method === "pay_at_property" || method === "bank_transfer" ? method : "unknown";
}

/** Bank-transfer and PayPal quotes this path executes (VAY-2139): the whole amount is paid to
 * the hotel before the deadline, in either acceptance mode. Like card, quotes with an amount due
 * at the property are not supported. */
export function pricingManualQuoteSupported(quote: Quote): boolean {
  const { totalMinor, dueNowMinor, dueLaterMinor } = quote.evidence;
  return (
    isManualPricingPaymentMethod(quote.paymentMethod) &&
    (quote.acceptanceMode === "instant" || quote.acceptanceMode === "request") &&
    /^[1-9][0-9]*$/.test(dueNowMinor) &&
    dueNowMinor === totalMinor &&
    dueLaterMinor === "0"
  );
}

/** Finance terms read again inside the acceptance transaction and kept until it ends: the method
 * is still accepted and its enabled bank destination or valid PayPal email is still there. */
export async function lockPricingManualPaymentTerms(
  client: Pick<PoolClient, "query">,
  propertyId: string,
  method: unknown,
  /** False for public reads outside a transaction, such as the checkout settings (VAY-2145). */
  lock = true,
): Promise<PricingManualPaymentTerms | null> {
  const forShare = lock ? " FOR SHARE" : "";
  if (!isManualPricingPaymentMethod(method)) return null;
  const settings = (
    await client.query(
      `SELECT payments_enabled,accepted_methods,deposit_policy FROM finance.payment_settings
      WHERE property_id=$1${forShare}`,
      [propertyId],
    )
  ).rows[0];
  if (
    settings?.payments_enabled !== true ||
    !Array.isArray(settings.accepted_methods) ||
    !settings.accepted_methods.includes(method)
  )
    return null;
  if (method === "bank_transfer") {
    const destination = await client.query(
      `SELECT id FROM finance.bank_transfer_destinations WHERE property_id=$1 AND enabled${forShare}`,
      [propertyId],
    );
    return destination.rows.length === 1
      ? { method, paymentWindowHours: PRICING_BANK_TRANSFER_PAYMENT_HOURS, paypalEmail: null }
      : null;
  }
  const policy = settings.deposit_policy ?? {};
  const email = typeof policy.paypalEmail === "string" ? policy.paypalEmail.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  // Same bounds as the legacy checkout: 1-168 hours, otherwise 24.
  const hours = Number(policy.paypalPaymentWindowHours);
  return {
    method,
    paymentWindowHours: Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 24,
    paypalEmail: email,
  };
}

/** A replayed bank-transfer or PayPal acceptance answers with the same pending payment while the
 * booking still waits for it, and as a plain replay once it is paid. A booking that ended unpaid
 * (expired, declined, canceled) is a conflict, never a confirmation. Other bookings: null. */
export async function readPricingManualReplay(
  client: Pick<PoolClient, "query">,
  replay: { bookingId: string; bookingReference: string },
) {
  const booking = (
    await client.query(
      `SELECT property_id::text,lifecycle_status,payment_status,currency,total_amount::text,
      booking_metadata->>'paymentMethod' AS method,booking_metadata->>'pendingExpiresAt' AS deadline,
      clock_timestamp() AS now
      FROM booking.guest_bookings WHERE id=$1 AND booking_metadata->>'targetSource'='pricing_quote_draft'`,
      [replay.bookingId],
    )
  ).rows[0];
  if (!booking || !isManualPricingPaymentMethod(booking.method)) return null;
  if (booking.lifecycle_status === "confirmed" && booking.payment_status === "paid") return null;
  const scale = pricingCurrencyScale(booking.currency);
  const amountMinor = scale === null ? null : pricingDecimalMinor(booking.total_amount, scale);
  if (
    booking.lifecycle_status !== "pending_payment" ||
    booking.payment_status !== "unpaid" ||
    typeof booking.deadline !== "string" ||
    // Past the deadline but not yet swept: no longer payable.
    !(Date.parse(booking.deadline) > new Date(booking.now).getTime()) ||
    amountMinor === null
  )
    throw new Error("Booking acceptance expired or unavailable");
  return {
    kind: "payment_pending" as const,
    bookingId: replay.bookingId,
    bookingReference: replay.bookingReference,
    propertyId: booking.property_id as string,
    replayed: true as const,
    payment: {
      method: booking.method as ManualPricingPaymentMethod,
      amountMinor,
      currency: booking.currency as string,
      deadlineAt: booking.deadline as string,
    },
  };
}
