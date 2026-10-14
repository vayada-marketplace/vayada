"use client";

import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { baseAmounts, decimalAmount } from "./pricingAmounts";
import { adjustmentText, currencySymbol, money } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

/** The card's price section: the main option's normal price. Typing keeps the editor's `ri:oi:ai` inputs, so saving
 * parses them as before. A price per guest count shows one field per amount; the accessible names stay "<room> Offer
 * N <amount>". A main price with a meal says so, and its Edit opens the option's window. */
export function StepPrice({
  room,
  roomIndex,
  offerIndex,
  label,
  inputs,
  disabled,
  onInput,
  onEditMeal,
}: {
  room: PricingConfiguration;
  roomIndex: number;
  offerIndex: number;
  label: string;
  inputs: Record<string, string>;
  disabled: boolean;
  onInput: (key: string, value: string) => void;
  onEditMeal: () => void;
}) {
  const { t } = useTranslation();
  const offer = room.offers[offerIndex];
  if (offer.price.kind !== "independent") return null;
  const base = offer.price.calendar.base,
    scale = pricingCurrencyScale(room.currency)!,
    symbol = currencySymbol(room.currency);
  const amounts = baseAmounts(base, t);
  // An included-guest price's other guest counts and their adjustments ("1 adult −€30").
  const others =
    base?.mode === "included_guests"
      ? base.adjustments
          .map((adjustment, index) =>
            index + 1 === base.baseGuests
              ? ""
              : `${t(index ? "pricing.adults.other" : "pricing.adults.one", { count: index + 1 })} ${adjustmentText(adjustment, room.currency)}`,
          )
          .filter(Boolean)
          .join(" · ")
      : "";
  const key = (ai: number) => `${roomIndex}:${offerIndex}:${ai}`;
  const meal = offer.meal;
  return (
    <StepCard title={t("pricing.steps.price.title")}>
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
                : base.mode === "flat"
                  ? "pricing.simple.perRoomNight"
                  : "pricing.steps.price.perNight",
            )}
          </span>
          {/* The field shows the symbol; a currency without one (CHF) is named here. */}
          {!symbol && (
            <span className="flex h-12 items-center rounded-[10px] border border-gray-200 px-3.5 text-[14px] text-gray-700">
              {room.currency}
            </span>
          )}
          {/* Included-guest prices change by guest count; the option's Edit window edits these steps. */}
          {base.mode === "included_guests" && (
            <p className={`w-full ${ui.stepHint}`}>
              {t(others ? "pricing.steps.price.included" : "pricing.steps.price.includedOnly", {
                adults: t(base.baseGuests === 1 ? "pricing.adults.one" : "pricing.adults.other", {
                  count: base.baseGuests,
                }),
                steps: others,
              })}
            </p>
          )}
        </div>
      )}
      {/* What the price includes, with the option's window (meal, cancellation and payment details) behind Edit. */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-gray-600">
        {meal.kind === "room_only"
          ? t("pricing.simple.roomOnly")
          : t("pricing.simple.mealIncluded", {
              meal: t(`pricing.meal.${meal.kind}`),
              amount: t(
                meal.charge.kind === "room"
                  ? "pricing.simple.extras.perRoomAmount"
                  : "pricing.simple.extras.perAdultAmount",
                {
                  amount: money(
                    meal.charge.kind === "room" ? meal.charge.amountMinor : meal.charge.adultMinor,
                    room.currency,
                  ),
                },
              ),
            })}
        <button
          type="button"
          aria-label={t("pricing.simple.mealEdit")}
          disabled={disabled}
          onClick={onEditMeal}
          className={ui.stepLink}
        >
          {t("pricing.steps.options.edit")}
        </button>
      </p>
    </StepCard>
  );
}
