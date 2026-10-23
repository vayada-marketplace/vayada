"use client";

import { useState } from "react";
import Image from "next/image";
import type {
  PublicBookingQuote,
  PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import type { PricingAddon } from "@/services/api/replacementAddons";
import type { ExtraDisplay } from "@/services/api/bookingPagePaymentMethods";
import {
  addonNeedsNotice,
  addonPerNight,
  addonPerPerson,
  replacementExtraDates,
  replacementExtrasScope,
  type ReplacementExtrasValue,
} from "@/services/api/replacementAddonSelection";
import {
  extraAmountMinor,
  extraCount,
  extraCountLimit,
  extraFitsParty,
  extraGuests,
  newExtraItem,
  quoteExtrasMinor,
  toggleExtraDate,
  unitMinor,
  withCount,
  type ExtraItem,
} from "@/lib/extrasChoices";
import {
  GuestAddonCard,
  GuestAddonDetail,
  guestAddonAddClass,
  guestAddonCategories,
  guestAddonPrimaryClass,
  guestAddonText,
  guestAddonUnit,
} from "@vayada/product-onboarding/GuestAddon";
import ExtraDetailsDialog from "./ExtraDetailsDialog";

type Selection = PublicBookingQuoteRequest["selection"];
/** The words the cards and details use beyond the English defaults; BookPageClient passes the
 * page's translations (VAY-2231). */
export type ExtrasLabels = typeof guestAddonText & {
  close: string;
  inYourStay: (detail: string) => string;
  groupsUpTo: (count: number) => string;
  tooSoon: (notice: string) => string;
};
const englishLabels: ExtrasLabels = {
  ...guestAddonText,
  close: "Close add-on details",
  inYourStay: (detail) => `In your stay: ${detail}`,
  groupsUpTo: (count) => `For groups of up to ${count} guests.`,
  tooSoon: (notice) => `${notice}, so it can’t be added to this stay.`,
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
 * and price; a counter for guests or items, night chips (all nights to begin with) and, for a
 * one-day extra, the day the guest picks. The caller prices the stay from the result. */
export default function ExtrasStep({
  catalogue,
  display,
  selection,
  allocationRevision,
  value,
  onChange,
  quote,
  priceFailed = false,
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
  quote?: PublicBookingQuote;
  /** The stay couldn't be priced: there is no extras total to wait for. */
  priceFailed?: boolean;
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
  const chosen = extras.filter((addon) => items.some((item) => item.id === addon.id));
  const lineMinor = chosen.map((addon) =>
    extraAmountMinor(addon, items.find((item) => item.id === addon.id)!, display[addon.id]?.price),
  );
  const quoted = quote ? quoteExtrasMinor(quote) : null;
  // An extra without its day isn't priced yet.
  const dayMissing = items.some((item) => item.dates.length === 0);
  // Display maths only when it adds up to what the quote charges for the extras.
  const showLines =
    quoted !== null &&
    lineMinor.every((amount) => amount !== null) &&
    lineMinor.reduce<bigint>((sum, amount) => sum + amount!, BigInt(0)) === quoted;
  const detail = (addon: PricingAddon, item: ExtraItem) =>
    [
      addonPerPerson(addon)
        ? `${item.people.length} ${item.people.length === 1 ? "guest" : "guests"}`
        : Number(item.quantity) > 1
          ? `×${item.quantity}`
          : null,
      addonPerNight(addon)
        ? `${item.dates.length} ${item.dates.length === 1 ? "night" : "nights"}`
        : item.dates[0]
          ? `${formatDay(item.dates[0]).weekday} ${formatDay(item.dates[0]).day}`
          : "day not chosen",
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
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
            const days = replacementExtraDates(selection, addonPerNight(addon));
            const missingDay = !!item && item.dates.length === 0;
            const price = unitMinor(facts?.price, addon.currency);
            return (
              <GuestAddonCard
                key={addon.id}
                name={addon.name}
                description={facts?.description ?? ""}
                photo={facts?.image ?? null}
                price={price !== null ? formatMoney(String(price), addon.currency) : null}
                unit={unit(addon)}
                tone={item ? (missingDay ? "attention" : "chosen") : "idle"}
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
                      disabled={!fits || tooSoon || items.length >= 99}
                      aria-label={`Add ${addon.name}`}
                      aria-describedby={tooSoon ? `extra-notice-${addon.id}` : undefined}
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
                {item && (
                  <fieldset className="mt-3 pt-3 border-t border-gray-100">
                    <legend
                      className={`text-xs mb-2 ${missingDay ? "text-amber-700 font-medium" : "text-gray-500"}`}
                    >
                      {addonPerNight(addon)
                        ? "Which nights?"
                        : missingDay
                          ? "Choose a day for this extra"
                          : "Which day?"}
                    </legend>
                    <div className="flex flex-wrap gap-1.5">
                      {days.map((date) => {
                        const on = item.dates.includes(date);
                        const { weekday, day } = formatDay(date);
                        return (
                          <button
                            key={date}
                            type="button"
                            aria-pressed={on}
                            aria-label={`${addon.name} on ${weekday} ${day}`}
                            onClick={() => replace(toggleExtraDate(addon, item, date))}
                            className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                              on
                                ? "bg-primary-50 text-primary-700 border-primary-300"
                                : missingDay
                                  ? "bg-white text-gray-600 border-amber-300"
                                  : "bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300"
                            }`}
                          >
                            <span className="block leading-tight">{weekday}</span>
                            <span className="block leading-tight text-[10px]">{day}</span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                )}
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
                    // Adding closes the details: nights and days are picked on the card.
                    <button
                      type="button"
                      className={guestAddonPrimaryClass}
                      disabled={!fits || tooSoon || items.length >= 99}
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
      {chosen.length > 0 && (
        <div className="bg-gradient-to-br from-primary-50 to-white border border-primary-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center text-white">
              {icon("M5 13l4 4L19 7", "w-4 h-4")}
            </div>
            <h2 className="text-lg font-bold text-gray-900">Your extras ({chosen.length})</h2>
          </div>
          <ul className="space-y-3 mb-5">
            {chosen.map((addon, index) => {
              const item = items.find((current) => current.id === addon.id)!;
              const image = display[addon.id]?.image;
              return (
                <li
                  key={addon.id}
                  className="flex items-center justify-between gap-3 bg-white rounded-xl px-4 py-3 border border-gray-100"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
                      {image && (
                        <Image src={image} alt="" fill className="object-cover" sizes="48px" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{addon.name}</p>
                      <p className="text-xs text-gray-500">{detail(addon, item)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {showLines && (
                      <p className="text-sm font-bold text-gray-900">
                        {formatMoney(String(lineMinor[index]), addon.currency)}
                      </p>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${addon.name} from your extras`}
                      onClick={() => set(items.filter((current) => current.id !== addon.id))}
                      className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                    >
                      {icon(cross, "w-3.5 h-3.5")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center justify-between pt-4 border-t border-primary-100">
            <p className="text-sm text-gray-500">Extras total</p>
            <p
              className={
                quoted !== null
                  ? "text-xl font-bold text-gray-900"
                  : `text-sm ${dayMissing ? "font-medium text-amber-700" : "text-gray-500"}`
              }
              aria-live="polite"
            >
              {quoted !== null
                ? formatMoney(String(quoted), selection.currency)
                : dayMissing
                  ? "Choose a day"
                  : priceFailed
                    ? "—"
                    : "Updating…"}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
