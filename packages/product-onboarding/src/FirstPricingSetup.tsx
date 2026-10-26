"use client";
import { useState } from "react";
import {
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import {
  parseBookingPricingOfferTerms,
  paymentForChoice,
} from "@vayada/domain-booking/replacement-pricing";
import type { PricingTermsInput } from "./replacementPricingClient";
import type { Translate } from "./firstPricingSetupMessages";
import { IncludedPricing, includedPrice, type IncludedInput } from "./IncludedPricing";
import {
  AcceptedPaymentMethods,
  paidInAdvance,
  type ManualPaymentMethod,
  type PaymentMethod,
} from "./AcceptedPaymentMethods";
import { defaultPricingFormLook, type PricingFormLook } from "./pricingFormLook";
import { parseMinorInput, PricingError, setupErrorText } from "./pricingSetupAmounts";

export { defaultPricingFormLook, type PricingFormLook } from "./pricingFormLook";

export type SetupRoom = {
  roomTypeId: string;
  name: string;
  capacity: PricingConfiguration["capacity"];
};
type Values = Record<
  | "mode"
  | "room"
  | "currency"
  | "base"
  | "adultAge"
  | "childPrice"
  | "countChildren"
  | "minimum"
  | "maximum"
  | "cancellation"
  | "freeDays"
  | "payment",
  string
> & { occupancy: string[]; included: IncludedInput; methods: PaymentMethod[] };
export function firstPricingInput(
  propertyId: string,
  room: SetupRoom,
  offerId: string,
  values: Values,
  existingRoom?: PricingConfiguration,
) {
  if (
    existingRoom &&
    (existingRoom.propertyId !== propertyId ||
      existingRoom.roomTypeId !== room.roomTypeId ||
      existingRoom.currency !== values.currency)
  )
    throw new PricingError("pricing.setup.errorExistingRoom");
  const scale = pricingCurrencyScale(values.currency);
  const integer = (value: string) =>
    /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  if (
    scale === null ||
    (!existingRoom && !["yes", "no"].includes(values.countChildren)) ||
    // "full": the ticked ways to pay; "nothing" / "full_stay": the rate's "Paid when booking" (VAY-2205).
    !["full", "nothing", "full_stay"].includes(values.payment) ||
    (values.payment === "nothing" && values.cancellation === "non_refundable") ||
    !["non_refundable", "flexible"].includes(values.cancellation)
  )
    throw new PricingError("pricing.setup.errorIncomplete");
  if (
    !values.methods.length ||
    (values.payment === "nothing" && !values.methods.includes("pay_at_property"))
  )
    throw new PricingError("pricing.error.paymentMethodRequired");
  // A non-refundable stay is paid in advance: pay at property is never sent with it (VAY-2280).
  const payment =
    values.payment === "full"
      ? {
          kind: "full" as const,
          acceptedMethods:
            values.cancellation === "non_refundable"
              ? paidInAdvance(values.methods)
              : values.methods,
        }
      : paymentForChoice(values.payment as "nothing" | "full_stay", { methods: values.methods });
  if (!payment?.acceptedMethods?.length)
    throw new PricingError(
      values.cancellation === "non_refundable"
        ? "pricing.error.nonRefundableNeedsAdvance"
        : "pricing.error.paymentMethodRequired",
    );
  if (!["flat", "occupancy", "per_person", "included_guests"].includes(values.mode))
    throw new PricingError("pricing.setup.errorMode");
  if (values.mode === "occupancy" && values.occupancy.length !== room.capacity.adults)
    throw new PricingError("pricing.setup.errorOccupancy");
  // Whole rupiah for IDR (VAY-2085); every other currency steps by one minor unit.
  const step = pricingAmountStep(values.currency);
  const base =
    values.mode === "included_guests"
      ? includedPrice(values.included, values.base, room.capacity.adults, scale, step)
      : values.mode === "occupancy"
        ? {
            mode: "occupancy",
            amountsMinor: Array.from(values.occupancy, (amount) =>
              parseMinorInput(amount, scale, false, step),
            ),
          }
        : values.mode === "per_person"
          ? { mode: "per_person", unitMinor: parseMinorInput(values.base, scale, false, step) }
          : { mode: "flat", amountMinor: parseMinorInput(values.base, scale, false, step) };
  const adultFromAge = integer(values.adultAge),
    minArrivalNights = integer(values.minimum);
  const cancellation: PricingTermsInput["cancellation"] =
    values.cancellation === "non_refundable"
      ? { kind: "non_refundable" }
      : {
          kind: "flexible",
          terms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: integer(values.freeDays),
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        };
  const terms: PricingTermsInput = {
    roomTypeId: room.roomTypeId,
    offerId,
    expectedRevision: null,
    cancellation,
    payment,
  };
  const configuration = parsePricingConfiguration({
    version: "pricing.v2",
    propertyId,
    roomTypeId: room.roomTypeId,
    revision: existingRoom?.revision ?? 1,
    currency: values.currency,
    capacity: room.capacity,
    children: existingRoom?.children ?? {
      adultFromAge,
      bands: [
        {
          fromAge: 0,
          throughAge: adultFromAge - 1,
          nightlyMinor: parseMinorInput(values.childPrice, scale, true, step),
          countsTowardCapacity: values.countChildren === "yes",
        },
      ],
    },
    offers: [
      ...(existingRoom?.offers ?? []),
      {
        id: offerId,
        termsRevision: offerId,
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: { base, months: [], seasons: [], weekdays: [], dates: [] },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights,
            maxStayNights: values.maximum === "" ? null : integer(values.maximum),
            closedToArrival: false,
            closedToDeparture: false,
            stopSell: false,
          },
          seasons: [],
          dates: [],
        },
      },
    ],
  });
  if (
    !parseBookingPricingOfferTerms({
      roomTypeId: terms.roomTypeId,
      offerId,
      revision: offerId,
      cancellation,
      payment: terms.payment,
    })
  )
    throw new PricingError("pricing.error.cancellationDeadline");
  if (!configuration) throw new PricingError("pricing.setup.errorConfiguration");
  return { configuration, terms };
}
export type FirstPricingSetupProps = {
  propertyId: string;
  rooms: readonly SetupRoom[];
  disabled: boolean;
  onDirty: () => void;
  onCreate: (input: ReturnType<typeof firstPricingInput>) => void;
  fixedCurrency?: string;
  existingRoom?: PricingConfiguration;
  t: Translate;
  /** Class names; onboarding's look by default. */
  look?: PricingFormLook;
  /** Bank transfer and PayPal the hotel can use now (VAY-2139). */
  manualMethods?: readonly ManualPaymentMethod[];
};
export function FirstPricingSetup({
  propertyId,
  rooms,
  disabled,
  onDirty,
  onCreate,
  fixedCurrency,
  existingRoom,
  t,
  look = defaultPricingFormLook,
  manualMethods,
}: FirstPricingSetupProps) {
  const [values, setValues] = useState<Values>({
    mode: "",
    occupancy: [],
    included: { adults: "", adjustments: [] },
    methods: [],
    room: existingRoom?.roomTypeId ?? "",
    currency: fixedCurrency ?? "",
    base: "",
    adultAge: "",
    childPrice: "",
    countChildren: "",
    minimum: "",
    maximum: "",
    cancellation: "",
    freeDays: "",
    payment: "",
  });
  const [error, setError] = useState("");
  const change = (
    key: Exclude<keyof Values, "occupancy" | "included" | "methods">,
    value: string,
  ) => {
    setValues({
      ...values,
      [key]: value,
      ...(["room", "mode"].includes(key)
        ? { base: "", occupancy: [], included: { adults: "", adjustments: [] } }
        : {}),
    });
    setError("");
    onDirty();
  };
  const field = (
    key: Exclude<keyof Values, "occupancy" | "included" | "methods">,
    label: string,
  ) => (
    <label className={look.label}>
      {label}
      <input
        aria-label={label}
        disabled={disabled || (key === "currency" && !!fixedCurrency)}
        value={values[key]}
        className={look.input}
        onChange={(event) => change(key, event.target.value)}
      />
    </label>
  );
  const select = (
    key: Exclude<keyof Values, "occupancy" | "included" | "methods">,
    label: string,
    options: [string, string][],
  ) => (
    <label className={look.label}>
      {label}
      <select
        aria-label={label}
        disabled={disabled}
        value={values[key]}
        className={look.input}
        onChange={(event) => change(key, event.target.value)}
      >
        <option value="">{t("pricing.choose")}</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  if (!rooms.length) return <p>{t("pricing.setup.noRooms")}</p>;
  const room = rooms.find((candidate) => candidate.roomTypeId === values.room);
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        try {
          if (!room) throw new PricingError("pricing.setup.errorRoom");
          onCreate(
            firstPricingInput(
              propertyId,
              room,
              crypto.randomUUID(),
              { ...values, currency: fixedCurrency ?? values.currency },
              existingRoom,
            ),
          );
        } catch (cause) {
          setError(setupErrorText(cause, t, "pricing.setup.errorCheck"));
        }
      }}
    >
      <h2 className={look.heading}>
        {t(
          existingRoom
            ? "pricing.setup.titleOffer"
            : fixedCurrency
              ? "pricing.setup.titleAnotherRoom"
              : "pricing.setup.titleFirst",
        )}
      </h2>
      <p className={look.hint}>{t("pricing.setup.intro")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {existingRoom ? (
          <p className={look.text}>{t("pricing.setup.room", { name: room?.name ?? "" })}</p>
        ) : (
          select(
            "room",
            t("pricing.setup.roomType"),
            rooms.map((r) => [r.roomTypeId, r.name]),
          )
        )}
        {field("currency", t("pricing.setup.currency"))}
        {select("mode", t("pricing.setup.mode"), [
          ["flat", t("pricing.setup.modeFlat")],
          ["occupancy", t("pricing.setup.modeOccupancy")],
          ["per_person", t("pricing.setup.modePerPerson")],
          ["included_guests", t("pricing.setup.modeIncluded")],
        ])}
        {(values.mode === "flat" || values.mode === "included_guests") &&
          field("base", t("pricing.setup.roomPrice"))}
        {values.mode === "per_person" && field("base", t("pricing.setup.adultPrice"))}
        {values.mode === "occupancy" &&
          room &&
          Array.from({ length: room.capacity.adults }, (_, index) => (
            <label key={index} className={look.label}>
              {t(
                index ? "pricing.setup.occupancyPrice.other" : "pricing.setup.occupancyPrice.one",
                { count: index + 1 },
              )}
              <input
                aria-label={t(
                  index ? "pricing.setup.occupancyPrice.other" : "pricing.setup.occupancyPrice.one",
                  { count: index + 1 },
                )}
                inputMode="decimal"
                disabled={disabled}
                value={values.occupancy[index] ?? ""}
                className={look.input}
                onChange={(event) => {
                  const occupancy = Array.from({ length: room.capacity.adults }, (_, i) =>
                    i === index ? event.target.value : (values.occupancy[i] ?? ""),
                  );
                  setValues({ ...values, occupancy });
                  setError("");
                  onDirty();
                }}
              />
            </label>
          ))}
        {values.mode === "included_guests" && room && (
          <IncludedPricing
            t={t}
            look={look}
            value={values.included}
            capacity={room.capacity.adults}
            disabled={disabled}
            onChange={(included) => {
              setValues({ ...values, included });
              setError("");
              onDirty();
            }}
          />
        )}
        {!existingRoom && (
          <>
            {field("adultAge", t("pricing.setup.adultAge"))}
            {field("childPrice", t("pricing.setup.childPrice"))}
            {select("countChildren", t("pricing.setup.countChildren"), [
              ["yes", t("pricing.setup.yes")],
              ["no", t("pricing.setup.no")],
            ])}
          </>
        )}
        {field("minimum", t("pricing.setup.minimum"))}
        {field("maximum", t("pricing.setup.maximum"))}
        {select("cancellation", t("pricing.cancellationPolicy"), [
          ["non_refundable", t("pricing.nonRefundable")],
          ["flexible", t("pricing.freeCancellationUntilDeadline")],
        ])}
        {values.cancellation === "flexible" && field("freeDays", t("pricing.freeCancellationDays"))}
        {select("payment", t("pricing.paymentPolicy"), [["full", t("pricing.fullPayment")]])}
      </div>
      <AcceptedPaymentMethods
        t={t}
        look={look}
        methods={values.methods}
        disabled={disabled}
        manualMethods={manualMethods}
        nonRefundable={values.cancellation === "non_refundable"}
        onChange={(methods) => {
          setValues({ ...values, methods });
          setError("");
          onDirty();
        }}
      />
      <p className={look.hint}>{t("pricing.setup.ageHint")}</p>
      {room && (
        <p className={look.text}>
          {t("pricing.setup.capacity", {
            total: room.capacity.total,
            adults: room.capacity.adults,
            children: room.capacity.children,
          })}{" "}
          {t(existingRoom ? "pricing.setup.existingBands" : "pricing.setup.childBand")}
        </p>
      )}
      {values.cancellation === "flexible" && (
        <p className={look.text}>{t("pricing.setup.penalty")}</p>
      )}
      <p className={look.hint}>{t("pricing.setup.continueHint")}</p>
      {error && (
        <p role="alert" className={look.error}>
          {error}
        </p>
      )}
      <button disabled={disabled} className={look.button}>
        {t("pricing.setup.continue")}
      </button>
    </form>
  );
}
