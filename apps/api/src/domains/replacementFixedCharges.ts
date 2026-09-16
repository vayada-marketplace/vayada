import { createHash } from "node:crypto";
import {
  parseReplacementStay,
  parsePublicPricingSelection,
  replacementStayKey,
  type ReplacementStay,
} from "@vayada/domain-booking";
import {
  isMinorAmount,
  pricingCurrencyScale,
  pricingInteger,
  pricingKeys,
  pricingObject,
} from "@vayada/domain-pms";
const units = ["booking", "room", "night", "room_night", "person", "person_night"] as const;
type Rule = {
  id: string;
  name: string;
  unit: (typeof units)[number];
  amountMinor: string;
  minimumAge: number | null;
  included: boolean;
  collect: "online" | "property";
};
export type FixedChargePolicy = {
  version: "booking.fixed-charges.v1";
  currency: string;
  charges: Rule[];
};
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200 && v === v.trim();
/** Explicit hotel configuration; no jurisdiction defaults or inferred tax exemptions. */
export function parseFixedChargePolicy(value: unknown): FixedChargePolicy | null {
  if (
    !pricingObject(value) ||
    !pricingKeys(value, ["version", "currency", "charges"]) ||
    value.version !== "booking.fixed-charges.v1" ||
    typeof value.currency !== "string" ||
    pricingCurrencyScale(value.currency) === null ||
    !Array.isArray(value.charges) ||
    value.charges.length > 99
  )
    return null;
  const ids = new Set<string>();
  for (const r of value.charges) {
    if (
      !pricingObject(r) ||
      !pricingKeys(r, ["id", "name", "unit", "amountMinor", "minimumAge", "included", "collect"]) ||
      !text(r.id) ||
      ids.has(r.id) ||
      !text(r.name) ||
      !units.includes(r.unit as Rule["unit"]) ||
      !isMinorAmount(r.amountMinor) ||
      typeof r.included !== "boolean" ||
      (r.collect !== "online" && r.collect !== "property")
    )
      return null;
    const person = r.unit === "person" || r.unit === "person_night";
    if (person ? !pricingInteger(r.minimumAge) || r.minimumAge > 18 : r.minimumAge !== null)
      return null;
    ids.add(r.id);
  }
  const policy = value as FixedChargePolicy;
  return {
    version: policy.version,
    currency: policy.currency,
    charges: policy.charges
      .map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        amountMinor: r.amountMinor,
        minimumAge: r.minimumAge,
        included: r.included,
        collect: r.collect,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
/** Current-owner caller supplies the policy; this pure calculation cannot establish that authority. */
export function calculateReplacementFixedCharges(value: unknown, policyValue: unknown) {
  const stay = parseReplacementStay(value),
    policy = parseFixedChargePolicy(policyValue);
  if (!stay || !policy || stay.currency !== policy.currency || !bounded(stay)) return null;
  const requestKey = replacementStayKey(stay),
    nights = (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000;
  const policyKey = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const basisEvidenceId =
    "booking.fixed-charge-basis.v1:" +
    createHash("sha256")
      .update(JSON.stringify([requestKey, policyKey]))
      .digest("hex");
  let included = 0n,
    additional = 0n;
  const charges = [];
  for (const rule of policy.charges) {
    const guests =
      rule.minimumAge === null
        ? 0
        : stay.rooms.reduce(
            (n, r) =>
              n +
              r.guests.adults +
              r.guests.childAgesAtCheckIn.filter((age) => age >= rule.minimumAge!).length,
            0,
          );
    const quantity =
      rule.unit === "booking"
        ? 1
        : rule.unit === "room"
          ? stay.rooms.length
          : rule.unit === "night"
            ? nights
            : rule.unit === "room_night"
              ? stay.rooms.length * nights
              : rule.unit === "person"
                ? guests
                : guests * nights;
    const amount = BigInt(rule.amountMinor) * BigInt(quantity);
    if (rule.included) included += amount;
    else additional += amount;
    if (!isMinorAmount(amount.toString()) || !isMinorAmount((included + additional).toString()))
      return null;
    charges.push({
      id: rule.id,
      amountMinor: amount.toString(),
      included: rule.included,
      collect: rule.collect,
      basisEvidenceId,
      rule,
      quantity,
    });
  }
  return {
    version: "booking.fixed-charge-amounts.v1" as const,
    requestKey,
    policyKey,
    basisEvidenceId,
    currency: stay.currency,
    charges,
    includedChargeMinor: included.toString(),
    additionalChargeMinor: additional.toString(),
  };
}
function bounded(stay: ReplacementStay): boolean {
  return (
    parsePublicPricingSelection({
      version: stay.addons.some((a) => a.version === "addon-selection.v2")
        ? "public-pricing-selection.v2"
        : "public-pricing-selection.v1",
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      currency: stay.currency,
      addons: stay.addons,
      promoCode: stay.promoCode,
      rooms: stay.rooms.map((r) => ({
        selectionId: r.selectionId,
        publicOfferKey: r.offerId,
        guests: r.guests,
      })),
    }) !== null
  );
}
