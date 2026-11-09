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

/** The account a stored card payment's Stripe calls go to: a Connect direct charge's connected
 * account, or vayada Payment's vayada:<property> (the router sends it to Vayada's own account).
 * A charge of any other type ran on the platform account itself (null). */
export function stripeCallAccountRef(
  chargeType: unknown,
  ref: string | null | undefined,
): string | null {
  return chargeType === "direct" || chargeType === "vayada_payment" ? (ref ?? null) : null;
}

export type VayadaPaymentStripe = {
  /** A provider on Vayada's own Stripe account (one mode's keys); called without a connected
   * account. */
  provider: StripeBookingPaymentProvider;
  publishableKey: string;
};

/** One provider for every pricing-v2 card path: payments whose account reference is
 * vayada:<property> go to Vayada's own Stripe account, everything else to Stripe Connect as
 * before. Callers keep passing the payment's stored reference, so creating, reading, capturing,
 * cancelling and refunding a vayada Payment charge need no other change. A hotel on the live list
 * (`live.for`) is called only with the live keys, every other hotel only with the test keys. */
export function routeVayadaPaymentStripe(
  connect: StripeBookingPaymentProvider,
  vayada: VayadaPaymentStripe | undefined,
  live?: { account?: VayadaPaymentStripe; for(propertyId: string): boolean },
): StripeBookingPaymentProvider {
  const accountFor = (ref: string) => {
    const livemode = live?.for(ref.slice("vayada:".length)) === true;
    const account = livemode ? live?.account : vayada;
    if (!account)
      throw new Error(
        `vayada Payment's ${livemode ? "live" : "test"}-mode Stripe account is not configured.`,
      );
    return { ...account, livemode };
  };
  // The stored reference stays on the intent, so identity checks compare like with like.
  const tagged = (
    intent: StripeBookingPaymentIntent,
    ref: string,
    account: ReturnType<typeof accountFor>,
  ): StripeBookingPaymentIntent => ({
    ...intent,
    providerAccountRef: ref,
    publishableKey: account.publishableKey,
  });
  // Before a guest can pay (and on every read), Stripe's own livemode must match the hotel's, so
  // test money is never taken as real, nor the reverse. Checked only where nothing has moved yet.
  const sameMode = (intent: StripeBookingPaymentIntent, account: ReturnType<typeof accountFor>) => {
    if (typeof intent.livemode === "boolean" && intent.livemode !== account.livemode)
      throw new Error("vayada Payment: Stripe's mode does not match the hotel's.");
    return intent;
  };
  return {
    async createPaymentIntent(input) {
      if (!isVayadaPaymentAccountRef(input.providerAccountRef))
        return connect.createPaymentIntent(input);
      // Vayada keeps its fee by paying the hotel less (the payout ledger), never by an
      // application fee, which needs a connected account.
      if (input.applicationFeeAmountMinor !== 0)
        throw new Error("A vayada Payment charge carries no application fee.");
      const account = accountFor(input.providerAccountRef);
      const intent = await account.provider.createPaymentIntent({
        ...input,
        providerAccountRef: null,
      });
      return tagged(sameMode(intent, account), input.providerAccountRef, account);
    },
    async retrievePaymentIntent(paymentIntentId, ref) {
      if (!isVayadaPaymentAccountRef(ref))
        return connect.retrievePaymentIntent(paymentIntentId, ref);
      const account = accountFor(ref);
      const intent = await account.provider.retrievePaymentIntent(paymentIntentId, null);
      return tagged(sameMode(intent, account), ref, account);
    },
    async capturePaymentIntent(paymentIntentId, ref, idempotencyKey) {
      if (!isVayadaPaymentAccountRef(ref))
        return connect.capturePaymentIntent(paymentIntentId, ref, idempotencyKey);
      const account = accountFor(ref);
      return tagged(
        await account.provider.capturePaymentIntent(paymentIntentId, null, idempotencyKey),
        ref,
        account,
      );
    },
    async cancelPaymentIntent(paymentIntentId, ref, idempotencyKey) {
      if (!isVayadaPaymentAccountRef(ref))
        return connect.cancelPaymentIntent(paymentIntentId, ref, idempotencyKey);
      const account = accountFor(ref);
      return tagged(
        await account.provider.cancelPaymentIntent(paymentIntentId, null, idempotencyKey),
        ref,
        account,
      );
    },
    async createRefund(input) {
      return isVayadaPaymentAccountRef(input.providerAccountRef)
        ? accountFor(input.providerAccountRef).provider.createRefund({
            ...input,
            providerAccountRef: null,
            refundApplicationFee: false,
          })
        : connect.createRefund(input);
    },
    async listRefunds(paymentIntentId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? accountFor(ref).provider.listRefunds(paymentIntentId, null)
        : connect.listRefunds(paymentIntentId, ref);
    },
    async retrieveRefund(refundId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? accountFor(ref).provider.retrieveRefund(refundId, null)
        : connect.retrieveRefund(refundId, ref);
    },
  };
}
