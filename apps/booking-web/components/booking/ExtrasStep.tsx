"use client";

import { useState } from "react";
import Image from "next/image";
import type { PublicBookingQuoteRequest } from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import type { ExtraDisplay } from "@/services/api/bookingPagePaymentMethods";
import {
  addonNeedsNotice,
  addonPerNight,
  addonPerPerson,
  addonPickDates,
  replacementExtraDates,
  replacementExtrasScope,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";
import {
  extraCount,
  extraCountLimit,
  extraFitsParty,
  extraGuests,
  extraNeedsDay,
  newExtraItem,
  toggleExtraDate,
  unitMinor,
  withCount,
  type ExtraItem,
} from "@/lib/extrasChoices";
import {
  GuestAddonCard,
  GuestAddonDayChips,
  GuestAddonDetail,
  GuestAddonScheduledLine,
  guestAddonAddClass,
  guestAddonCategories,
  guestAddonPrimaryClass,
  guestAddonScheduleText,
  guestAddonText,
  guestAddonUnit,
} from "@vayada/product-onboarding/GuestAddon";
import ExtraDetailsDialog from "./ExtraDetailsDialog";

type Selection = PublicBookingQuoteRequest["selection"];
/** The words the cards and details use beyond the English defaults; BookPageClient passes the
 * page's translations (VAY-2231). */
export type ExtrasLabels = typeof guestAddonText &
  typeof guestAddonScheduleText & {
    close: string;
    inYourStay: (detail: string) => string;
    groupsUpTo: (count: number) => string;
    tooSoon: (notice: string) => string;
    /** VAY-2391: a "guest_pick" extra none of whose days falls in the stay. */
    notOnYourDates: string;
    /** "Sunset Dinner on Wed 4 Nov", a day chip's name. */
    dayOn: (name: string, day: string) => string;
  };
const englishLabels: ExtrasLabels = {
  ...guestAddonText,
  ...guestAddonScheduleText,
  close: "Close add-on details",
  inYourStay: (detail) => `In your stay: ${detail}`,
  groupsUpTo: (count) => `For groups of up to ${count} guests.`,
  tooSoon: (notice) => `${notice}, so it can’t be added to this stay.`,
  notOnYourDates: "Not offered on the days of your stay.",
  dayOn: (name, day) => `${name} on ${day}`,
};
const round =
  "w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";
const icon = (d: string, size = "w-3 h-3") => (
  <svg className={size} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
);
const minus = "M20 12H4";
const plus = "M12 4v16m8-8H4";
const cross = "M6 18L18 6M6 6l12 12";

const unit = (addon: PricingAddon) => guestAddonUnit(addonPerPerson(addon), addonPerNight(addon));

/** The old add-ons page on pricing v2 (VAY-2195): the hotel's extras as cards with photo, words
 * and price; a counter for guests or items and, once added, when it happens (VAY-2391): one line
 * for an extra the hotel schedules, the days to pick from for one the guest schedules. The caller
 * prices the stay from the result and shows the chosen extras in its bar. */
export default function ExtrasStep({
  catalogue,
  display,
  selection,
  allocationRevision,
  value,
  onChange,
  attention = false,
  formatMoney,
  formatDay,
  formatNotice,
  showCategories = true,
  labels = englishLabels,
}: {
  catalogue: PricingAddon[];
  display: Record<string, ExtraDisplay>;
  selection: Selection;
  allocationRevision: number;
  value: ReplacementExtrasValue | null;
  onChange: (value: ReplacementExtrasValue | null) => void;
  /** Continue was pressed while an extra still needs its day: those cards say so. */
  attention?: boolean;
  formatMoney: (minor: string, currency: string) => string;
  formatDay: (date: string) => { weekday: string; day: string };
  /** "Needs 24 hours’ notice", in the page's language. */
  formatNotice: (hours: number) => string;
  /** The hotel's "group add-ons by category" setting. */
  showCategories?: boolean;
  labels?: ExtrasLabels;
}) {
  const scope = replacementExtrasScope(catalogue, selection, allocationRevision);
  const items = value?.scope === scope ? value.items : [];
  const extras = catalogue.filter((addon) => addon.currency === selection.currency);
  const categories = Array.from(new Set(extras.map((a) => display[a.id]?.category ?? "other")));
  const [category, setCategory] = useState<string>("all");
  // The extra whose details are open (VAY-2231).
  const [open, setOpen] = useState<string | null>(null);
  const opened = extras.find((addon) => addon.id === open);
  const guests = extraGuests(selection).length;
  const set = (next: ExtraItem[]) => onChange(next.length ? { scope, items: next } : null);
  const replace = (item: ExtraItem) =>
    set(items.map((current) => (current.id === item.id ? item : current)));
  const day = (date: string) => `${formatDay(date).weekday} ${formatDay(date).day}`;
  const noDayFor = (addon: PricingAddon) =>
    addon.scheduleMode === "guest_pick" && !addonPickDates(selection, addon).length;
  const nights = replacementExtraDates(selection, true).length;
  // VAY-2391: when an added extra happens, as the line under its card says it.
  const schedule = (addon: PricingAddon): [string, string] => {
    if (addon.scheduleMode === "arrival")
      return [labels.arrivalDay(day(selection.checkIn)), labels.scheduledAutomatically];
    if (addon.scheduleMode === "departure")
      return [labels.departureDay(day(selection.checkOut)), labels.scheduledAutomatically];
    if (addon.scheduleMode === "daily") return [labels.everyDay, labels.nights(nights)];
    return [labels.anytime, labels.noDateNeeded];
  };
  const detail = (addon: PricingAddon, item: ExtraItem) =>
    [
      addonPerPerson(addon)
        ? `${item.people.length} ${item.people.length === 1 ? "guest" : "guests"}`
        : Number(item.quantity) > 1
          ? `×${item.quantity}`
          : null,
      addon.scheduleMode !== "guest_pick"
        ? schedule(addon)[0]
        : item.dates[0]
          ? day(item.dates[0])
          : labels.whichDay,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <section aria-label="Optional extras">
      {showCategories && categories.length > 1 && (
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {["all", ...categories].map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={category === key}
              onClick={() => setCategory(key)}
              className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                category === key
                  ? "bg-primary-600 text-white border-primary-600"
                  : "bg-white text-gray-700 border-gray-300 hover:border-gray-400"
              }`}
            >
              {key === "all" ? "All extras" : guestAddonCategories[key as ExtraDisplay["category"]]}
            </button>
          ))}
        </div>
      )}
      {/* Two to a row beside "Your stay" (VAY-2416). */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
        {extras
          .filter(
            (addon) => category === "all" || (display[addon.id]?.category ?? "other") === category,
          )
          .map((addon) => {
            const facts = display[addon.id];
            const item = items.find((current) => current.id === addon.id);
            const fits = extraFitsParty(addon, selection);
            const tooSoon = addonNeedsNotice(addon, selection.checkIn);
            const limit = extraCountLimit(addon, selection);
            const count = item ? extraCount(addon, item) : 0;
            const days =
              addon.scheduleMode === "guest_pick" ? addonPickDates(selection, addon) : [];
            // None of the days it is offered on falls in this stay.
            const noDay = addon.scheduleMode === "guest_pick" && !days.length;
            const missingDay = !!item && extraNeedsDay(addon, item);
            const price = unitMinor(facts?.price, addon.currency);
            return (
              <GuestAddonCard
                key={addon.id}
                name={addon.name}
                description={facts?.description ?? ""}
                photo={facts?.image ?? null}
                price={price !== null ? formatMoney(String(price), addon.currency) : null}
                unit={unit(addon)}
                tone={item ? (missingDay && attention ? "attention" : "chosen") : "idle"}
                onOpenDetails={() => setOpen(addon.id)}
                detailsLabel={labels.seeDetails}
                renderPhoto={(src) => (
                  <Image
                    src={src}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
                  />
                )}
                action={
                  item ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className={round}
                        aria-label={`Fewer for ${addon.name}`}
                        disabled={count <= 1}
                        onClick={() => replace(withCount(item, addon, selection, count - 1))}
                      >
                        {icon(minus)}
                      </button>
                      <span className="w-12 text-center text-sm font-semibold text-gray-900">
                        {addonPerPerson(addon) ? `${count}/${guests}` : count}
                      </span>
                      <button
                        type="button"
                        className={round}
                        aria-label={`More for ${addon.name}`}
                        disabled={count >= limit}
                        onClick={() => replace(withCount(item, addon, selection, count + 1))}
                      >
                        {icon(plus)}
                      </button>
                      <button
                        type="button"
                        className="ml-1 w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                        aria-label={`Remove ${addon.name}`}
                        onClick={() => set(items.filter((current) => current.id !== addon.id))}
                      >
                        {icon(cross, "w-3.5 h-3.5")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={!fits || tooSoon || noDay || items.length >= 99}
                      aria-label={`Add ${addon.name}`}
                      aria-describedby={tooSoon || noDay ? `extra-notice-${addon.id}` : undefined}
                      onClick={() => set([...items, newExtraItem(addon, selection)])}
                      className={guestAddonAddClass}
                    >
                      {labels.add}
                    </button>
                  )
                }
              >
                {!fits && (
                  <p className="mt-2 text-xs text-gray-500">
                    {labels.groupsUpTo(addon.maxGuests!)}
                  </p>
                )}
                {tooSoon && addon.leadTimeHours !== null && (
                  <p id={`extra-notice-${addon.id}`} className="mt-2 text-xs text-gray-500">
                    {formatNotice(addon.leadTimeHours)}
                  </p>
                )}
                {!tooSoon && noDay && !item && (
                  <p id={`extra-notice-${addon.id}`} className="mt-2 text-xs text-gray-500">
                    {labels.notOnYourDates}
                  </p>
                )}
                {item &&
                  (addon.scheduleMode === "guest_pick" ? (
                    <GuestAddonDayChips
                      legend={missingDay && attention ? labels.chooseADay : labels.whichDay}
                      attention={missingDay && attention}
                      days={days.map((date) => ({ date, ...formatDay(date) }))}
                      selected={item.dates[0] ?? null}
                      onPick={(date) => replace(toggleExtraDate(item, date))}
                      dayLabel={(weekday, date) => labels.dayOn(addon.name, `${weekday} ${date}`)}
                    />
                  ) : (
                    <GuestAddonScheduledLine line={schedule(addon)[0]} sub={schedule(addon)[1]} />
                  ))}
              </GuestAddonCard>
            );
          })}
      </div>
      {opened && (
        <ExtraDetailsDialog key={opened.id} closeLabel={labels.close} onClose={() => setOpen(null)}>
          {({ titleId, closeButton, close }) => {
            const facts = display[opened.id];
            const item = items.find((current) => current.id === opened.id);
            const fits = extraFitsParty(opened, selection);
            const tooSoon = addonNeedsNotice(opened, selection.checkIn);
            const price = unitMinor(facts?.price, opened.currency);
            const notice =
              opened.leadTimeHours !== null ? formatNotice(opened.leadTimeHours) : null;
            return (
              <GuestAddonDetail
                titleId={titleId}
                name={opened.name}
                category={guestAddonCategories[facts?.category ?? "other"]}
                photos={facts?.photos ?? []}
                facts={{
                  duration: facts?.duration,
                  location: facts?.location,
                  guests: opened.maxGuests !== null ? labels.upToGuests(opened.maxGuests) : null,
                  notice,
                }}
                description={facts?.description ?? ""}
                price={price !== null ? formatMoney(String(price), opened.currency) : null}
                unit={unit(opened)}
                closeButton={closeButton}
                labels={labels}
                renderPhoto={(src) => (
                  <Image
                    src={src}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="(min-width: 768px) 680px, 100vw"
                  />
                )}
                note={
                  item
                    ? { text: labels.inYourStay(detail(opened, item)) }
                    : !fits && opened.maxGuests !== null
                      ? { text: labels.groupsUpTo(opened.maxGuests), warning: true }
                      : tooSoon && notice
                        ? { text: labels.tooSoon(notice), warning: true }
                        : noDayFor(opened)
                          ? { text: labels.notOnYourDates, warning: true }
                          : null
                }
                action={
                  item ? (
                    <>
                      <button
                        type="button"
                        onClick={() => set(items.filter((current) => current.id !== opened.id))}
                        className="text-[15px] font-semibold text-gray-600 hover:text-gray-900"
                      >
                        {labels.remove}
                      </button>
                      <span className="inline-flex h-11 items-center gap-1.5 rounded-full border border-primary-200 bg-primary-50 px-5 text-[15px] font-semibold text-primary-700">
                        {icon("M5 13l4 4L19 7", "w-4 h-4")}
                        {labels.added}
                      </span>
                    </>
                  ) : (
                    // Adding closes the details: a day is picked on the card.
                    <button
                      type="button"
                      className={guestAddonPrimaryClass}
                      disabled={!fits || tooSoon || noDayFor(opened) || items.length >= 99}
                      onClick={() => {
                        set([...items, newExtraItem(opened, selection)]);
                        close();
                      }}
                    >
                      {labels.add}
                    </button>
                  )
                }
              />
            );
          }}
        </ExtraDetailsDialog>
      )}
    </section>
  );
}
