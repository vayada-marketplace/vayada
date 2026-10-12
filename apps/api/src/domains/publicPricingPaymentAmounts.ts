import { createHash } from "node:crypto";
import { isManualPricingPaymentMethod, isPricingPaymentMethod } from "@vayada/domain-booking";
import type { PoolClient } from "pg";
import { lockPublicPricingChargeTotals } from "./publicPricingChargeTotals.js";
import { composeReplacementSettlementAmounts } from "./replacementSettlementAmounts.js";
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );

/** Caller-owned READ COMMITTED transaction. Internal amounts, not payment execution. */
export async function lockPublicPricingPaymentAmounts(
  client: PoolClient,
  slug: unknown,
  input: unknown,
  method: unknown,
) {
  if (!isPricingPaymentMethod(method)) return null;
  const total = await lockPublicPricingChargeTotals(client, slug, input);
  if (!total) return null;
  const owner = total.components.room.owner;
  if (!owner.finance.methods.includes(method)) return null;
  const selectedTerms = total.stay.rooms.map((room) =>
    owner.terms.find(
      (terms) => terms.roomTypeId === room.roomTypeId && terms.offerId === room.offerId,
    ),
  );
  if (
    selectedTerms.some(
      (terms) =>
        !terms || terms.payment.kind !== "full" || !terms.payment.acceptedMethods?.includes(method),
    )
  )
    return null;
  const terms = selectedTerms.map((t) => t!);
  if (new Set(terms.map((t) => canonical(t.cancellation))).size !== 1) return null;
  const amounts = composeReplacementSettlementAmounts(
    {
      subtotalMinor: total.subtotalMinor,
      charges: total.charges.charges.map(
        ({ id, amountMinor, included, collect, basisEvidenceId }) => ({
          id,
          amountMinor,
          included,
          collect,
          basisEvidenceId,
        }),
      ),
      // Card, bank transfer and PayPal are all paid before the stay; only pay at property is later.
      payment: { kind: method === "pay_at_property" ? "pay_at_property" : "full" },
    },
    total.stay.currency,
  );
  if (!amounts || amounts.totalMinor !== total.totalMinor) return null;
  // Bank transfer and PayPal are paid in full to the hotel; charges collected at the property
  // are not supported for them (VAY-2139).
  if (isManualPricingPaymentMethod(method) && amounts.dueLaterMinor !== "0") return null;
  const paymentEvidenceId =
    "booking.payment-amounts.v1:" +
    createHash("sha256")
      .update(
        canonical({
          requestKey: total.requestKey,
          sources: total.componentSources,
          method,
          finance: owner.finance.evidenceId,
          terms,
          amounts,
        }),
      )
      .digest("hex");
  return {
    kind: "pricing_payment_amounts" as const,
    evaluatorVersion: "booking.payment-amounts.v1" as const,
    total,
    method,
    selectedTerms: terms,
    financeEvidenceId: owner.finance.evidenceId,
    paymentEvidenceId,
    ...amounts,
  };
}
