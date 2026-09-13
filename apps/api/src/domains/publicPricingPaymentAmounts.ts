import { createHash } from "node:crypto";
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
  if (method !== "card" && method !== "pay_at_property") return null;
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
  const amounts = composeReplacementSettlementAmounts({
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
    payment: { kind: method === "card" ? "full" : "pay_at_property" },
  });
  if (!amounts || amounts.totalMinor !== total.totalMinor) return null;
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
