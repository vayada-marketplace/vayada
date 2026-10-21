import { Buffer } from "node:buffer";

type StripeFetch = typeof globalThis.fetch;
type StripeObject = Record<string, unknown>;

export type StripeBookingPaymentIntent = {
  paymentIntentId: string;
  clientSecret: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  propertyId: string | null;
  bookingReference: string | null;
  providerAccountRef: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  /** From the expanded latest charge (retrieve/capture), for reconciliation (VAY-2205). */
  amountRefundedMinor?: number | null;
  disputed?: boolean;
  feeBreakdown?: {
    balanceTransactionId: string;
    chargeId: string;
    currency: string;
    grossAmountMinor: number;
    processorFeeAmountMinor: number;
    applicationFeeAmountMinor: number;
    netPayoutAmountMinor: number;
  } | null;
};

/** A refund of a booking's card payment on the hotel's connected account (VAY-2205). */
export type StripeBookingRefund = {
  refundId: string;
  /** pending, requires_action, succeeded, failed or canceled. */
  status: string;
  amountMinor: number;
  currency: string;
  paymentIntentId: string;
  /** The refund command that asked for it, from its metadata. */
  commandId: string | null;
  failureReason: string | null;
};

export type StripeBookingPaymentProvider = {
  createPaymentIntent(input: {
    propertyId: string;
    bookingReference: string;
    providerAccountRef: string;
    amountMinor: number;
    applicationFeeAmountMinor: number;
    currency: string;
    captureMethod: "automatic" | "manual";
    idempotencyKey: string;
  }): Promise<StripeBookingPaymentIntent>;
  retrievePaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
  ): Promise<StripeBookingPaymentIntent>;
  capturePaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
    idempotencyKey: string,
  ): Promise<StripeBookingPaymentIntent>;
  cancelPaymentIntent(
    paymentIntentId: string,
    providerAccountRef: string | null,
    idempotencyKey: string,
  ): Promise<StripeBookingPaymentIntent>;
  /** Refunds part or all of a captured payment and Vayada's fee in proportion. Marked
   * `vayada_source=pricing_v2`, so the legacy Connect webhook leaves it alone. */
  createRefund(input: {
    paymentIntentId: string;
    providerAccountRef: string;
    amountMinor: number;
    /** Whether the charge carries Vayada's application fee. Stripe refuses
     * `refund_application_fee` on a charge without one (a fixed-plan hotel's), refund and all. */
    refundApplicationFee: boolean;
    commandId: string;
    propertyId: string;
    bookingReference: string;
    idempotencyKey: string;
  }): Promise<StripeBookingRefund>;
  /** Every refund of a payment, newest first: a retry looks here before it asks again. */
  listRefunds(paymentIntentId: string, providerAccountRef: string): Promise<StripeBookingRefund[]>;
  retrieveRefund(refundId: string, providerAccountRef: string): Promise<StripeBookingRefund>;
};

const REFUND_TIMEOUT_MS = 30_000;

