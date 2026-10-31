"use client";

import { CheckIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import type { Booking } from "@/services/bookings";
import type { CheckinSettings } from "@/services/settings";
import type { AddonOffer } from "@/lib/checkin/addons";
import { countLabel } from "@/lib/checkin/labels";
import { deskMethods, type DeskMethod, type PaymentChoice } from "@/lib/checkin/payment";
import type { CheckinRoom } from "@/lib/checkin/rooms";
import { formatServiceDays } from "@/lib/bookings/serviceDays";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";

export interface PaymentLine {
  key: string;
  label: string;
  amount: number;
}

/** Step 3: add-ons already booked, add-ons to offer (desk charges, D3), what is due now and how it
 * is settled (D2), as approved in Paper (p-16-0). */
export function AddonsPaymentStep({
  booking,
  settings,
  offers,
  quantities,
  onQuantity,
  locked,
  lines,
  dueNow,
  choice,
  onChoice,
  recorded,
  settledElsewhere,
}: {
  booking: Booking;
  settings: CheckinSettings;
  offers: AddonOffer[];
  /** Add-on id → how many are added now. */
  quantities: Record<string, number>;
  onQuantity: (addonId: string, quantity: number) => void;
  /** The payment is recorded: the add-ons can't change any more. */
  locked: boolean;
  lines: PaymentLine[];
  dueNow: number;
  choice: PaymentChoice | null;
  onChoice: (choice: PaymentChoice) => void;
  /** "€721 · cash", once recorded. */
  recorded: string | null;
  /** Part of the balance is settled outside the desk (a channel collects it, or the booking is closed). */
  settledElsewhere: boolean;
}) {
  const { t, locale } = useTranslation();
  const money = (amount: number) => formatCurrency(amount, booking.currency);
  // Each extra once, with its days (VAY-2409).
  const booked = booking.addonSelections?.length
    ? booking.addonSelections.map((selection) => ({
        key: selection.selectionIds[0]!,
        name: selection.quantity > 1 ? `${selection.name} × ${selection.quantity}` : selection.name,
        days: formatServiceDays(selection.dates, locale),
      }))
    : booking.addonNames.map((name, index) => ({ key: `${index}`, name, days: null }));
  const added = offers.filter((offer) => (quantities[offer.addon.id] ?? 0) > 0);
  const addedTotal = added.reduce(
    (sum, offer) => sum + offer.amount * (quantities[offer.addon.id] ?? 0),
    0,
  );
  const methods = deskMethods(settings.settlementOptions);
  const methodLabel = (method: DeskMethod) => t(`settings.checkIn.settlement.${method}`);
  const detail = (offer: AddonOffer) => {
    const price = money(offer.addon.price);
    if (offer.model === "per_guest_night")
      return t("checkIn.flow.payment.perGuestNight", { price, count: offer.units });
    if (offer.model === "per_night")
      return t("checkIn.flow.payment.perNight", { price, count: offer.units });
    if (offer.model === "per_guest")
      return t("checkIn.flow.payment.perGuest", { price, count: offer.units });
    return t("checkIn.flow.payment.perStay");
  };

  return (
    <div className="flex flex-col gap-8">
      {booked.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
            {t("checkIn.flow.payment.alreadyBooked")}
          </h3>
          {booked.map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-3 rounded-2xl border border-green-200 bg-green-50 px-4 py-3.5"
            >
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
              >
                <CheckIcon className="h-4 w-4" strokeWidth={2.5} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold text-gray-900">{item.name}</p>
                {item.days && <p className="text-sm text-gray-600">{item.days}</p>}
              </div>
              <p className="shrink-0 text-sm font-semibold text-green-700">
                {t("checkIn.flow.payment.inTheBooking")}
              </p>
            </div>
          ))}
        </section>
      )}

      {settings.offerAddons && offers.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">
            {t("checkIn.flow.payment.offer")}
          </h3>
          {offers.map((offer) => {
            const quantity = quantities[offer.addon.id] ?? 0;
            const name = offer.addon.name;
            return (
              <div
                key={offer.addon.id}
                className={`flex flex-col gap-3 rounded-2xl px-4 py-3.5 sm:flex-row sm:items-center ${
                  quantity > 0 && !offer.byQuantity
                    ? "bg-primary-50 shadow-[inset_0_0_0_2px] shadow-primary-600"
                    : "border border-gray-200 bg-white"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-bold text-gray-900">
                    {name}
                    {quantity > 0 && !offer.byQuantity && (
                      <span className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-semibold text-primary-800">
                        {t("checkIn.flow.payment.added")}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-gray-600">{detail(offer)}</p>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
                  <p className="text-[15px] font-bold text-gray-900">
                    {offer.byQuantity
                      ? t("checkIn.flow.payment.each", { amount: money(offer.amount) })
                      : money(offer.amount)}
                  </p>
                  {offer.byQuantity ? (
                    <div className="flex items-center rounded-xl border border-gray-300 bg-white">
                      <button
                        type="button"
                        disabled={locked || quantity === 0}
                        onClick={() => onQuantity(offer.addon.id, quantity - 1)}
                        aria-label={t("checkIn.flow.payment.fewer", { name })}
                        className="flex h-10 w-10 items-center justify-center text-gray-700 disabled:opacity-40"
                      >
                        <MinusIcon className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <span
                        aria-live="polite"
                        className="w-8 text-center text-[15px] font-semibold text-gray-900"
                      >
                        {quantity}
                      </span>
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => onQuantity(offer.addon.id, quantity + 1)}
                        aria-label={t("checkIn.flow.payment.more", { name })}
                        className="flex h-10 w-10 items-center justify-center text-gray-700 disabled:opacity-40"
                      >
                        <PlusIcon className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => onQuantity(offer.addon.id, quantity > 0 ? 0 : 1)}
                      className={`rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 ${
                        quantity > 0
                          ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                          : "bg-primary-600 text-white hover:bg-primary-700"
                      }`}
                    >
                      {quantity > 0
                        ? t("checkIn.flow.payment.remove")
                        : t("checkIn.flow.payment.add")}
                      <span className="sr-only"> {name}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex justify-between gap-4 text-[15px] font-bold text-gray-900">
            <span>{t("checkIn.flow.payment.addedAtCheckin")}</span>
            <span>{money(addedTotal)}</span>
          </div>
          <p className="text-sm text-gray-600">{t("checkIn.flow.payment.addedNote")}</p>
        </section>
      )}

      <section className="flex flex-col gap-4 border-t border-gray-200 pt-8">
        <h3 className="text-lg font-bold text-gray-900">{t("checkIn.flow.payment.heading")}</h3>
        <dl className="flex max-w-xl flex-col gap-2 text-[15px]">
          {lines.map((line) => (
            <div key={line.key} className="flex justify-between gap-4">
              <dt className="text-gray-700">{line.label}</dt>
              <dd className="font-semibold text-gray-900">{money(line.amount)}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between gap-4 border-t border-gray-200 pt-3 text-lg font-extrabold text-gray-900">
            <dt>{t("checkIn.flow.payment.dueNow")}</dt>
            <dd>{money(dueNow)}</dd>
          </div>
        </dl>

        {recorded ? (
          <p className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-[15px] font-semibold text-green-800">
            <CheckIcon className="h-5 w-5" aria-hidden="true" />
            {t("checkIn.flow.payment.recorded", { payment: recorded })}
          </p>
        ) : dueNow <= 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-[15px] font-semibold text-green-800">
            <CheckIcon className="h-5 w-5" aria-hidden="true" />
            {t(
              settledElsewhere
                ? "checkIn.flow.payment.nothingAtDesk"
                : "checkIn.flow.payment.nothingDue",
            )}
          </p>
        ) : (
          <>
            <div
              role="radiogroup"
              aria-label={t("checkIn.flow.payment.howSettled")}
              className="grid gap-3 md:grid-cols-3"
            >
              {methods.length > 0 && (
                <ChoiceCard
                  on={choice?.kind === "collect"}
                  title={t("checkIn.flow.payment.collectNow")}
                  description={t("checkIn.flow.payment.collectNowHint")}
                  onSelect={() =>
                    choice?.kind !== "collect" && onChoice({ kind: "collect", method: methods[0]! })
                  }
                >
                  <div className="mt-3 flex flex-wrap gap-2">
                    {methods.map((method) => (
                      <button
                        key={method}
                        type="button"
                        aria-pressed={choice?.kind === "collect" && choice.method === method}
                        onClick={(event) => {
                          event.stopPropagation();
                          onChoice({ kind: "collect", method });
                        }}
                        className={`rounded-full px-3.5 py-2 text-sm font-semibold ${
                          choice?.kind === "collect" && choice.method === method
                            ? "bg-white text-primary-800 shadow-[inset_0_0_0_2px] shadow-primary-600"
                            : "border border-gray-300 bg-white text-gray-800"
                        }`}
                      >
                        {methodLabel(method)}
                      </button>
                    ))}
                  </div>
                </ChoiceCard>
              )}
              {settings.settlementOptions.includes("at_checkout") && (
                <ChoiceCard
                  on={choice?.kind === "at_checkout"}
                  title={t("checkIn.flow.payment.atCheckout")}
                  description={t("checkIn.flow.payment.atCheckoutHint")}
                  onSelect={() => onChoice({ kind: "at_checkout" })}
                />
              )}
              {settings.settlementOptions.includes("already_paid") && (
                <ChoiceCard
                  on={choice?.kind === "already_paid"}
                  title={t("checkIn.flow.payment.alreadyPaid")}
                  description={t("checkIn.flow.payment.alreadyPaidHint")}
                  onSelect={() => onChoice({ kind: "already_paid" })}
                />
              )}
            </div>
            {choice && (
              <p className="text-sm text-gray-600">
                {choice.kind === "collect"
                  ? t("checkIn.flow.payment.collectNote", {
                      amount: money(dueNow),
                      method: methodLabel(choice.method),
                    })
                  : choice.kind === "at_checkout"
                    ? t("checkIn.flow.payment.atCheckoutNote", { amount: money(dueNow) })
                    : t("checkIn.flow.payment.alreadyPaidNote", { amount: money(dueNow) })}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ChoiceCard({
  on,
  title,
  description,
  onSelect,
  children,
}: {
  on: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={on}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer rounded-2xl px-4 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 ${
        on
          ? "bg-primary-50 shadow-[inset_0_0_0_2px] shadow-primary-600"
          : "border border-gray-200 bg-white"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
            on ? "border-primary-600" : "border-gray-300"
          }`}
        >
          {on && <span className="h-2.5 w-2.5 rounded-full bg-primary-600" />}
        </span>
        <span>
          <span className="block text-[15px] font-bold text-gray-900">{title}</span>
          <span className="block text-sm text-gray-600">{description}</span>
        </span>
      </div>
      {children}
    </div>
  );
}

/** "Room 104 · 2 nights · Flexible", for the payment breakdown. */
export function roomLineLabel(
  room: CheckinRoom,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  return [
    room.unit ? t("dashboard.popup.roomNumber", { number: room.unit }) : room.type,
    countLabel(t, "nights", room.nights),
    room.ratePlan,
  ]
    .filter(Boolean)
    .join(" · ");
}
