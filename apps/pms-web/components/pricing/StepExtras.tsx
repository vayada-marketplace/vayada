"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { decimalAmount, errorText, parseMinorInput } from "./pricingAmounts";
import {
  defaultDiscount,
  setBreakfastAmount,
  setDiscount,
  setMealDescription,
  switchOption,
  type SimpleRoom,
} from "./simplePricing";
import { money, sampleAdults } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Kind = "non_refundable" | "breakfast";
type Field = Kind | "mealText";
const basisPoints = (offer: SimpleRoom["nonRefundable"]) =>
  offer?.price.kind === "linked" && offer.price.adjustment.kind === "percentage"
    ? -offer.price.adjustment.basisPoints
    : null;
/** A typed amount in minor units, or null while it doesn't parse. */
const typedMinor = (text: string, scale: number) => {
  try {
    return parseMinorInput(text.trim(), scale);
  } catch {
    return null;
  }
};

/** The card's two switches: a non-refundable option some percent cheaper, and an option with breakfast. On adds the
 * option (based on the main option, with its stay rules and payment); off asks to delete it. An amount that doesn't
 * parse holds Save until it does, while its option is on. `preview` (step "Meals") sits beside the card, and stays when
 * the room offers no breakfast switch. */
export function StepExtras({
  room,
  simple,
  prices,
  only,
  disabled,
  onAdd,
  onRemove,
  onChange,
  onPending,
  preview,
}: {
  room: PricingConfiguration;
  simple: SimpleRoom;
  /** Just this switch: the non-refundable one is a rate in step "Rates" (VAY-2282). */
  only?: Kind;
  /** Each option's normal night for the sample guests (see `normalNight`). */
  prices: Readonly<Record<string, string | null>>;
  disabled: boolean;
  /** Adds a switch's option; returns why it couldn't. */
  onAdd: (input: ReturnType<typeof switchOption>) => unknown;
  onRemove: (offerId: string) => void;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
  preview?: ReactNode;
}) {
  const { t } = useTranslation();
  const scale = pricingCurrencyScale(room.currency)!;
  const { nonRefundable, breakfast, mainTerms } = simple;
  const charge = breakfast && breakfast.meal.kind !== "room_only" ? breakfast.meal.charge : null;
  const savedDiscount = basisPoints(nonRefundable);
  const savedMinor = charge
    ? charge.kind === "room"
      ? charge.amountMinor
      : charge.adultMinor
    : null;
  const [discount, setDiscountText] = useState(
    savedDiscount === null ? defaultDiscount : String(savedDiscount / 100),
  );
  const [amount, setAmount] = useState(savedMinor === null ? "" : decimalAmount(savedMinor, scale));
  const savedText = breakfast?.meal.description ?? "";
  const [mealText, setMealText] = useState(savedText);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const errorId = useId();
  // A reload or a reset brings the saved values back. Typing changes the saved value too, so text that already
  // means it ("1", "12.") stays as typed.
  useEffect(() => {
    if (savedDiscount !== null)
      setDiscountText((typed) =>
        Math.round(Number(typed.trim()) * 100) === savedDiscount
          ? typed
          : String(savedDiscount / 100),
      );
  }, [savedDiscount]);
  useEffect(() => {
    if (savedMinor !== null)
      setAmount((typed) =>
        typedMinor(typed, scale) === savedMinor ? typed : decimalAmount(savedMinor, scale),
      );
  }, [savedMinor, scale]);
  useEffect(
    () => setMealText((typed) => (typed.trim() === savedText ? typed : savedText)),
    [savedText],
  );
  // The editor's callback is new on every render, so it is read through a ref.
  const pendingRef = useRef(onPending);
  useEffect(() => {
    pendingRef.current = onPending;
  });
  // Only an option that is on has a value to hold Save for; a switch that is off just shows why it didn't turn on.
  const pending = !!(
    (errors.non_refundable && nonRefundable) ||
    ((errors.breakfast || errors.mealText) && breakfast)
  );
  useEffect(() => pendingRef.current(pending), [pending]);
  const fail = (kind: Field, cause: unknown) =>
    setErrors((previous) => ({
      ...previous,
      [kind]: errorText(cause, t, "pricing.linkedOffer.errorCheck"),
    }));
  const clear = (kind: Field) => setErrors((previous) => ({ ...previous, [kind]: undefined }));
  const editText = (value: string) => {
    setMealText(value);
    if (!breakfast) return;
    try {
      onChange(setMealDescription(room, breakfast.id, value));
      clear("mealText");
    } catch (cause) {
      fail("mealText", cause);
    }
  };
  /** Applies a typed value to an option that is on; a value that doesn't parse stays typed and holds Save. */
  const edit = (kind: Kind, value: string) => {
    if (kind === "non_refundable") setDiscountText(value);
    else setAmount(value);
    const offer = kind === "non_refundable" ? nonRefundable : breakfast;
    if (!offer) return clear(kind);
    try {
      onChange(
        kind === "non_refundable"
          ? setDiscount(room, offer.id, value)
          : setBreakfastAmount(room, offer.id, value),
      );
      clear(kind);
    } catch (cause) {
      fail(kind, cause);
    }
  };
  const toggle = (kind: Kind) => {
    if (disabled) return;
    const offer = kind === "non_refundable" ? nonRefundable : breakfast;
    if (offer) {
      // Off drops a value that didn't parse: the option and its amount go together.
      clear(kind);
      if (kind === "non_refundable")
        setDiscountText(savedDiscount === null ? defaultDiscount : String(savedDiscount / 100));
      else if (savedMinor !== null) setAmount(decimalAmount(savedMinor, scale));
      return onRemove(offer.id);
    }
    if (kind === "breakfast" && !amount.trim())
      return setErrors((previous) => ({
        ...previous,
        breakfast: t("pricing.simple.extras.amountMissing"),
      }));
    try {
      const failure = onAdd(
        switchOption(
          room,
          crypto.randomUUID(),
          kind,
          kind === "non_refundable"
            ? { percent: discount }
            : { amount, basis: charge?.kind ?? "person" },
          mainTerms,
        ),
      );
      if (failure) fail(kind, failure);
      else clear(kind);
    } catch (cause) {
      fail(kind, cause);
    }
  };
  const adults = sampleAdults(room);
  const night = (offerId: string | undefined, forGuests: boolean) => {
    const price = offerId ? prices[offerId] : null;
    if (!price) return null;
    const amount = money(price, room.currency);
    return forGuests
      ? t(
          adults === 1
            ? "pricing.simple.extras.nightFor.one"
            : "pricing.simple.extras.nightFor.other",
          { amount, count: adults },
        )
      : t("pricing.simple.extras.night", { amount });
  };
  const row = (kind: Kind, on: boolean, name: string, field: ReactNode, price: string | null) => (
    <SwitchRow
      on={on}
      name={name}
      disabled={disabled}
      onToggle={() => toggle(kind)}
      field={field}
      price={price}
    />
  );
  const input = (kind: Kind, value: string, label: string, width: string) => (
    <input
      aria-label={label}
      aria-invalid={!!errors[kind] || undefined}
      aria-describedby={errors[kind] ? `${errorId}-${kind}` : undefined}
      inputMode="decimal"
      disabled={disabled}
      value={value}
      onChange={(event) => edit(kind, event.target.value)}
      className={`${width} ${extraField}`}
    />
  );
  const showNonRefundable = only !== "breakfast" && simple.cancellation.kind === "free",
    showBreakfast = only !== "non_refundable" && simple.cancellation.kind !== "own";
  if (!showNonRefundable && !showBreakfast)
    return preview ? <div className="border-t border-gray-200 py-7">{preview}</div> : null;
  // Just breakfast is step "Meals" of "Price rules" (VAY-2280); the non-refundable switch is a rate.
  return (
    <StepCard
      step={only === "breakfast" ? 4 : undefined}
      title={t(only === "breakfast" ? "pricing.meals.title" : "pricing.simple.extras.title")}
      hint={t(only === "breakfast" ? "pricing.meals.hint" : "pricing.simple.extras.hint")}
      optional
      side={preview}
    >
      <div>
        {showNonRefundable &&
          row(
            "non_refundable",
            !!nonRefundable,
            t("pricing.simple.extras.nonRefundable"),
            <>
              {input("non_refundable", discount, t("pricing.simple.extras.discountLabel"), "w-16")}
              {t("pricing.simple.extras.cheaper")}
            </>,
            night(nonRefundable?.id, false),
          )}
        {showBreakfast &&
          row(
            "breakfast",
            !!breakfast,
            t("pricing.simple.extras.breakfast"),
            <>
              +{input("breakfast", amount, t("pricing.simple.extras.breakfastLabel"), "w-24")}
              {t(
                charge?.kind === "room"
                  ? "pricing.simple.extras.perRoom"
                  : "pricing.simple.extras.perAdult",
              )}
            </>,
            night(breakfast?.id, true),
          )}
        {/* What guests read about breakfast (VAY-2281), in the Meals step. */}
        {only === "breakfast" && breakfast && (
          <label className="block space-y-1.5 pb-1">
            <span className="block text-[13px] text-gray-600">{t("pricing.mealText.label")}</span>
            <input
              aria-invalid={!!errors.mealText || undefined}
              aria-describedby={errors.mealText ? `${errorId}-mealText` : undefined}
              maxLength={200}
              disabled={disabled}
              value={mealText}
              placeholder={t("pricing.mealText.placeholder")}
              onChange={(event) => editText(event.target.value)}
              className={`w-full ${ui.field}`}
            />
          </label>
        )}
      </div>
      {(errors.non_refundable || errors.breakfast || errors.mealText) && (
        <div role="alert" className={ui.errorText}>
          {errors.non_refundable && <p id={`${errorId}-non_refundable`}>{errors.non_refundable}</p>}
          {errors.breakfast && <p id={`${errorId}-breakfast`}>{errors.breakfast}</p>}
          {errors.mealText && <p id={`${errorId}-mealText`}>{errors.mealText}</p>}
        </div>
      )}
    </StepCard>
  );
}

/** A switch's typed amount (percent, price). */
export const extraField =
  "h-10 rounded-[10px] bg-gray-100 px-3 text-[15px] font-semibold text-gray-900 outline-none focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed";

/** One extra choice: its switch, name, amount field and nightly price. Also used by the first-price form. */
export function SwitchRow({
  on,
  name,
  disabled,
  onToggle,
  field,
  price,
}: {
  on: boolean;
  name: string;
  disabled: boolean;
  onToggle: () => void;
  field: ReactNode;
  price?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-gray-100 py-2 [&:not(:last-child)]:border-b">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={t("pricing.simple.extras.turnOn", { name })}
        disabled={disabled}
        onClick={onToggle}
        className={ui.switchTrack(on)}
      >
        <span aria-hidden="true" className="h-[18px] w-[18px] rounded-full bg-white shadow-sm" />
      </button>
      <span className="w-36 text-[15px] font-medium text-gray-900">{name}</span>
      <span
        className={`flex items-center gap-2 text-[15px] ${on ? "text-gray-700" : "text-gray-400"}`}
      >
        {field}
      </span>
      {price && <span className="ml-auto text-[14px] text-gray-500">{price}</span>}
    </div>
  );
}
