import {
  isMinorAmount,
  isPositiveMinor,
  pricingInteger,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms";

const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && v === v.trim();
/** Pure money only: caller supplies resolved same-currency, disjoint charge amounts
 * and an eligible schedule. This is neither charge-owner evidence nor executable
 * Finance readiness. In particular it does not enable deposits in current Finance. */
export function composeReplacementSettlementAmounts(input: unknown) {
  if (
    !pricingObject(input) ||
    !pricingKeys(input, ["subtotalMinor", "charges", "payment"]) ||
    !isMinorAmount(input.subtotalMinor) ||
    !Array.isArray(input.charges) ||
    input.charges.length > 99 ||
    !pricingObject(input.payment)
  )
    return null;
  const payment = input.payment;
  if (
    !(
      (payment.kind === "full" || payment.kind === "pay_at_property") &&
      pricingKeys(payment, ["kind"])
    ) &&
    !(
      payment.kind === "deposit" &&
      pricingKeys(payment, ["kind", "basisPoints"]) &&
      pricingInteger(payment.basisPoints, 1) &&
      payment.basisPoints <= 10000
    )
  )
    return null;
  const ids = new Set<string>();
  let included = 0n,
    additional = 0n,
    atProperty = 0n;
  const lines = [];
  for (const charge of input.charges) {
    if (
      !pricingObject(charge) ||
      !pricingKeys(charge, ["id", "amountMinor", "included", "collect", "basisEvidenceId"]) ||
      !text(charge.id) ||
      ids.has(charge.id) ||
      !isMinorAmount(charge.amountMinor) ||
      typeof charge.included !== "boolean" ||
      !text(charge.basisEvidenceId) ||
      (charge.collect !== "online" && charge.collect !== "property")
    )
      return null;
    ids.add(charge.id);
    const amount = BigInt(charge.amountMinor);
    if (charge.included) included += amount;
    else additional += amount;
    if (charge.collect === "property") atProperty += amount;
    lines.push({
      id: charge.id,
      amountMinor: charge.amountMinor,
      included: charge.included,
      collect: charge.collect,
      basisEvidenceId: charge.basisEvidenceId,
    });
  }
  const subtotal = BigInt(input.subtotalMinor),
    total = subtotal + additional;
  if (included > subtotal || !isPositiveMinor(total.toString())) return null;
  const online = total - atProperty;
  const dueNow =
    payment.kind === "pay_at_property"
      ? 0n
      : payment.kind === "full"
        ? online
        : (total * BigInt(payment.basisPoints as number) + 5000n) / 10000n;
  // Never redirect a property-collected fee into an online deposit or cap the agreed schedule.
  if (online < 0n || dueNow > online) return null;
  return {
    version: "booking.settlement-amounts.v1" as const,
    charges: lines,
    totalMinor: total.toString(),
    includedChargeMinor: included.toString(),
    additionalChargeMinor: additional.toString(),
    propertyCollectedMinor: atProperty.toString(),
    onlineCollectibleMinor: online.toString(),
    dueNowMinor: dueNow.toString(),
    dueLaterMinor: (total - dueNow).toString(),
  };
}
