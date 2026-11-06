"use client";

import { useRef, useState, type ReactNode } from "react";

/** VAY-2231: the add-on card guests see on the booking page's extras step, and the details it
 * opens. Booking Admin renders these same components as its previews, so what the host sees is
 * what guests get. */

/** "€25", the way the booking page shows a price (booking-web's CurrencyContext.formatPrice). */
export function formatGuestPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

/** "/ person / night" after the price, from the add-on's pricing model. */
export function guestAddonUnit(perPerson: boolean, perNight: boolean): string {
  return perPerson ? (perNight ? "/ person / night" : "/ person") : perNight ? "/ night" : "/ stay";
}

/** The category names on the booking page's filter chips. */
export const guestAddonCategories = {
  dining: "Dining",
  experience: "Experiences",
  transport: "Transport",
  wellness: "Wellness",
  other: "Other",
};

/** The booking page's own words, for previews outside it (the page passes its translations). */
export const guestAddonText = {
  seeDetails: "See details",
  add: "Add",
  added: "Added",
  remove: "Remove",
  previousPhoto: "Previous photo",
  nextPhoto: "Next photo",
  showPhoto: (number: number) => `Show photo ${number}`,
  upToGuests: (count: number) => `Up to ${count} ${count === 1 ? "guest" : "guests"}`,
};

export const guestAddonAddClass =
  "px-5 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors bg-white text-gray-700 border-gray-300 hover:border-gray-400 disabled:opacity-40";
/** The details' filled Add button. */
export const guestAddonPrimaryClass =
  "inline-flex h-11 items-center justify-center rounded-full bg-primary-600 px-8 text-[15px] font-semibold text-white transition-colors hover:bg-primary-700 disabled:opacity-40 disabled:hover:bg-primary-600";

const tones = {
  idle: "border-gray-200",
  chosen: "border-primary-500 shadow-md",
  attention: "border-amber-400 shadow-md",
};

const plainPhoto = (src: string) => (
  <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" />
);
const path = (d: string) => (
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
);
const chevron = (d: string) => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    {path(d)}
  </svg>
);

export function GuestAddonCard({
  name,
  description,
  photo,
  price,
  unit,
  tone = "idle",
  action,
  children,
  onOpenDetails,
  detailsLabel = guestAddonText.seeDetails,
  renderPhoto = plainPhoto,
}: {
  name: string;
  description: string;
  photo: string | null;
  /** The formatted price, or null when the hotel shows none. */
  price: string | null;
  unit: string;
  /** "chosen" once added; "attention" while an added extra still needs its day. */
  tone?: keyof typeof tones;
  /** The Add button, or the counter once added. */
  action: ReactNode;
  /** Notices and the night or day choice under the price. */
  children?: ReactNode;
  /** Opens the details; the photo and the name open them too. */
  onOpenDetails?: () => void;
  detailsLabel?: string;
  /** booking-web draws photos with next/image; a plain img elsewhere. */
  renderPhoto?: (src: string) => ReactNode;
}) {
  const opens = onOpenDetails ? "cursor-pointer" : "";
  return (
    <article
      aria-label={name}
      className={`bg-white border rounded-2xl overflow-hidden transition-shadow ${tones[tone]}`}
    >
      {/* Mouse shortcuts; keyboards and screen readers use the "See details" button. */}
      <div
        className={`relative h-48 bg-gray-100 flex items-center justify-center ${opens}`}
        onClick={onOpenDetails}
      >
        {photo ? (
          renderPhoto(photo)
        ) : (
          <svg
            className="w-10 h-10 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            {path(
              "M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7",
            )}
          </svg>
        )}
      </div>
      <div className="p-4">
        <h3 className={`text-base font-bold text-gray-900 mb-1 ${opens}`} onClick={onOpenDetails}>
          {name}
        </h3>
        {description && (
          <p className={`text-sm text-gray-500 line-clamp-2 ${onOpenDetails ? "mb-1" : "mb-4"}`}>
            {description}
          </p>
        )}
        {onOpenDetails && (
          <button
            type="button"
            onClick={onOpenDetails}
            className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700"
          >
            {detailsLabel}
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {path("M9 5l7 7-7 7")}
            </svg>
          </button>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-bold text-gray-900">
            {price !== null && (
              <>
                {price}
                <span className="text-xs font-normal text-gray-500"> {unit}</span>
              </>
            )}
          </p>
          {action}
        </div>
        {children}
      </div>
    </article>
  );
}

