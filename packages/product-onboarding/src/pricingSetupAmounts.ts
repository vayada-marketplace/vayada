import { PricingResponseError } from "./replacementPricingClient";
import { englishPricingSetup, type Translate } from "./firstPricingSetupMessages";

/** A pricing input failure; `key` names its message in the app's catalog, `message` stays English for logs. */
export class PricingError extends Error {
  constructor(
    readonly key: string,
    message = englishPricingSetup(key),
  ) {
    super(message);
  }
}

export const setupErrorText = (cause: unknown, t: Translate, fallback: string) =>
  cause instanceof PricingError
    ? t(cause.key)
    : cause instanceof PricingResponseError
      ? t("pricing.error.unverified")
      : t(fallback);

export function decimalAmount(minor: string, scale: number) {
  const digits = minor.padStart(scale + 1, "0");
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}

export function parseMinorInput(value: string, scale: number, allowZero = false) {
  if (
    !new RegExp(`^\\d+(?:\\.\\d{1,${scale || 1}})?$`).test(value) ||
    (!scale && value.includes("."))
  )
    throw new PricingError("pricing.error.invalidPrice");
  const [whole, fraction = ""] = value.split("."),
    minor = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (!allowZero && minor === "0") throw new PricingError("pricing.error.priceZero");
  if (minor.length > 18) throw new PricingError("pricing.error.priceTooLarge");
  return minor;
}
