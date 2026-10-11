"use client";

import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount } from "./pricingAmounts";
import { currencySymbol } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

/** Step 1: the main option's normal price. Typing keeps the editor's `ri:oi:ai` inputs, so saving parses them as
 * before. A price per guest count shows one field per amount; the accessible names stay "<room> Offer N <amount>". */
export function StepPrice({
  room,
  roomIndex,
  offerIndex,
  label,
  inputs,
  disabled,
  onInput,
}: {
  room: PricingConfiguration;
  roomIndex: number;
  offerIndex: number;
  label: string;
  inputs: Record<string, string>;
  disabled: boolean;
  onInput: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const offer = room.offers[offerIndex];
  if (offer.price.kind !== "independent") return null;
  const base = offer.price.calendar.base,
    scale = pricingCurrencyScale(room.currency)!,
    symbol = currencySymbol(room.currency);
  const amounts = baseAmounts(base, t);
  const key = (ai: number) => `${roomIndex}:${offerIndex}:${ai}`;
  return (
    <StepCard
      number={1}
      title={t("pricing.steps.price.title")}
      hint={t("pricing.steps.price.hint")}
    >
      {!base ? (
        <p className={ui.stepHint}>{t("pricing.steps.price.noBase")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {amounts.map(([name, minor], ai) => (
            <label key={ai} className="block">
              {amounts.length > 1 && (
                <span className="mb-1.5 block text-[13px] font-medium text-gray-700">{name}</span>
              )}
              <span className="flex h-12 w-[200px] items-center gap-2 rounded-[10px] bg-gray-100 px-4 focus-within:ring-2 focus-within:ring-primary-500">
                {symbol && (
                  <span aria-hidden="true" className="text-[16px] text-gray-500">
                    {symbol}
                  </span>
                )}
                <input
                  aria-label={`${label} ${name}`}
                  inputMode="decimal"
                  disabled={disabled}
                  value={inputs[key(ai)] ?? decimalAmount(minor, scale)}
                  onChange={(event) => onInput(key(ai), event.target.value)}
                  className="min-w-0 grow bg-transparent text-[18px] font-semibold text-gray-900 outline-none disabled:cursor-not-allowed disabled:text-gray-500"
                />
              </span>
            </label>
          ))}
          <span className="flex h-12 items-center text-[15px] text-gray-700">
            {t(
              base.mode === "per_person"
                ? "pricing.steps.price.perAdultNight"
                : "pricing.steps.price.perNight",
            )}
          </span>
          <span className="flex h-12 items-center rounded-[10px] border border-gray-200 px-3.5 text-[14px] text-gray-700">
            {room.currency}
          </span>
        </div>
      )}
    </StepCard>
  );
}