/** VAY-2391: the words under an added extra about when it happens, for previews outside the
 * booking page (the page passes its translations). */
export const guestAddonScheduleText = {
  scheduledAutomatically: "Scheduled automatically",
  arrivalDay: (day: string) => `${day} · your arrival day`,
  departureDay: (day: string) => `${day} · your departure day`,
  everyDay: "Every day of your stay",
  nights: (count: number) => `${count} ${count === 1 ? "night" : "nights"}`,
  anytime: "Anytime during your stay",
  noDateNeeded: "No date needed",
  whichDay: "Which day?",
  chooseADay: "Choose a day to continue",
};

/** VAY-2391: under an added extra the guest doesn't schedule: when it happens, in one line. */
export function GuestAddonScheduledLine({ line, sub }: { line: string; sub: string }) {
  return (
    <div className="mt-3 flex items-center gap-2.5 border-t border-gray-100 pt-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          {path(
            "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
          )}
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-900">{line}</span>
        <span className="block text-xs text-gray-500">{sub}</span>
      </span>
    </div>
  );
}

/** VAY-2391: the days a guest can pick for an added extra, weekday over date. Without `onPick`
 * (Booking Admin's preview) the chips are pictures, not buttons. */
export function GuestAddonDayChips({
  legend,
  attention = false,
  days,
  selected,
  onPick,
  dayLabel,
}: {
  legend: string;
  /** Continue was pressed while no day is picked. */
  attention?: boolean;
  days: { date: string; weekday: string; day: string }[];
  selected: string | null;
  onPick?: (date: string) => void;
  /** The chip's accessible name, e.g. "Sunset Dinner on Wed 4 Nov". */
  dayLabel?: (weekday: string, day: string) => string;
}) {
  const chip = (on: boolean) =>
    `flex h-[52px] flex-col items-center justify-center rounded-[10px] border text-xs transition-colors ${
      on
        ? "border-gray-900 bg-gray-900 text-gray-200"
        : `bg-white text-gray-500 ${attention ? "border-amber-400" : "border-gray-300 hover:border-gray-400"}`
    }`;
  const label = (on: boolean, weekday: string, day: string) => (
    <>
      <span className={`text-[15px] font-bold leading-5 ${on ? "text-white" : "text-gray-900"}`}>
        {weekday}
      </span>
      {day}
    </>
  );
  // The line goes above the fieldset: a fieldset draws its own border through the legend.
  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <fieldset>
        <legend
          className={`mb-2 text-sm font-semibold ${attention ? "text-amber-700" : "text-gray-900"}`}
        >
          {legend}
        </legend>
        <div className="grid grid-cols-3 gap-1.5">
          {days.map(({ date, weekday, day }) => {
            const on = date === selected;
            return onPick ? (
              <button
                key={date}
                type="button"
                aria-pressed={on}
                aria-label={dayLabel?.(weekday, day)}
                onClick={() => onPick(date)}
                className={chip(on)}
              >
                {label(on, weekday, day)}
              </button>
            ) : (
              <span key={date} className={chip(on)}>
                {label(on, weekday, day)}
              </span>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

const sizes = {
  // A popup from md up, a bottom sheet below.
  responsive: {
    gallery: "h-60 md:h-[360px]",
    arrows: "hidden md:flex",
    body: "gap-3.5 px-5 py-5 md:gap-4 md:px-8 md:py-7",
    title: "text-[22px] leading-7 md:text-[26px] md:leading-8",
    text: "text-[15px] leading-[22px]",
    description: "text-base leading-[25px] md:leading-[26px]",
    footer: "px-5 pt-3.5 pb-6 md:px-8 md:py-[18px]",
  },
  // The phone layout at any width: Booking Admin's side panel.
  compact: {
    gallery: "h-44",
    arrows: "flex",
    body: "gap-3 p-4",
    title: "text-xl leading-[26px]",
    text: "text-sm leading-5",
    description: "text-sm leading-[21px]",
    footer: "px-4 py-3",
  },
};
const factIcons = {
  duration: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  location:
    "M12 21s-7-6.2-7-11.5a7 7 0 1114 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  guests:
    "M16 19v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 17.5V19M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 19v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.3a3.5 3.5 0 010 6.4",
  notice: "M6 5h12a2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2zM4 10h16M9 3v4M15 3v4",
};

/** The add-on's details: photos, words, facts and the price with the caller's action. */
export function GuestAddonDetail({
  titleId,
  name,
  category,
  photos,
  facts,
  description,
  price,
  unit,
  action,
  note,
  closeButton,
  size = "responsive",
  labels = guestAddonText,
  renderPhoto = plainPhoto,
}: {
  titleId?: string;
  name: string;
  /** "Experiences" above the name. */
  category: string;
  photos: string[];
  /** Each one the hotel filled in, ready to read ("2 hours", "Needs 24 hours' notice"). */
  facts: Partial<Record<keyof typeof factIcons, string | null>>;
  description: string;
  price: string | null;
  unit: string;
  /** Add, Added with Remove, or an Add the stay can't take. */
  action: ReactNode;
  /** Under the price: what is in the stay, or why the extra can't be added. */
  note?: { text: string; warning?: boolean } | null;
  closeButton?: ReactNode;
  size?: keyof typeof sizes;
  labels?: Pick<typeof guestAddonText, "previousPhoto" | "nextPhoto" | "showPhoto">;
  renderPhoto?: (src: string) => ReactNode;
}) {
  const look = sizes[size];
  const track = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const index = Math.min(shown, Math.max(photos.length - 1, 0));
  const go = (next: number) => {
    const to = (next + photos.length) % photos.length;
    setShown(to);
    const element = track.current;
    element?.scrollTo?.({ left: to * element.clientWidth, behavior: "smooth" });
  };
  const listed = (Object.keys(factIcons) as (keyof typeof factIcons)[]).filter((key) => facts[key]);
  const round =
    "absolute top-1/2 -translate-y-1/2 h-9 w-9 items-center justify-center rounded-full bg-white/90 text-gray-900 shadow-sm hover:bg-white";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white">
      {closeButton && <div className="absolute right-4 top-4 z-10">{closeButton}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {photos.length > 0 && (
          <div className={`relative shrink-0 bg-gray-100 ${look.gallery}`}>
            <div
              ref={track}
              onScroll={(event) => {
                const { scrollLeft, clientWidth } = event.currentTarget;
                if (clientWidth) setShown(Math.round(scrollLeft / clientWidth));
              }}
              className="flex h-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {photos.map((src, number) => (
                <div
                  key={`${number}:${src}`}
                  className="relative h-full w-full shrink-0 snap-center"
                >
                  {renderPhoto(src)}
                </div>
              ))}
            </div>
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={labels.previousPhoto}
                  onClick={() => go(index - 1)}
                  className={`${round} left-4 ${look.arrows}`}
                >
                  {chevron("M15 19l-7-7 7-7")}
                </button>
                <button
                  type="button"
                  aria-label={labels.nextPhoto}
                  onClick={() => go(index + 1)}
                  className={`${round} right-4 ${look.arrows}`}
                >
                  {chevron("M9 5l7 7-7 7")}
                </button>
                <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
                  {photos.map((src, number) => (
                    <button
                      key={`${number}:${src}`}
                      type="button"
                      aria-label={labels.showPhoto(number + 1)}
                      aria-current={number === index}
                      onClick={() => go(number)}
                      className={`h-2 w-2 rounded-full ${number === index ? "bg-white" : "bg-white/55"}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className={`flex flex-col ${look.body}`}>
          <div className={closeButton && !photos.length ? "pr-12" : ""}>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-gray-500">
              {category}
            </p>
            <h2 id={titleId} className={`font-bold text-gray-900 ${look.title}`}>
              {name}
            </h2>
          </div>
          {listed.length > 0 && (
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {listed.map((key) => (
                <li key={key} className={`flex items-center gap-1.5 text-gray-700 ${look.text}`}>
                  <svg
                    className="h-[18px] w-[18px] shrink-0 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    {path(factIcons[key])}
                  </svg>
                  {facts[key]}
                </li>
              ))}
            </ul>
          )}
          {description && (
            <p
              className={`border-t border-gray-100 pt-4 whitespace-pre-line text-gray-700 ${look.description}`}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      <div
        className={`flex shrink-0 items-center justify-between gap-3 border-t border-gray-200 bg-white ${look.footer}`}
      >
        <div className="min-w-0">
          {price !== null && (
            <p className="flex items-baseline gap-1">
              <span className="text-[22px] font-bold leading-7 text-gray-900">{price}</span>
              <span className="text-sm text-gray-500">{unit}</span>
            </p>
          )}
          {note && (
            <p
              className={`text-sm ${note.warning ? "text-amber-700" : "text-gray-600"}`}
              aria-live="polite"
            >
              {note.text}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">{action}</div>
      </div>
    </div>
  );
}
