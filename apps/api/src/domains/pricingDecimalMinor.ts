import { isMinorAmount } from "@vayada/domain-pms";

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
