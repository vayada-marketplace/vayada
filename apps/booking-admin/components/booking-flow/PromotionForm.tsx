"use client";
import { useTranslation } from "@/lib/i18n";

import { useState, type FormEvent, type ReactNode } from "react";
import {
  AdjustmentsHorizontalIcon,
  CalendarDaysIcon,
  ClockIcon,
  MoonIcon,
  SunIcon,
} from "@heroicons/react/24/outline";
import type { BookingPromotion } from "@/services/api/bookingLastMinuteSettingsClient";
import { Input } from "@/components/ui";
import type { PromoRoomType } from "./PromoCodesTab";
import { ChoiceCard, EditorModal, EditorSectionHeading } from "./EditorModal";

type PromotionType = BookingPromotion["type"];
type Translate = ReturnType<typeof useTranslation>["t"];

export const names = {
  LAST_MINUTE: "admin.lastMinuteEscape",
  EARLY_BIRD: "admin.earlyBird",
  EXTENDED_STAY: "admin.extendedStay",
  MIDWEEK: "admin.midweekGetaway",
};
export const promotionIcons = {
  LAST_MINUTE: ClockIcon,
  EARLY_BIRD: SunIcon,
  EXTENDED_STAY: MoonIcon,
  MIDWEEK: CalendarDaysIcon,
};
/** Type menu label and one-line description (VAY-2234). */
export const promotionTypeCopy: Record<PromotionType, { label: string; description: string }> = {
  LAST_MINUTE: { label: "admin.lastMinute", description: "admin.lastMinuteDescription" },
  EARLY_BIRD: { label: "admin.earlyBird", description: "admin.earlyBirdDescription" },
  EXTENDED_STAY: { label: "admin.extendedStay", description: "admin.extendedStayDescription" },
  MIDWEEK: { label: "admin.midweek", description: "admin.midweekDescription" },
};
const titles: Record<PromotionType, { create: string; edit: string }> = {
  LAST_MINUTE: { create: "admin.newLastMinutePromotion", edit: "admin.editLastMinutePromotion" },
  EARLY_BIRD: { create: "admin.newEarlyBirdPromotion", edit: "admin.editEarlyBirdPromotion" },
  EXTENDED_STAY: {
    create: "admin.newExtendedStayPromotion",
    edit: "admin.editExtendedStayPromotion",
  },
  MIDWEEK: { create: "admin.newMidweekPromotion", edit: "admin.editMidweekPromotion" },
};
// Chip choices; a saved value outside them is shown as one more chip so it survives a save.
const WINDOW_DAYS = [1, 2, 3, 5, 7];
const AHEAD_DAYS = [30, 60, 90];

export const fresh = (type: PromotionType): BookingPromotion => ({
  type,
  active: true,
  roomTypeIds: [],
  discountPercent: 10,
  threshold: type === "EARLY_BIRD" ? 90 : type === "EXTENDED_STAY" ? 7 : 5,
  freeNights: 0,
  weekdays: type === "MIDWEEK" ? [0, 1, 2, 3, 4] : [],
  tiers: [],
});

function weekdayLabels(locale: string) {
  return Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 0, 4 + day)),
    ),
  );
}

/** The rule part of a promotion's summary: window, lead time, minimum nights or days. */
export function promotionSummary(p: BookingPromotion, t: Translate, locale: string) {
  if (p.type === "LAST_MINUTE")
    return p.tiers.length
      ? p.tiers
          .map((tier) =>
            t("admin.minMaxDaysDiscount", {
              min: tier.daysBeforeMin,
              max: tier.daysBeforeMax ?? "∞",
              discount: tier.discountPercent,
            }),
          )
          .join("; ")
      : t("admin.checkInWithinDaysDays", { days: p.threshold });
  if (p.type === "EARLY_BIRD") return t("admin.bookDaysDaysAhead", { days: p.threshold });
  if (p.type === "EXTENDED_STAY") return t("admin.stayNightsNights", { nights: p.threshold });
  const labels = weekdayLabels(locale);
  return [...p.weekdays]
    .sort()
    .map((day) => labels[day])
    .join(", ");
}

/** The discount part of a promotion's summary. */
export function promotionDiscount(p: BookingPromotion, t: Translate) {
  if (p.freeNights) return t("admin.freeNightsCount", { count: p.freeNights });
  if (p.tiers.length) return t("admin.tieredPercentageOff");
  return `${p.discountPercent}${t("bookingFlow.promoCodes.percentageOff")}`;
}

