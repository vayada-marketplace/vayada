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

/** VAY-2569: the mode a stored vayada Payment was made in (its `payment_metadata.livemode`),
 * found by its PaymentIntent or by a refund of it. Null when none is recorded (payments from
 * before live mode) or the payment isn't found. */
export type VayadaPaymentRecordedMode = (lookup: {
  propertyId: string;
  paymentIntentId?: string;
  refundId?: string;
}) => Promise<boolean | null>;

/** One provider for every pricing-v2 card path: payments whose account reference is
 * vayada:<property> go to Vayada's own Stripe account, everything else to Stripe Connect as
 * before. Callers keep passing the payment's stored reference, so creating, reading, capturing,
 * cancelling and refunding a vayada Payment charge need no other change.
 *
 * Which keys: a new charge follows the hotel lists (`live.for`: live keys for a live hotel, test
 * keys for the rest). A stored payment (read, capture, cancel, refund) uses the keys of the mode
 * it was made in (`recordedMode`, VAY-2569), whatever the lists say now, so changing the lists
 * never strands older payments on the wrong keys; only a payment with no recorded mode still
 * follows the lists. */
export function routeVayadaPaymentStripe(
  connect: StripeBookingPaymentProvider,
  vayada: VayadaPaymentStripe | undefined,
  live?: { account?: VayadaPaymentStripe; for(propertyId: string): boolean },
  recordedMode?: VayadaPaymentRecordedMode,
): StripeBookingPaymentProvider {
  const accountFor = (ref: string, recorded: boolean | null = null) => {
    const livemode = recorded ?? live?.for(ref.slice("vayada:".length)) === true;
    const account = livemode ? live?.account : vayada;
    if (!account)
      throw new Error(
        `vayada Payment's ${livemode ? "live" : "test"}-mode Stripe account is not configured.`,
      );
    return { ...account, livemode };
  };
  // A stored payment's account: the mode it was made in, the lists only when none is recorded.
  const storedAccountFor = async (
    ref: string,
    lookup: { paymentIntentId: string } | { refundId: string },
  ) =>
    accountFor(
      ref,
      recordedMode
        ? await recordedMode({ propertyId: ref.slice("vayada:".length), ...lookup })
        : null,
    );
  // The stored reference stays on the intent, so identity checks compare like with like. When
  // Stripe's answer doesn't say, the intent carries the mode of the keys it was called with, so a
  // live charge is never recorded as test money (left out of the hotel's live payouts).
  const tagged = (
    intent: StripeBookingPaymentIntent,
    ref: string,
    account: ReturnType<typeof accountFor>,
  ): StripeBookingPaymentIntent => ({
    ...intent,
    providerAccountRef: ref,
    publishableKey: account.publishableKey,
    livemode: typeof intent.livemode === "boolean" ? intent.livemode : account.livemode,
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
      const account = await storedAccountFor(ref, { paymentIntentId });
      const intent = await account.provider.retrievePaymentIntent(paymentIntentId, null);
      return tagged(sameMode(intent, account), ref, account);
    },
    async capturePaymentIntent(paymentIntentId, ref, idempotencyKey) {
      if (!isVayadaPaymentAccountRef(ref))
        return connect.capturePaymentIntent(paymentIntentId, ref, idempotencyKey);
      const account = await storedAccountFor(ref, { paymentIntentId });
      return tagged(
        await account.provider.capturePaymentIntent(paymentIntentId, null, idempotencyKey),
        ref,
        account,
      );
    },
    async cancelPaymentIntent(paymentIntentId, ref, idempotencyKey) {
      if (!isVayadaPaymentAccountRef(ref))
        return connect.cancelPaymentIntent(paymentIntentId, ref, idempotencyKey);
      const account = await storedAccountFor(ref, { paymentIntentId });
      return tagged(
        await account.provider.cancelPaymentIntent(paymentIntentId, null, idempotencyKey),
        ref,
        account,
      );
    },
    async createRefund(input) {
      return isVayadaPaymentAccountRef(input.providerAccountRef)
        ? (
            await storedAccountFor(input.providerAccountRef, {
              paymentIntentId: input.paymentIntentId,
            })
          ).provider.createRefund({
            ...input,
            providerAccountRef: null,
            refundApplicationFee: false,
          })
        : connect.createRefund(input);
    },
    async listRefunds(paymentIntentId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? (await storedAccountFor(ref, { paymentIntentId })).provider.listRefunds(
            paymentIntentId,
            null,
          )
        : connect.listRefunds(paymentIntentId, ref);
    },
    async retrieveRefund(refundId, ref) {
      return isVayadaPaymentAccountRef(ref)
        ? (await storedAccountFor(ref, { refundId })).provider.retrieveRefund(refundId, null)
        : connect.retrieveRefund(refundId, ref);
    },
  };
}
