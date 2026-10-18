"use client";

import { useEffect, useId, useState, type MutableRefObject } from "react";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { paidInAdvance } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { AcceptedPaymentMethods, type PaymentMethod } from "./AcceptedPaymentMethods";
import { CancellationChoice } from "./StepCancellation";
import { extraField, SwitchRow } from "./StepExtras";
import { firstPricingInput, type SetupRoom } from "./FirstPricingSetup";
import { IncludedPricing } from "./IncludedPricing";
import { MoreOptions } from "./MoreOptions";
import { errorText } from "./pricingAmounts";
import { MoreGroup, paymentText } from "./SimpleMoreOptions";
import {
  defaultDiscount,
  defaultFreeDays,
  switchOption,
  type SimpleCancellation,
} from "./simplePricing";
import { currencySymbol, setWeekend, weekendChoices } from "./stepPricing";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Values = Parameters<typeof firstPricingInput>[3];
type Field = "minimum" | "maximum" | "adultAge" | "childPrice";
const modes = ["flat", "occupancy", "per_person", "included_guests"] as const;
/** A required answer: its key, whether it is empty, and its field's name. */
type Answer = [key: string, empty: boolean, name: string];
/** A discount the non-refundable switch takes: more than 0 and less than 100 percent, up to two decimals. */
const validPercent = (value: string) =>
  /^\d+(?:\.\d{1,2})?$/.test(value.trim()) && Number(value) > 0 && Number(value) < 100;
/** A first price: the room with its options, and each option's terms. */
export type FirstPrices = { configuration: PricingConfiguration; terms: PricingTermsInput[] };
/** After the first prices are built: save them, add them unsaved, or add them and open the season window. */
export type FirstThen = "save" | "add" | "season";

/** "Set prices" for a room without prices, as the simple Prices card (VAY-2188): a price per night is the only answer
 * needed. Free cancellation until 3 days before arrival, the ways to pay from Payment settings, children under 12 free
 * and no minimum stay are filled in; the switches, busier dates and More options change them. "Save prices" saves at
 * once; "Add a season" adds the prices unsaved and opens the season window. On the New room page the page's create
 * saves them (`pending`), and Enter only adds them, unsaved. */