export function createStripeBookingPaymentProvider(config: {
  secretKey: string;
  endpoint?: string;
  fetch?: StripeFetch;
}): StripeBookingPaymentProvider {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    fields: ReadonlyArray<readonly [string, string]> = [],
    idempotencyKey?: string,
    providerAccountRef?: string | null,
    /** Refund calls hold a refund row lock while they wait (VAY-2205): give up after this long. */
    timeoutMs?: number,
  ): Promise<StripeObject> => {
    const form = new URLSearchParams(fields.map(([key, value]): [string, string] => [key, value]));
    const response = await fetchImpl(
      `${endpoint}${path}${method === "GET" && fields.length ? `?${form}` : ""}`,
      {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(providerAccountRef ? { "Stripe-Account": providerAccountRef } : {}),
        },
        ...(method === "POST" ? { body: form.toString() } : {}),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      },
    );
    const payload = object(await response.json());
    if (!response.ok) {
      // The status tells a definite refusal (4xx) from an answer that may have been lost.
      throw Object.assign(
        new Error(
          text(object(payload["error"])["message"]) ?? `Stripe failed (${response.status}).`,
        ),
        { statusCode: response.status },
      );
    }
    return payload;
  };

  return {
    async createPaymentIntent(input) {
      const intent = paymentIntent(
        await request(
          "POST",
          "/payment_intents",
          [
            ["amount", String(input.amountMinor)],
            ["currency", input.currency.toLowerCase()],
            ["capture_method", input.captureMethod],
            ["payment_method_types[0]", "card"],
            ["metadata[vayada_property_id]", input.propertyId],
            ["metadata[vayada_booking_reference]", input.bookingReference],
            ...(input.applicationFeeAmountMinor > 0
              ? [["application_fee_amount", String(input.applicationFeeAmountMinor)] as const]
              : []),
          ],
          input.idempotencyKey,
          input.providerAccountRef,
        ),
        input.providerAccountRef,
      );
      if (
        intent.propertyId !== input.propertyId ||
        intent.bookingReference !== input.bookingReference ||
        intent.providerAccountRef !== input.providerAccountRef
      ) {
        throw new Error("Stripe replayed a PaymentIntent for a different property booking.");
      }
      return intent;
    },

    async retrievePaymentIntent(paymentIntentId, providerAccountRef) {
      return paymentIntent(
        await request(
          "GET",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
          [
            ["expand[]", "payment_method"],
            ["expand[]", "latest_charge.balance_transaction"],
          ],
          undefined,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },

    async capturePaymentIntent(paymentIntentId, providerAccountRef, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
          [["expand[]", "latest_charge.balance_transaction"]],
          idempotencyKey,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },

    async createRefund(input) {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
        throw new Error("A Stripe refund needs a positive amount.");
      const created = refund(
        await request(
          "POST",
          "/refunds",
          [
            ["payment_intent", input.paymentIntentId],
            ["amount", String(input.amountMinor)],
            ...(input.refundApplicationFee ? [["refund_application_fee", "true"] as const] : []),
            ["reason", "requested_by_customer"],
            ["metadata[vayada_source]", "pricing_v2"],
            ["metadata[vayada_refund_command_id]", input.commandId],
            ["metadata[vayada_property_id]", input.propertyId],
            ["metadata[vayada_booking_reference]", input.bookingReference],
          ],
          input.idempotencyKey,
          input.providerAccountRef,
          REFUND_TIMEOUT_MS,
        ),
      );
      if (
        created.paymentIntentId !== input.paymentIntentId ||
        created.commandId !== input.commandId ||
        created.amountMinor !== input.amountMinor
      )
        throw new Error("Stripe replayed a refund for a different command.");
      return created;
    },

    async listRefunds(paymentIntentId, providerAccountRef) {
      const list = await request(
        "GET",
        "/refunds",
        [
          ["payment_intent", paymentIntentId],
          ["limit", "100"],
        ],
        undefined,
        providerAccountRef,
        REFUND_TIMEOUT_MS,
      );
      if (!Array.isArray(list["data"]) || list["has_more"] === true)
        throw new Error("Stripe returned an incomplete refund list.");
      return list["data"].map((value) => refund(object(value)));
    },

    async retrieveRefund(refundId, providerAccountRef) {
      return refund(
        await request(
          "GET",
          `/refunds/${encodeURIComponent(refundId)}`,
          [],
          undefined,
          providerAccountRef,
          REFUND_TIMEOUT_MS,
        ),
      );
    },

    async cancelPaymentIntent(paymentIntentId, providerAccountRef, idempotencyKey) {
      return paymentIntent(
        await request(
          "POST",
          `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
          [],
          idempotencyKey,
          providerAccountRef,
        ),
        providerAccountRef,
      );
    },
  };
}

function paymentIntent(
  value: StripeObject,
  requestProviderAccountRef: string | null,
): StripeBookingPaymentIntent {
  const paymentIntentId = text(value["id"]);
  const status = text(value["status"]);
  const amountMinor = Number(value["amount"]);
  const currency = text(value["currency"]);
  if (
    !paymentIntentId ||
    !status ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0 ||
    !currency
  ) {
    throw new Error("Stripe returned an invalid PaymentIntent.");
  }
  const card = object(object(value["payment_method"])["card"]);
  const charge = object(value["latest_charge"]);
  const balanceTransaction = object(charge["balance_transaction"]);
  const balanceTransactionId = text(balanceTransaction["id"]);
  const chargeId = text(charge["id"]);
  const balanceCurrency = text(balanceTransaction["currency"]);
  const balanceGross = integer(balanceTransaction["amount"]);
  const balanceFee = integer(balanceTransaction["fee"]);
  const balanceNet = signedInteger(balanceTransaction["net"]);
  const feeDetails = Array.isArray(balanceTransaction["fee_details"])
    ? balanceTransaction["fee_details"].map(object)
    : [];
  const applicationFeeAmountMinor = feeDetails
    .filter((fee) => text(fee["type"]) === "application_fee")
    .reduce((sum, fee) => sum + (integer(fee["amount"]) ?? 0), 0);
  const detailedProcessorFeeAmountMinor = feeDetails
    .filter((fee) => text(fee["type"]) !== "application_fee")
    .reduce((sum, fee) => sum + (integer(fee["amount"]) ?? 0), 0);
  const processorFeeAmountMinor =
    balanceFee !== null &&
    applicationFeeAmountMinor + detailedProcessorFeeAmountMinor !== balanceFee
      ? Math.max(balanceFee - applicationFeeAmountMinor, 0)
      : detailedProcessorFeeAmountMinor;
  return {
    paymentIntentId,
    clientSecret: text(value["client_secret"]),
    status,
    amountMinor,
    currency: currency.toUpperCase(),
    propertyId: text(object(value["metadata"])["vayada_property_id"]),
    bookingReference: text(object(value["metadata"])["vayada_booking_reference"]),
    providerAccountRef:
      requestProviderAccountRef ?? text(object(value["transfer_data"])["destination"]),
    cardBrand: text(card["brand"]),
    cardLast4: /^\d{4}$/.test(text(card["last4"]) ?? "") ? text(card["last4"]) : null,
    amountRefundedMinor: chargeId ? integer(charge["amount_refunded"]) : null,
    disputed: charge["disputed"] === true,
    feeBreakdown:
      balanceTransactionId &&
      chargeId &&
      balanceCurrency &&
      balanceGross !== null &&
      balanceFee !== null &&
      balanceNet !== null &&
      applicationFeeAmountMinor + processorFeeAmountMinor === balanceFee
        ? {
            balanceTransactionId,
            chargeId,
            currency: balanceCurrency.toUpperCase(),
            grossAmountMinor: balanceGross,
            processorFeeAmountMinor,
            applicationFeeAmountMinor,
            netPayoutAmountMinor: balanceNet,
          }
        : null,
  };
}

function refund(value: StripeObject): StripeBookingRefund {
  const refundId = text(value["id"]);
  const status = text(value["status"]);
  const amountMinor = Number(value["amount"]);
  const currency = text(value["currency"]);
  const paymentIntentId = text(value["payment_intent"]);
  if (
    !refundId ||
    !status ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !currency ||
    !paymentIntentId
  )
    throw new Error("Stripe returned an invalid refund.");
  return {
    refundId,
    status,
    amountMinor,
    currency: currency.toUpperCase(),
    paymentIntentId,
    commandId: text(object(value["metadata"])["vayada_refund_command_id"]),
    failureReason: text(value["failure_reason"]),
  };
}

function integer(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function signedInteger(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}
