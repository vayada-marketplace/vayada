"use client";

import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { Translate } from "./pricingAmounts";
import { addDays, mainOffer, money, stayTotals, type OptionTerms } from "./stepPricing";

/** Facts the guest card shows beside the prices. */
export type RoomFacts = { name: string; size: number | null; photo: string | null };
const day = (date: string, t: Translate) =>
  `${Number(date.slice(8))} ${t(`pricing.steps.monthShort.${Number(date.slice(5, 7))}`)}`;

/** "What guests see": the room as a booking-page card with each option's total for the sample stay, from the
 * engine's stay calculation. Choosing an option here also picks the calendar's option. `room` is the edited room, or
 * null while an edit doesn't validate yet. */
export function GuestPreview({
  room,
  facts,
  names,
  terms,
  stay,
  today,
  selected,
  onSelect,
}: {
  room: PricingConfiguration | null;
  facts: RoomFacts;
  names: Readonly<Record<string, string>>;
  terms: Readonly<Record<string, OptionTerms | undefined>>;
  stay: { checkIn: string; checkOut: string };
  /** The viewer's date (YYYY-MM-DD), for whether free cancellation is still open for the sample stay. */
  today: string;
  selected: string;
  onSelect: (offerId: string) => void;
}) {
  const { t } = useTranslation();
  const nights = Math.round((Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 86400000);
  const totals = room ? stayTotals(room, stay.checkIn, stay.checkOut) : {};
  const totalOf = (offerId: string | undefined) => {
    const result = offerId ? totals[offerId] : undefined;
    return result?.kind === "priced" ? result.totalMinor : null;
  };
  const main = room ? mainOffer(room) : null;
  const mainTotal = totalOf(main?.id);
  const subtitle = (offer: PricingConfiguration["offers"][number], total: string) => {
    // Display only: the saving against the main option, rounded to a whole percent ("Save 10%").
    const saving =
      mainTotal && offer.id !== main?.id
        ? Math.round(((Number(mainTotal) - Number(total)) * 100) / Number(mainTotal))
        : 0;
    if (saving > 0)
      return { text: t("pricing.steps.guests.save", { percent: saving }), green: true };
    // The option's name already says its meal (VAY-2188), so the line says its cancellation.
    // Free cancellation ends `freeCancellationDeadlineDays` before arrival; a sample stay inside that window has none.
    const cancellation = terms[offer.id]?.cancellation;
    if (!cancellation) return { text: "", green: false };
    if (cancellation.kind === "non_refundable")
      return { text: t("pricing.steps.summary.noRefund"), green: false };
    const deadline = addDays(stay.checkIn, -cancellation.terms.freeCancellationDeadlineDays);
    return {
      text:
        deadline < today
          ? t("pricing.steps.guests.freeGone")
          : t("pricing.steps.guests.freeUntil", { day: day(deadline, t) }),
      green: false,
    };
  };
  const chosen = room?.offers.some((offer) => offer.id === selected) ? selected : main?.id;
  const chosenTotal = totalOf(chosen);
  return (
    <section
      aria-label={t("pricing.steps.guests.title")}
      className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-gray-500">
          {t("pricing.steps.guests.title")}
        </h3>
        <span className="text-[13px] text-gray-500">
          {`${t(nights === 1 ? "pricing.steps.guests.nights.one" : "pricing.steps.guests.nights.other", { count: nights })} · ${day(stay.checkIn, t)}–${day(stay.checkOut, t)}`}
        </span>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-gray-200">
        {facts.photo ? (
          // eslint-disable-next-line @next/next/no-img-element -- a stored room photo, as the booking page shows it
          <img src={facts.photo} alt="" className="h-[120px] w-full object-cover" />
        ) : (
          <div
            aria-hidden="true"
            className="h-[120px] bg-gradient-to-br from-primary-100 to-primary-50"
          />
        )}
        <div className="space-y-3 p-4">
          <div className="space-y-0.5">
            <p className="text-[17px] font-bold leading-[22px] text-gray-900">{facts.name}</p>
            <p className="text-[13px] text-gray-500">
              {[
                facts.size ? t("pricing.steps.guests.size", { size: facts.size }) : null,
                room
                  ? t(
                      room.capacity.total === 1
                        ? "pricing.steps.guests.capacity.one"
                        : "pricing.steps.guests.capacity.other",
                      { count: room.capacity.total },
                    )
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {!room ? (
            <p className="text-[13px] text-gray-500">{t("pricing.steps.guests.invalid")}</p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t("pricing.steps.guests.choose")}
              className="space-y-2"
              onKeyDown={(event) => {
                // A radio group moves with the arrow keys; only the chosen option is a Tab stop.
                const step = (
                  { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<
                    string,
                    number
                  >
                )[event.key];
                if (!step) return;
                event.preventDefault();
                const index = room.offers.findIndex((offer) => offer.id === chosen);
                const next = (index + step + room.offers.length) % room.offers.length;
                onSelect(room.offers[next].id);
                event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
              }}
            >
              {room.offers.map((offer) => {
                const total = totalOf(offer.id),
                  active = offer.id === chosen,
                  note =
                    total === null
                      ? { text: t("pricing.steps.guests.unavailable"), green: false }
                      : subtitle(offer, total);
                return (
                  <button
                    key={offer.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => onSelect(offer.id)}
                    className={`flex w-full items-center gap-3 rounded-[10px] p-3 text-left ${active ? "border-[1.5px] border-primary-500 bg-primary-50/60" : "border border-gray-200 hover:bg-gray-50"}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-[18px] w-[18px] shrink-0 rounded-full ${active ? "border-[5px] border-primary-500" : "border-[1.5px] border-gray-400"}`}
                    />
                    <span className="min-w-0 grow">
                      <span className="block text-[14px] font-semibold leading-[18px] text-gray-900">
                        {names[offer.id]}
                      </span>
                      {note.text && (
                        <span
                          className={`block text-[12px] ${note.green ? "font-medium text-green-700" : "text-gray-500"}`}
                        >
                          {note.text}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-[15px] font-bold text-gray-900">
                      {total === null ? "—" : money(total, room.currency)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* A picture of the booking page's button, not a control. */}
          {chosenTotal && room && (
            <div className="flex h-11 items-center justify-center rounded-[10px] bg-primary-500 text-[14px] font-semibold text-white">
              {t(
                nights === 1
                  ? "pricing.steps.guests.select.one"
                  : "pricing.steps.guests.select.other",
                { amount: money(chosenTotal, room.currency), count: nights },
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
