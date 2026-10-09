"use client";
import { useState } from "react";
import {
  parsePricingConfiguration,
  pricingAmountStep,
  pricingCurrencyScale,
  type PricingConfiguration,
} from "@vayada/domain-pms/replacement-pricing";
import { parseBookingPricingOfferTerms } from "@vayada/domain-booking/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { PricingTermsInput } from "@/services/api/replacementPricingClient";
import { IncludedPricing, includedPrice, type IncludedInput } from "./IncludedPricing";
import { AcceptedPaymentMethods, type PaymentMethod } from "./AcceptedPaymentMethods";
import { errorText, parseMinorInput, PricingError } from "./pricingAmounts";

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
  const scale = pricingCurrencyScale(values.currency),
    step = pricingAmountStep(values.currency);
  const integer = (value: string) =>
    /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
  if (
    scale === null ||
    (!existingRoom && !["yes", "no"].includes(values.countChildren)) ||
    values.payment !== "full" ||
    !["non_refundable", "flexible"].includes(values.cancellation)
  )
    throw new PricingError("pricing.setup.errorIncomplete");
  if (!values.methods.length) throw new PricingError("pricing.error.paymentMethodRequired");
  if (!["flat", "occupancy", "per_person", "included_guests"].includes(values.mode))
    throw new PricingError("pricing.setup.errorMode");
  if (values.mode === "occupancy" && values.occupancy.length !== room.capacity.adults)
    throw new PricingError("pricing.setup.errorOccupancy");
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
    payment: { kind: "full", acceptedMethods: values.methods },
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
export function FirstPricingSetup({
  propertyId,
  rooms,
  disabled,
  onDirty,
  onCreate,
  fixedCurrency,
  existingRoom,
}: {
  propertyId: string;
  rooms: readonly SetupRoom[];
  disabled: boolean;
  onDirty: () => void;
  onCreate: (input: ReturnType<typeof firstPricingInput>) => void;
  fixedCurrency?: string;
  existingRoom?: PricingConfiguration;
}) {
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
  const { t } = useTranslation();
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
    <label className="block text-sm">
      {label}
      <input
        aria-label={label}
        disabled={disabled || (key === "currency" && !!fixedCurrency)}
        value={values[key]}
        className="mt-1 block w-full rounded-lg border px-3 py-2"
        onChange={(event) => change(key, event.target.value)}
      />
    </label>
  );
  const select = (
    key: Exclude<keyof Values, "occupancy" | "included" | "methods">,
    label: string,
    options: [string, string][],
  ) => (
    <label className="block text-sm">
      {label}
      <select
        aria-label={label}
        disabled={disabled}
        value={values[key]}
        className="mt-1 block w-full rounded-lg border px-3 py-2"
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
          setError(errorText(cause, t, "pricing.setup.errorCheck"));
        }
      }}
    >
      <h2 className="text-lg font-semibold">
        {t(
          existingRoom
            ? "pricing.setup.titleOffer"
            : fixedCurrency
              ? "pricing.setup.titleAnotherRoom"
              : "pricing.setup.titleFirst",
        )}
      </h2>
      <p className="text-sm text-gray-600">{t("pricing.setup.intro")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {existingRoom ? (
          <p>{t("pricing.setup.room", { name: room?.name ?? "" })}</p>
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
            <label key={index} className="block text-sm">
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
                className="mt-1 block w-full rounded-lg border px-3 py-2"
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
        methods={values.methods}
        disabled={disabled}
        onChange={(methods) => {
          setValues({ ...values, methods });
          setError("");
          onDirty();
        }}
      />
      <p className="text-sm text-gray-600">{t("pricing.setup.ageHint")}</p>
      {room && (
        <p className="text-sm">
          {t("pricing.setup.capacity", {
            total: room.capacity.total,
            adults: room.capacity.adults,
            children: room.capacity.children,
          })}{" "}
          {t(existingRoom ? "pricing.setup.existingBands" : "pricing.setup.childBand")}
        </p>
      )}
      {values.cancellation === "flexible" && (
        <p className="text-sm">{t("pricing.setup.penalty")}</p>
      )}
      <p className="text-sm text-gray-600">{t("pricing.setup.continueHint")}</p>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <button
        disabled={disabled}
        className="rounded-lg bg-emerald-700 px-5 py-2 text-white disabled:opacity-50"
      >
        {t("pricing.setup.continue")}
      </button>
    </form>
  );
}