type ErrorField = "threshold" | "discount" | "weekdays" | "tiers";

function validate(draft: BookingPromotion, free: boolean, t: Translate) {
  const whole = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  const percent = (value: number) => Number.isFinite(value) && value > 0 && value <= 100;
  if (draft.type === "EXTENDED_STAY" && !whole(draft.threshold, 2, 3650))
    return { field: "threshold" as const, message: t("admin.minimumNightsMustBeAWholeNumber") };
  if (draft.type === "MIDWEEK" && !draft.weekdays.length)
    return { field: "weekdays" as const, message: t("admin.pickAtLeastOneDay") };
  if (draft.tiers.length) {
    const bad = draft.tiers.some(
      (tier) =>
        !whole(tier.daysBeforeMin, 0, Number.MAX_SAFE_INTEGER) ||
        !percent(tier.discountPercent) ||
        (tier.daysBeforeMax !== null && !whole(tier.daysBeforeMax, tier.daysBeforeMin, 3650)),
    );
    return bad
      ? { field: "tiers" as const, message: t("admin.checkTheTierDaysAndDiscounts") }
      : null;
  }
  if (free && !whole(draft.freeNights, 1, Math.min(365, draft.threshold - 1)))
    return {
      field: "discount" as const,
      message: t("admin.freeNightsMustBeFewerThanMinimumNights"),
    };
  if (!free && !percent(draft.discountPercent))
    return { field: "discount" as const, message: t("admin.enterADiscountFrom001To100") };
  return null;
}

function Chip({
  id,
  type,
  name,
  checked,
  onChange,
  invalid,
  children,
}: {
  id: string;
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  onChange: () => void;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={`inline-flex h-9 cursor-pointer items-center rounded-lg border px-3.5 text-sm transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${checked ? "border-primary-600 bg-primary-50 font-medium text-primary-700 ring-1 ring-inset ring-primary-600" : `bg-white text-gray-800 hover:border-gray-300 ${invalid ? "border-red-400" : "border-gray-200"}`}`}
    >
      <input
        id={id}
        className="sr-only"
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
      />
      {children}
    </label>
  );
}

function Group({
  legend,
  helper,
  helperId,
  children,
}: {
  legend: string;
  helper: string;
  helperId: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0" aria-describedby={helperId}>
      <legend className="text-sm font-medium text-gray-800">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
      <p id={helperId} className="mt-2 text-xs text-gray-600">
        {helper}
      </p>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  helper,
  suffix,
  value,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  helper: string;
  suffix: string;
  value: number | "";
  invalid: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-gray-800">
        {label}
      </label>
      <div className="relative mt-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          aria-describedby={`${id}-helper`}
          aria-invalid={invalid || undefined}
          value={value}
          onChange={(event) =>
            onChange(event.target.value === "" ? NaN : Number(event.target.value))
          }
          className={`h-11 pr-16 !text-sm ${invalid ? "!border-red-400 focus:!ring-red-500" : ""}`}
        />
        <span className="pointer-events-none absolute right-3 top-3 text-sm text-gray-600">
          {suffix}
        </span>
      </div>
      <p id={`${id}-helper`} className="mt-2 text-xs text-gray-600">
        {helper}
      </p>
    </div>
  );
}

