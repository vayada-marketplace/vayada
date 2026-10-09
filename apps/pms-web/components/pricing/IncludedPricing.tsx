import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount, parseMinorInput, PricingError } from "./pricingAmounts";
export type IncludedInput = { adults: string; adjustments: { kind: string; value: string }[] };
export function includedPrice(
  input: IncludedInput,
  base: string,
  capacity: number,
  scale: number,
  step = 1,
) {
  const baseGuests = Number(input.adults),
    baseMinor = parseMinorInput(base, scale, false, step);
  if (
    !/^\d+$/.test(input.adults) ||
    !Number.isSafeInteger(baseGuests) ||
    baseGuests < 1 ||
    baseGuests > capacity
  )
    throw new PricingError("pricing.included.errorAdults");
  const adjustments = Array.from({ length: capacity }, (_, index) => {
    if (index + 1 === baseGuests) return { kind: "fixed" as const, deltaMinor: "0" };
    const row = input.adjustments[index];
    if (
      !row ||
      !["fixed", "percentage"].includes(row.kind) ||
      !/^[+-]?\d+(?:\.\d+)?$/.test(row.value)
    )
      throw new PricingError("pricing.included.errorAdjustment");
    const unsigned =
      row.kind === "fixed"
        ? parseMinorInput(row.value.replace(/^[+-]/, ""), scale, true, step)
        : parseMinorInput(row.value.replace(/^[+-]/, ""), 2, true);
    const signed = BigInt(unsigned) * (row.value.startsWith("-") ? -BigInt("1") : BigInt("1"));
    const amount =
      row.kind === "fixed"
        ? BigInt(baseMinor) + signed
        : (BigInt(baseMinor) * (BigInt("10000") + signed) + BigInt("5000")) / BigInt("10000");
    if (amount <= BigInt("0") || amount > BigInt("999999999999999999"))
      throw new PricingError("pricing.included.errorRange");
    if (
      row.kind === "percentage" &&
      (signed < -BigInt("10000") || signed > BigInt(Number.MAX_SAFE_INTEGER))
    )
      throw new PricingError("pricing.included.errorPercentage");
    return row.kind === "fixed"
      ? { kind: "fixed" as const, deltaMinor: signed.toString() }
      : { kind: "percentage" as const, basisPoints: Number(signed) };
  });
  return { mode: "included_guests" as const, baseGuests, baseMinor, adjustments };
}
export function includedInput(
  price: Extract<Parameters<typeof baseAmounts>[0], { mode: "included_guests" }>,
  scale: number,
): IncludedInput {
  return {
    adults: String(price.baseGuests),
    adjustments: price.adjustments.map((adjustment) => {
      const minor =
        adjustment.kind === "fixed" ? adjustment.deltaMinor : String(adjustment.basisPoints);
      return {
        kind: adjustment.kind,
        value: `${minor.startsWith("-") ? "-" : ""}${decimalAmount(minor.replace(/^-/, ""), adjustment.kind === "fixed" ? scale : 2)}`,
      };
    }),
  };
}
export function IncludedPricing({
  value,
  capacity,
  disabled,
  onChange,
  label = "",
}: {
  label?: string;
  value: IncludedInput;
  capacity: number;
  disabled: boolean;
  onChange: (value: IncludedInput) => void;
}) {
  const inputClass = "mt-1 block w-full rounded-lg border px-3 py-2";
  const { t } = useTranslation();
  const forLabel = (text: string) =>
    label ? t("pricing.included.forLabel", { text, label }) : text;
  const adults = (index: number, one: string, other: string) =>
    t(index ? other : one, { count: index + 1 });
  return (
    <div className="space-y-3 sm:col-span-2">
      <label className="block text-sm">
        {t("pricing.included.adults")}
        <select
          aria-label={forLabel(t("pricing.included.adults"))}
          className={inputClass}
          disabled={disabled}
          value={value.adults}
          onChange={(event) => onChange({ adults: event.target.value, adjustments: [] })}
        >
          <option value="">{t("pricing.choose")}</option>
          {Array.from({ length: capacity }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-gray-600">{t("pricing.included.hint")}</p>
      {value.adults &&
        Array.from({ length: capacity }, (_, index) => {
          if (index + 1 === Number(value.adults))
            return (
              <p key={index} className="text-sm">
                {adults(index, "pricing.included.baseRow.one", "pricing.included.baseRow.other")}
              </p>
            );
          const row = value.adjustments[index] ?? { kind: "", value: "" };
          const update = (patch: Partial<typeof row>) =>
            onChange({
              ...value,
              adjustments: Array.from({ length: capacity }, (_, i) =>
                i === index
                  ? { ...row, ...patch }
                  : (value.adjustments[i] ?? { kind: "", value: "" }),
              ),
            });
          return (
            <div key={index} className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                {adults(index, "pricing.included.type.one", "pricing.included.type.other")}
                <select
                  aria-label={forLabel(
                    adults(index, "pricing.included.type.one", "pricing.included.type.other"),
                  )}
                  className={inputClass}
                  disabled={disabled}
                  value={row.kind}
                  onChange={(event) => update({ kind: event.target.value, value: "" })}
                >
                  <option value="">{t("pricing.choose")}</option>
                  <option value="fixed">{t("pricing.included.fixed")}</option>
                  <option value="percentage">{t("pricing.included.percentage")}</option>
                </select>
              </label>
              <label className="text-sm">
                {adults(index, "pricing.included.amount.one", "pricing.included.amount.other")}
                {row.kind === "percentage" ? " (%)" : ""}
                <input
                  aria-label={forLabel(
                    adults(index, "pricing.included.amount.one", "pricing.included.amount.other"),
                  )}
                  className={inputClass}
                  disabled={disabled}
                  value={row.value}
                  onChange={(event) => update({ value: event.target.value })}
                />
              </label>
            </div>
          );
        })}
    </div>
  );
}
