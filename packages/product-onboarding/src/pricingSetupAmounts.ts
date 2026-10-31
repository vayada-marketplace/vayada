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

/** Whether a currency is priced in whole units: its price step is one unit (IDR, whole rupiah since
 * VAY-2085; JPY). */
const wholeUnits = (scale: number, step: number) => step === 10 ** scale;
/** Thousands groups as people type them: 500.000, 500,000 or 500 000 (also with a no-break space).
 * In a whole-unit currency three digits after a separator can only be a group. */
const grouped = /^\d{1,3}([.,\u0020\u00A0\u202F])\d{3}(?:\1\d{3})*$/;

/** An amount as a price field shows it. `step` (`pricingAmountStep`) drops the zero fraction of a
 * whole-unit currency: "500000", not "500000.00" (VAY-2425). */
export function decimalAmount(minor: string, scale: number, step = 1) {
  const digits = minor.padStart(scale + 1, "0");
  if (!scale) return digits;
  const whole = digits.slice(0, -scale),
    fraction = digits.slice(-scale);
  return wholeUnits(scale, step) && /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
}

/** `step` is the currency's price step in minor units (`pricingAmountStep`): 100 for IDR, which is
 * priced in whole rupiah (VAY-2085), so a fractional rupiah is refused here, not on save. A
 * whole-unit currency also takes thousands separators (VAY-2425). */
export function parseMinorInput(value: string, scale: number, allowZero = false, step = 1) {
  if (wholeUnits(scale, step) && grouped.test(value)) value = value.replace(/\D/g, "");
  if (
    !new RegExp(`^\\d+(?:\\.\\d{1,${scale || 1}})?$`).test(value) ||
    (!scale && value.includes("."))
  )
    throw new PricingError("pricing.error.invalidPrice");
  const [whole, fraction = ""] = value.split("."),
    minor = `${whole}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=\d)/, "");
  if (!allowZero && minor === "0") throw new PricingError("pricing.error.priceZero");
  if (minor.length > 18) throw new PricingError("pricing.error.priceTooLarge");
  if (BigInt(minor) % BigInt(step) !== BigInt(0))
    throw new PricingError("pricing.error.wholeUnitsOnly");
  return minor;
}
