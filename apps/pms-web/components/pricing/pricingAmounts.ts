import {
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import en from "@/messages/en.json";
import {
  PricingResponseError,
  type PricingSnapshot,
} from "@/services/api/replacementPricingClient";

export type MessageKey = keyof typeof en & keyof typeof import("@/messages/de.json");
export type Translate = (key: string, params?: Record<string, string | number>) => string;
/** English text for helpers that run outside the language provider (and for tests). */
export const english: Translate = (key, params = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    (en as Record<string, string>)[key] ?? key,
  );
/** Keeps the English message for logs and tests; the pricing UI shows `key` in the selected language. */
export class PricingError extends Error {
  constructor(readonly key: MessageKey) {
    super(english(key));
  }
}
/** Translates pricing errors raised in the frontend; other messages, such as API errors, pass through unchanged. */
export const errorText = (cause: unknown, t: Translate, fallback: MessageKey) =>
  cause instanceof PricingError
    ? t(cause.key)
    : cause instanceof PricingResponseError
      ? t("pricing.error.unverified")
      : cause instanceof Error
        ? localizedErrorText(cause, cause.message, t)
        : t(fallback);

type Base = Extract<
  PricingConfiguration["offers"][number]["price"],
  { kind: "independent" }
>["calendar"]["base"];
export function baseAmounts(base: Base, t: Translate = english): [string, string][] {
  if (!base) return [];
  if (base.mode === "occupancy")
    return base.amountsMinor.map((amount, index) => [
      t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 }),
      amount,
    ]);
  if (base.mode === "per_person") return [[t("pricing.perAdult"), base.unitMinor]];
  if (base.mode === "included_guests")
    return [
      [
        t(base.baseGuests === 1 ? "pricing.includedAdults.one" : "pricing.includedAdults.other", {
          count: base.baseGuests,
        }),
        base.baseMinor,
      ],
    ];
  return [[t("pricing.perRoom"), base.amountMinor]];
}
export function decimalAmount(minor: string, scale: number) {
  const digits = minor.padStart(scale + 1, "0");
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export function editedSnapshot(
  snapshot: PricingSnapshot,
  inputs: Record<string, string>,
): PricingSnapshot {
  const scale = pricingCurrencyScale(snapshot.currency)!;
  return {
    ...snapshot,
    ownerReferences: { finance: snapshot.ownerReferences.finance },
    rooms: snapshot.rooms.map((room, ri) => ({
      ...room,
      offers: room.offers.map((offer, oi) => {
        if (offer.price.kind !== "independent" || !offer.price.calendar.base) return offer;
        const base = offer.price.calendar.base,
          values = baseAmounts(base).map(([, minor], ai) =>
            parseMinorInput(
              inputs[`${ri}:${oi}:${ai}`] ?? decimalAmount(minor, scale),
              scale,
              false,
              pricingAmountStep(snapshot.currency),
            ),
          );
        const next =
          base.mode === "flat"
            ? { ...base, amountMinor: values[0] }
            : base.mode === "per_person"
              ? { ...base, unitMinor: values[0] }
              : base.mode === "occupancy"
                ? { ...base, amountsMinor: values }
                : { ...base, baseMinor: values[0] };
        return {
          ...offer,
          price: { ...offer.price, calendar: { ...offer.price.calendar, base: next } },
        };
      }),
    })),
  };
}

/** `step` is the currency's price step in minor units (`pricingAmountStep`): 100 for IDR, which is
 * priced in whole rupiah (VAY-2085), so a fractional rupiah is refused here, not on save. */
export function parseMinorInput(value: string, scale: number, allowZero = false, step = 1) {
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

export function parseAdjustmentInput(input: { kind: string; value: string }, currency: string) {
  if (!["fixed", "percentage"].includes(input.kind) || !/^[+-]?\d+(?:\.\d+)?$/.test(input.value))
    throw new PricingError("pricing.error.adjustmentInvalid");
  const unsigned =
    input.kind === "fixed"
      ? parseMinorInput(
          input.value.replace(/^[+-]/, ""),
          pricingCurrencyScale(currency)!,
          true,
          pricingAmountStep(currency),
        )
      : parseMinorInput(input.value.replace(/^[+-]/, ""), 2, true);
  const signed = BigInt(unsigned) * (input.value.startsWith("-") ? -BigInt("1") : BigInt("1"));
  const adjustment =
    input.kind === "fixed"
      ? { kind: "fixed" as const, deltaMinor: signed.toString() }
      : { kind: "percentage" as const, basisPoints: Number(signed) };
  return adjustment;
}
