import { isMinorAmount, pricingAmountStep, pricingCurrencyScale } from "@vayada/domain-pms";

export function pricingDecimalMinor(value: string, scale: number): string | null {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(scale).replace(/0/g, "")) return null;
  const amount = (
    BigInt(whole!) * 10n ** BigInt(scale) +
    BigInt(fraction.slice(0, scale).padEnd(scale, "0") || "0")
  ).toString();
  return isMinorAmount(amount) ? amount : null;
}

/** Why a saved decimal price does not fit the currency's price step, or null when it does.
 * IDR prices are whole rupiah (VAY-2085). Unknown currencies and malformed decimals are left
 * to the caller's own checks. */
export function pricingDecimalStepIssue(
  field: string,
  value: string,
  currency: string,
): string | null {
  const scale = pricingCurrencyScale(currency);
  if (scale === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const minor = pricingDecimalMinor(value.replace(/^0+(?=\d)/, ""), scale);
  if (minor === null) return `${field} has more decimal places than ${currency} prices allow.`;
  return BigInt(minor) % BigInt(pricingAmountStep(currency)) === 0n
    ? null
    : `${field} must be a whole ${currency} amount without decimals.`;
}