/** Create or edit one promotion in the shared promo window (VAY-2234). */
export default function PromotionForm({
  initial,
  editing,
  promotions,
  roomTypes,
  propertyCurrency,
  busy,
  save,
  onCancel,
}: {
  initial: BookingPromotion;
  editing: boolean;
  promotions: BookingPromotion[];
  roomTypes: PromoRoomType[];
  propertyCurrency: string;
  busy: boolean;
  save: (next: BookingPromotion[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t, locale } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [free, setFree] = useState(initial.freeNights > 0);
  const [error, setError] = useState<{ field: ErrorField | null; message: string } | null>(null);
  const patch = (value: Partial<BookingPromotion>) => setDraft((p) => ({ ...p, ...value }));
  const Icon = promotionIcons[draft.type];
  const days = weekdayLabels(locale);
  // A saved value outside the chips stays available as its own chip while editing.
  const choices = (options: number[]) =>
    options.includes(initial.threshold)
      ? options
      : [...options, initial.threshold].sort((a, b) => a - b);
  const invalid = (field: ErrorField) => error?.field === field;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = validate(draft, free, t);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const next = editing
      ? promotions.map((p) => (p.type === draft.type ? draft : p))
      : [...promotions, draft];
    if (!(await save(next))) setError({ field: null, message: t("admin.couldNotSavePromotions") });
  };

  const firstControl =
    initial.tiers.length > 0
      ? "promotion-tier-0-daysBeforeMin"
      : initial.type === "LAST_MINUTE" || initial.type === "EARLY_BIRD"
        ? `promotion-threshold-${initial.threshold}`
        : initial.type === "EXTENDED_STAY"
          ? "promotion-min-nights"
          : "promotion-day-0";
  // While a number field is empty the guest line would read "NaN% off"; hide it until it's filled.
  const previewable = ![draft.threshold, draft.discountPercent, draft.freeNights].some(
    Number.isNaN,
  );

  let rule: ReactNode = null;
  if (draft.tiers.length) {
    rule = (
      <fieldset className="min-w-0" aria-describedby="promotion-tiers-helper">
        <legend className="text-sm font-medium text-gray-800">
          {t("admin.existingLastMinuteTiers")}
        </legend>
        <div className="mt-2 space-y-2">
          {draft.tiers.map((tier, index) => (
            <div key={index} className="grid grid-cols-3 gap-2">
              {(["daysBeforeMin", "daysBeforeMax", "discountPercent"] as const).map((key) => (
                <label key={key} className="text-xs font-medium text-gray-600">
                  {key === "daysBeforeMin"
                    ? t("admin.fromDay")
                    : key === "daysBeforeMax"
                      ? t("admin.throughDay")
                      : t("admin.discount2")}
                  <Input
                    id={`promotion-tier-${index}-${key}`}
                    type="number"
                    aria-invalid={invalid("tiers") || undefined}
                    value={tier[key] ?? ""}
                    onChange={(event) =>
                      patch({
                        tiers: draft.tiers.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                [key]:
                                  event.target.value === "" && key === "daysBeforeMax"
                                    ? null
                                    : Number(event.target.value),
                              }
                            : item,
                        ),
                      })
                    }
                    className={`mt-1 h-11 !text-sm ${invalid("tiers") ? "!border-red-400" : ""}`}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
        <p id="promotion-tiers-helper" className="mt-2 text-xs text-gray-600">
          {t("admin.yourExistingWindowsAndDiscountsArePreservedEmptyEndDay")}
        </p>
      </fieldset>
    );
  } else if (draft.type === "LAST_MINUTE" || draft.type === "EARLY_BIRD") {
    const lastMinute = draft.type === "LAST_MINUTE";
    rule = (
      <Group
        legend={lastMinute ? t("admin.checkInWindow") : t("admin.bookAhead")}
        helper={lastMinute ? t("admin.checkInWindowHint") : t("admin.bookAheadHint")}
        helperId="promotion-threshold-helper"
      >
        {choices(lastMinute ? WINDOW_DAYS : AHEAD_DAYS).map((value) => (
          <Chip
            key={value}
            id={`promotion-threshold-${value}`}
            type="radio"
            name="promotion-threshold"
            checked={draft.threshold === value}
            onChange={() => patch({ threshold: value })}
          >
            {lastMinute
              ? value === 1
                ? t("admin.nextOneDay")
                : t("admin.nextDaysCount", { days: value })
              : t("admin.daysOrMore", { days: value })}
          </Chip>
        ))}
      </Group>
    );
  } else if (draft.type === "EXTENDED_STAY") {
    rule = (
      <>
        <NumberField
          id="promotion-min-nights"
          label={t("admin.minimumNights")}
          helper={t("admin.minimumNightsHint")}
          suffix={t("admin.nights")}
          value={Number.isNaN(draft.threshold) ? "" : draft.threshold}
          invalid={invalid("threshold")}
          onChange={(value) => patch({ threshold: value })}
        />
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-gray-800">{t("admin.discountType")}</legend>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {[false, true].map((option) => (
              <ChoiceCard
                key={String(option)}
                name="promotion-discount-format"
                value={option ? "free" : "percentage"}
                describedBy="promotion-discount-format-helper"
                checked={free === option}
                onChange={() => {
                  setFree(option);
                  patch(
                    option
                      ? { freeNights: 1, discountPercent: 0 }
                      : { freeNights: 0, discountPercent: 10 },
                  );
                }}
                label={option ? t("admin.freeNights") : t("admin.percentage")}
                unit={option ? t("admin.nights") : "%"}
              />
            ))}
          </div>
          <p id="promotion-discount-format-helper" className="mt-2 text-xs text-gray-600">
            {t("admin.freeNightsHint")}
          </p>
        </fieldset>
      </>
    );
  } else {
    rule = (
      <Group
        legend={t("admin.applicableDays")}
        helper={t("admin.applicableDaysHint")}
        helperId="promotion-days-helper"
      >
        {days.map((label, day) => (
          <Chip
            key={day}
            id={`promotion-day-${day}`}
            type="checkbox"
            name="promotion-days"
            invalid={invalid("weekdays")}
            checked={draft.weekdays.includes(day)}
            onChange={() =>
              patch({
                weekdays: draft.weekdays.includes(day)
                  ? draft.weekdays.filter((d) => d !== day)
                  : [...draft.weekdays, day].sort(),
              })
            }
          >
            {label}
          </Chip>
        ))}
      </Group>
    );
  }

  return (
    <EditorModal
      idPrefix="promotion-editor"
      title={t(editing ? titles[draft.type].edit : titles[draft.type].create)}
      description={t(promotionTypeCopy[draft.type].description)}
      icon={Icon}
      initialFocusId={firstControl}
      busy={busy}
      error={error?.message ?? null}
      noValidate
      active={draft.active}
      activeDescription={t("admin.turnOffToPauseWithoutDeleting")}
      onActiveChange={() => patch({ active: !draft.active })}
      closeLabel={t("admin.closePromotionEditor")}
      submitLabel={
        busy ? t("admin.saving") : editing ? t("admin.saveChanges") : t("admin.createPromotion")
      }
      onClose={() => {
        if (!busy) onCancel();
      }}
      onSubmit={(event) => void submit(event)}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="promotion-details-heading" className={sectionClass}>
          <EditorSectionHeading id="promotion-details-heading" icon={Icon}>
            {t("admin.promotionDetails")}
          </EditorSectionHeading>
          {rule}
          {!draft.tiers.length && (
            <NumberField
              id="promotion-discount"
              label={free ? t("admin.freeNights") : t("admin.discount")}
              helper={
                free
                  ? t("admin.freeNightsCountHint")
                  : t("admin.appliedToTheRoomRateInThePropertyCurrency", {
                      currency: propertyCurrency,
                    })
              }
              suffix={free ? t("admin.nights") : "%"}
              value={
                free
                  ? Number.isNaN(draft.freeNights)
                    ? ""
                    : draft.freeNights
                  : Number.isNaN(draft.discountPercent)
                    ? ""
                    : draft.discountPercent
              }
              invalid={invalid("discount")}
              onChange={(value) => patch(free ? { freeNights: value } : { discountPercent: value })}
            />
          )}
        </section>
        <section aria-labelledby="promotion-rules-heading" className={sectionClass}>
          <EditorSectionHeading id="promotion-rules-heading" icon={AdjustmentsHorizontalIcon}>
            {t("admin.rulesRestrictions")}
          </EditorSectionHeading>
          <Group
            legend={t("admin.applicableRooms")}
            helper={t("admin.leaveAsAllRoomsToApplyToAnyBookingOr")}
            helperId="promotion-rooms-helper"
          >
            <Chip
              id="promotion-room-all"
              type="checkbox"
              name="promotion-rooms"
              checked={!draft.roomTypeIds.length}
              onChange={() => patch({ roomTypeIds: [] })}
            >
              {t("admin.allRooms")}
            </Chip>
            {roomTypes.map((room) => (
              <Chip
                key={room.roomTypeId}
                id={`promotion-room-${room.roomTypeId}`}
                type="checkbox"
                name="promotion-rooms"
                checked={draft.roomTypeIds.includes(room.roomTypeId)}
                onChange={() =>
                  patch({
                    roomTypeIds: draft.roomTypeIds.includes(room.roomTypeId)
                      ? draft.roomTypeIds.filter((id) => id !== room.roomTypeId)
                      : [...draft.roomTypeIds, room.roomTypeId],
                  })
                }
              >
                {room.name}
              </Chip>
            ))}
          </Group>
        </section>
      </div>
      {previewable && (
        <p className="mt-4 rounded-xl border border-primary-100 bg-primary-50/50 px-4 py-3 text-[13px] text-gray-600">
          {t("admin.guestsWillSee")}{" "}
          <span className="font-semibold text-gray-900">{t(names[draft.type])}</span> —{" "}
          {promotionDiscount(draft, t)} · {promotionSummary(draft, t, locale)}
        </p>
      )}
    </EditorModal>
  );
}

const sectionClass =
  "min-w-0 space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5";
