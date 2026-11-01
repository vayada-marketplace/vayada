import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "./stripeBookingPayments.js";

/** vayada Payment (VAY-2442): the hotel's provider account is bound as vayada:<property> (P1),
 * and its payments charge on Vayada's own Stripe account. Every other account reference is a
 * hotel's Stripe Connect account. */
export function isVayadaPaymentAccountRef(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ref.startsWith("vayada:");
}

export type VayadaPaymentStripe = {
  /** A provider on Vayada's own (test-mode) Stripe account; called without a connected account. */
  provider: StripeBookingPaymentProvider;
  publishableKey: string;
};

/** One provider for every pricing-v2 card path: payments whose account reference is
 * vayada:<property> go to Vayada's own Stripe account, everything else to Stripe Connect as
 * before. Callers keep passing the payment's stored reference, so creating, reading, capturing,
 * cancelling and refunding a vayada Payment charge need no other change. */
export function routeVayadaPaymentStripe(
  connect: StripeBookingPaymentProvider,
  vayada: VayadaPaymentStripe | undefined,
): StripeBookingPaymentProvider {
  const own = () => {
    if (!vayada) throw new Error("vayada Payment's Stripe account is not configured.");
    return vayada.provider;
  };
  // The stored reference stays on the intent, so identity checks compare like with like.
  const tagged = (intent: StripeBookingPaymentIntent, ref: string): StripeBookingPaymentIntent => ({
    ...intent,
    providerAccountRef: ref,
    publishableKey: vayada!.publishableKey,
  });
  return {
    async createPaymentIntent(input) {
      if (!isVayadaPaymentAccountRef(input.providerAccountRef))
        return connect.createPaymentIntent(input);
      // Vayada keeps its fee by paying the hotel less (the payout ledger), never by an
      // application fee, which needs a connected account.
      if (input.applicationFeeAmountMinor !== 0)
        throw new Error("A vayada Payment charge carries no application fee.");
      const intent = await own().createPaymentIntent({ ...input, providerAccountRef: null });
      return tagged(intent, input.providerAccountRef);
    },
    async retrievePaymentIntent(paymentIntentId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? tagged(await own().retrievePaymentIntent(paymentIntentId, null), ref)
        : connect.retrievePaymentIntent(paymentIntentId, ref);
    },
    async capturePaymentIntent(paymentIntentId, ref, idempotencyKey) {
      return isVayadaPaymentAccountRef(ref)
        ? tagged(await own().capturePaymentIntent(paymentIntentId, null, idempotencyKey), ref)
        : connect.capturePaymentIntent(paymentIntentId, ref, idempotencyKey);
    },
    async cancelPaymentIntent(paymentIntentId, ref, idempotencyKey) {
      return isVayadaPaymentAccountRef(ref)
        ? tagged(await own().cancelPaymentIntent(paymentIntentId, null, idempotencyKey), ref)
        : connect.cancelPaymentIntent(paymentIntentId, ref, idempotencyKey);
    },
    async createRefund(input) {
      return isVayadaPaymentAccountRef(input.providerAccountRef)
        ? own().createRefund({ ...input, providerAccountRef: null, refundApplicationFee: false })
        : connect.createRefund(input);
    },
    async listRefunds(paymentIntentId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? own().listRefunds(paymentIntentId, null)
        : connect.listRefunds(paymentIntentId, ref);
    },
    async retrieveRefund(refundId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? own().retrieveRefund(refundId, null)
        : connect.retrieveRefund(refundId, ref);
    },
  };
}