export function StepFirstPrices({
  propertyId,
  rooms,
  fixedCurrency,
  disabled,
  defaultMethods,
  onDirty,
  onCreate,
  pending,
}: {
  propertyId: string;
  /** The room page's room (the first; the page offers only its own room). */
  rooms: readonly SetupRoom[];
  fixedCurrency?: string;
  disabled: boolean;
  /** Payment settings' ways to pay, ticked from the start; null when they can't be read (the form asks), undefined
   * while they load. */
  defaultMethods: readonly PaymentMethod[] | null | undefined;
  onDirty: () => void;
  onCreate: (input: FirstPrices, then: FirstThen) => void;
  /** Filled with a builder for the answers as they stand, for the New room page, which saves them with the room. It
   * shows and throws what is missing. */
  pending?: MutableRefObject<(() => FirstPrices) | null>;
}) {
  const { t } = useTranslation();
  const room = rooms[0]!;
  const [values, setValues] = useState<Values>({
    mode: "flat",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: [],
    room: room.roomTypeId,
    currency: fixedCurrency ?? "",
    base: "",
    adultAge: "12",
    childPrice: "0",
    countChildren: "yes",
    minimum: "1",
    maximum: "",
    cancellation: "flexible",
    freeDays: String(defaultFreeDays),
    payment: "full",
  });
  const [cancel, setCancel] = useState<Exclude<SimpleCancellation, { kind: "own" }>>({
    kind: "free",
    days: defaultFreeDays,
  });
  const [nonRefundable, setNonRefundable] = useState({ on: false, percent: defaultDiscount });
  const [breakfast, setBreakfast] = useState({ on: false, amount: "" });
  const [weekend, setWeekendChoice] = useState<number | null>(null);
  const [methodsTouched, setMethodsTouched] = useState(false);
  const [error, setError] = useState("");
  // After a save that failed, the answers still empty are marked and named, and update as they are filled in.
  const [checked, setChecked] = useState(false);
  const loadingMethods = defaultMethods === undefined && !values.methods.length;
  // Guests can only pay at the property: non-refundable stays (paid in advance) can't be offered (VAY-2280).
  const onlyAtProperty = values.methods.length > 0 && !paidInAdvance(values.methods).length;
  // Payment settings' ways to pay are ticked once they arrive, unless the hotel already chose.
  useEffect(() => {
    if (defaultMethods && !methodsTouched)
      setValues((previous) =>
        previous.methods.length ? previous : { ...previous, methods: [...defaultMethods] },
      );
  }, [defaultMethods, methodsTouched]);
  const touch = () => {
    setError("");
    onDirty();
  };
  const change = (next: Partial<Values>) => {
    // Merge into the latest answers: Payment settings' ways to pay can land between this render and the keystroke.
    setValues((previous) => ({ ...previous, ...next }));
    touch();
  };
  const currency = fixedCurrency ?? values.currency.trim().toUpperCase();
  const symbol = currency ? currencySymbol(currency) : null;
  const blank = (value: string | undefined) => !value?.trim();
  const children = room.capacity.children > 0;
  const answers: Answer[] = [
    ...(values.mode === "occupancy"
      ? Array.from(
          { length: room.capacity.adults },
          (_, index): Answer => [
            `occupancy:${index}`,
            blank(values.occupancy[index]),
            t(index ? "pricing.setup.occupancyPrice.other" : "pricing.setup.occupancyPrice.one", {
              count: index + 1,
            }),
          ],
        )
      : [
          [
            "base",
            blank(values.base),
            t(
              values.mode === "per_person" ? "pricing.setup.adultPrice" : "pricing.setup.roomPrice",
            ),
          ] as Answer,
        ]),
    ...(values.mode === "included_guests"
      ? [["included", blank(values.included.adults), t("pricing.included.adults")] as Answer]
      : []),
    ["currency", !fixedCurrency && blank(values.currency), t("pricing.setup.currency")],
    ["methods", !values.methods.length, t("pricing.simple.more.payment")],
    [
      "discount",
      nonRefundable.on && !validPercent(nonRefundable.percent),
      t("pricing.simple.extras.discountLabel"),
    ],
    ["minimum", blank(values.minimum), t("pricing.simple.first.minimum")],
    ["adultAge", blank(values.adultAge), t("pricing.simple.first.adultAge")],
    ["childPrice", blank(values.childPrice), t("pricing.simple.first.childPrice")],
    [
      "breakfast",
      breakfast.on && blank(breakfast.amount),
      t("pricing.simple.extras.breakfastLabel"),
    ],
  ];
  const missing = new Map(
    checked
      ? answers.filter(([, empty]) => empty).map(([key, , name]) => [key, name] as const)
      : [],
  );
  const formId = useId();
  const errorIds = (key: string) => (missing.has(key) ? `${formId}-missing-${key}` : undefined);
  const mark = (key: string) => (missing.has(key) ? " ring-2 ring-red-400" : "");
  const field = (key: Field, label: string, hint?: string) => (
    <label className={ui.fieldLabel}>
      {label}
      <input
        aria-label={label}
        aria-invalid={missing.has(key) || undefined}
        aria-describedby={errorIds(key)}
        inputMode={key === "childPrice" ? "decimal" : "numeric"}
        disabled={disabled}
        value={values[key]}
        onChange={(event) => change({ [key]: event.target.value })}
        className={`mt-1.5 block w-36 ${ui.field}${mark(key)}`}
      />
      {hint && <span className={`mt-1 block font-normal ${ui.help}`}>{hint}</span>}
    </label>
  );
  /** The room, its first option and the switches' options, with their terms; throws what stops it. */
  const build = (): FirstPrices => {
    const offerId = crypto.randomUUID();
    const first = firstPricingInput(propertyId, room, offerId, {
      ...values,
      currency,
      cancellation: cancel.kind === "free" ? "flexible" : "non_refundable",
      freeDays: String(cancel.kind === "free" ? cancel.days : defaultFreeDays),
    });
    let configuration = first.configuration;
    const terms = [first.terms];
    const mainTerms = { cancellation: first.terms.cancellation, payment: first.terms.payment };
    if (weekend !== null) configuration = setWeekend(configuration, offerId, weekend);
    const extras = [
      ...(nonRefundable.on && cancel.kind === "free"
        ? [{ kind: "non_refundable" as const, value: { percent: nonRefundable.percent } }]
        : []),
      ...(breakfast.on
        ? [
            {
              kind: "breakfast" as const,
              value: { amount: breakfast.amount, basis: "person" as const },
            },
          ]
        : []),
    ];
    for (const extra of extras) {
      const added = switchOption(
        configuration,
        crypto.randomUUID(),
        extra.kind,
        extra.value,
        mainTerms,
      );
      configuration = added.configuration;
      terms.push(added.terms);
    }
    return { configuration, terms };
  };
  const show = (cause: unknown) => setError(errorText(cause, t, "pricing.setup.errorCheck"));
  function submit(then: FirstThen) {
    // Payment settings' ways to pay are still loading: a Save now would call them missing.
    if (disabled || loadingMethods) return;
    setChecked(true);
    if (answers.some(([, empty]) => empty)) return;
    try {
      onCreate(build(), then);
    } catch (cause) {
      show(cause);
    }
  }
  useEffect(() => {
    if (!pending) return;
    pending.current = () => {
      try {
        if (answers.some(([, empty]) => empty)) throw new Error(t("pricing.steps.first.missing"));
        return build();
      } catch (cause) {
        setChecked(true);
        show(cause);
        throw cause;
      }
    };
    return () => {
      pending.current = null;
    };
  });
  // When Payment settings can't be read, How guests pay is asked at once (More options opens and stays open).
  const moreMissing =
    (defaultMethods === null && !values.methods.length) ||
    ["methods", "minimum", "adultAge", "childPrice", "included"].some((key) => missing.has(key));
  const summary = [
    values.methods.length
      ? t("pricing.simple.summary.payment", { methods: paymentText(values.methods, t) })
      : t("pricing.simple.summary.choosePayment"),
    Number(values.minimum) > 1
      ? t("pricing.simple.summary.minimum", { count: Number(values.minimum) })
      : t("pricing.simple.summary.noMinimum"),
    ...(children
      ? [
          values.childPrice.trim() === "0"
            ? t("pricing.simple.summary.childrenFree", { age: values.adultAge })
            : t("pricing.simple.summary.childrenPrice", {
                age: values.adultAge,
                amount: `${symbol ?? `${currency} `}${values.childPrice}`,
              }),
        ]
      : []),
  ].join(" · ");
  const amountInput = (
    label: string,
    value: string,
    key: "base" | `occupancy:${number}`,
    onChange: (value: string) => void,
  ) => (
    <span
      className={`flex h-12 w-[200px] items-center gap-2 rounded-[10px] bg-gray-100 px-4 focus-within:ring-2 focus-within:ring-primary-500${mark(key)}`}
    >
      {symbol && (
        <span aria-hidden="true" className="text-[16px] text-gray-500">
          {symbol}
        </span>
      )}
      <input
        aria-label={label}
        aria-invalid={missing.has(key) || undefined}
        aria-describedby={errorIds(key)}
        inputMode="decimal"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 grow bg-transparent text-[18px] font-semibold text-gray-900 outline-none disabled:cursor-not-allowed"
      />
    </span>
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(pending ? "add" : "save");
      }}
    >
      <p
        role="status"
        className={
          pending
            ? "rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-[14px] leading-5 text-gray-700"
            : ui.warningBanner
        }
      >
        {pending
          ? t("pricing.simple.first.newRoom")
          : t("pricing.simple.first.noPrice", { room: room.name })}
      </p>
      <div className={ui.pricesCard}>
        <StepCard title={t("pricing.steps.price.title")}>
          <div className="flex flex-wrap items-end gap-3">
            {values.mode === "occupancy" ? (
              Array.from({ length: room.capacity.adults }, (_, index) => {
                const label = t(
                  index ? "pricing.setup.occupancyPrice.other" : "pricing.setup.occupancyPrice.one",
                  { count: index + 1 },
                );
                return (
                  <label key={index} className="block">
                    <span className="mb-1.5 block text-[13px] font-medium text-gray-700">
                      {t(index ? "pricing.adults.other" : "pricing.adults.one", {
                        count: index + 1,
                      })}
                    </span>
                    {amountInput(
                      label,
                      values.occupancy[index] ?? "",
                      `occupancy:${index}`,
                      (value) =>
                        change({
                          occupancy: Array.from({ length: room.capacity.adults }, (_, i) =>
                            i === index ? value : (values.occupancy[i] ?? ""),
                          ),
                        }),
                    )}
                  </label>
                );
              })
            ) : (
              <label className="block">
                {amountInput(
                  t(
                    values.mode === "per_person"
                      ? "pricing.setup.adultPrice"
                      : "pricing.setup.roomPrice",
                  ),
                  values.base,
                  "base",
                  (value) => change({ base: value }),
                )}
              </label>
            )}
            <span className="flex h-12 items-center text-[15px] text-gray-700">
              {t(
                values.mode === "per_person"
                  ? "pricing.steps.price.perAdultNight"
                  : values.mode === "flat"
                    ? "pricing.simple.perRoomNight"
                    : "pricing.steps.price.perNight",
              )}
            </span>
            {fixedCurrency ? (
              !symbol && (
                <span className="flex h-12 items-center rounded-[10px] border border-gray-200 px-3.5 text-[14px] text-gray-700">
                  {fixedCurrency}
                </span>
              )
            ) : (
              <label className={ui.fieldLabel}>
                {t("pricing.setup.currency")}
                <input
                  aria-label={t("pricing.setup.currency")}
                  aria-invalid={missing.has("currency") || undefined}
                  disabled={disabled}
                  value={values.currency}
                  onChange={(event) => change({ currency: event.target.value })}
                  className={`mt-1.5 block w-28 ${ui.field}${mark("currency")}`}
                />
              </label>
            )}
          </div>
        </StepCard>
        <StepCard title={t("pricing.simple.cancellation.title")}>
          <CancellationChoice
            value={cancel}
            disabled={disabled}
            noNonRefundable={onlyAtProperty}
            onChange={(choice) => {
              setCancel(choice);
              touch();
            }}
          />
        </StepCard>
        <StepCard
          title={t("pricing.simple.extras.title")}
          hint={t("pricing.simple.extras.hint")}
          optional
        >
          <div>
            {cancel.kind === "free" && (
              <SwitchRow
                on={nonRefundable.on}
                name={t("pricing.simple.extras.nonRefundable")}
                disabled={disabled || (onlyAtProperty && !nonRefundable.on)}
                onToggle={() => {
                  setNonRefundable({ ...nonRefundable, on: !nonRefundable.on });
                  touch();
                }}
                field={
                  <>
                    <input
                      aria-label={t("pricing.simple.extras.discountLabel")}
                      aria-invalid={missing.has("discount") || undefined}
                      aria-describedby={errorIds("discount")}
                      inputMode="decimal"
                      disabled={disabled}
                      value={nonRefundable.percent}
                      onChange={(event) => {
                        setNonRefundable({ ...nonRefundable, percent: event.target.value });
                        touch();
                      }}
                      className={`w-16 ${extraField}${mark("discount")}`}
                    />
                    {t("pricing.simple.extras.cheaper")}
                  </>
                }
              />
            )}
            <SwitchRow
              on={breakfast.on}
              name={t("pricing.simple.extras.breakfast")}
              disabled={disabled}
              onToggle={() => {
                setBreakfast({ ...breakfast, on: !breakfast.on });
                touch();
              }}
              field={
                <>
                  +
                  <input
                    aria-label={t("pricing.simple.extras.breakfastLabel")}
                    aria-invalid={missing.has("breakfast") || undefined}
                    aria-describedby={errorIds("breakfast")}
                    inputMode="decimal"
                    disabled={disabled}
                    value={breakfast.amount}
                    onChange={(event) => {
                      setBreakfast({ ...breakfast, amount: event.target.value });
                      touch();
                    }}
                    className={`w-24 ${extraField}${mark("breakfast")}`}
                  />
                  {t("pricing.simple.extras.perAdult")}
                </>
              }
            />
          </div>
        </StepCard>
        <StepCard
          title={t("pricing.steps.seasons.title")}
          hint={t("pricing.steps.seasons.hint")}
          optional
        >
          <button
            type="button"
            disabled={disabled || loadingMethods}
            onClick={() => submit("season")}
            className={`inline-flex items-center gap-1.5 ${ui.stepLink}`}
          >
            <PlusIcon aria-hidden="true" className="h-4 w-4" /> {t("pricing.steps.seasons.add")}
          </button>
          <div
            role="group"
            aria-label={t("pricing.steps.weekends.title")}
            className="flex flex-wrap items-center gap-2 pt-2"
          >
            <span aria-hidden="true" className="mr-2 text-[15px] text-gray-700">
              {t("pricing.steps.weekends.title")}
            </span>
            {([null, ...weekendChoices] as const).map((basisPoints) => (
              <button
                key={String(basisPoints)}
                type="button"
                aria-pressed={weekend === basisPoints}
                disabled={disabled}
                className={ui.chip(weekend === basisPoints)}
                onClick={() => {
                  setWeekendChoice(basisPoints);
                  touch();
                }}
              >
                {basisPoints === null
                  ? t("pricing.steps.weekends.no")
                  : t("pricing.steps.weekends.percent", { percent: basisPoints / 100 })}
              </button>
            ))}
          </div>
        </StepCard>
      </div>
      <MoreOptions keepOpen={moreMissing} summary={summary}>
        <MoreGroup
          title={t("pricing.simple.more.payment")}
          hint={
            defaultMethods === null && !values.methods.length
              ? t("pricing.simple.first.methodsUnknown")
              : undefined
          }
        >
          <div
            role="group"
            aria-label={t("pricing.simple.more.payment")}
            aria-describedby={errorIds("methods")}
            className={
              missing.has("methods") ? "w-fit rounded-xl ring-2 ring-red-400 ring-offset-4" : ""
            }
          >
            <AcceptedPaymentMethods
              methods={values.methods}
              disabled={disabled}
              nonRefundable={cancel.kind === "non_refundable"}
              onChange={(methods) => {
                setMethodsTouched(true);
                change({ methods });
              }}
            />
          </div>
        </MoreGroup>
        <MoreGroup title={t("pricing.simple.more.stay")}>
          <div className="flex flex-wrap items-start gap-4">
            {field("minimum", t("pricing.simple.first.minimum"))}
            {field("maximum", t("pricing.simple.first.maximum"))}
          </div>
        </MoreGroup>
        {children && (
          <MoreGroup title={t("pricing.steps.rules.children")}>
            <div className="flex flex-wrap items-start gap-4">
              {field("adultAge", t("pricing.simple.first.adultAge"))}
              {field(
                "childPrice",
                t("pricing.simple.first.childPrice"),
                t("pricing.simple.first.childPriceHint"),
              )}
            </div>
            <label className="flex items-center gap-2 text-[14px] text-gray-700">
              <input
                type="checkbox"
                disabled={disabled}
                checked={values.countChildren === "yes"}
                onChange={(event) => change({ countChildren: event.target.checked ? "yes" : "no" })}
              />
              {t("pricing.simple.first.countChildren", { count: room.capacity.total })}
            </label>
          </MoreGroup>
        )}
        {room.capacity.adults > 1 && (
          <MoreGroup title={t("pricing.simple.more.guests")}>
            <label className={ui.fieldLabel}>
              {t("pricing.setup.mode")}
              <select
                aria-label={t("pricing.setup.mode")}
                disabled={disabled}
                value={values.mode}
                onChange={(event) =>
                  change({
                    mode: event.target.value,
                    base: "",
                    occupancy: [],
                    included: { adults: "", adjustments: [] },
                  })
                }
                className={`mt-1.5 block ${ui.field}`}
              >
                {modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(
                      `pricing.setup.mode${mode === "flat" ? "Flat" : mode === "occupancy" ? "Occupancy" : mode === "per_person" ? "PerPerson" : "Included"}`,
                    )}
                  </option>
                ))}
              </select>
            </label>
            {values.mode === "included_guests" && (
              <div
                className={
                  missing.has("included") ? "rounded-xl ring-2 ring-red-400 ring-offset-4" : ""
                }
              >
                <IncludedPricing
                  value={values.included}
                  capacity={room.capacity.adults}
                  disabled={disabled}
                  onChange={(included) => change({ included })}
                />
              </div>
            )}
          </MoreGroup>
        )}
      </MoreOptions>
      {(error || missing.size > 0) && (
        <div role="alert" className={ui.errorText}>
          {error && <p>{error}</p>}
          {missing.size > 0 && (
            <>
              <p className={error ? "mt-1" : ""}>{t("pricing.steps.first.missing")}</p>
              <ul className="mt-1 list-disc pl-5">
                {Array.from(missing, ([key, name]) => (
                  <li key={key} id={`${formId}-missing-${key}`}>
                    {name}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {/* The New room page saves with the room; here Save is the declaration. */}
      {!pending && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className={`mr-auto ${ui.help}`}>{t("pricing.editor.saveDeclaration")}</p>
          <button type="submit" disabled={disabled || loadingMethods} className={ui.primaryButton}>
            {t("pricing.editor.save")}
          </button>
        </div>
      )}
    </form>
  );
}
