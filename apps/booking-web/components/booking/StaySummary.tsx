"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  isManualPricingPaymentMethod,
  type PricingPaymentMethod,
  type PublicBookingQuote,
  type PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { serverNow } from "@/lib/serverClock";
import { resolveLocale } from "@/lib/utils";

/** One booked room as the guest knows it: its name, plain choice name, photo and guests. */
export type SummaryRoom = {
  selectionId: string;
  name: string;
  choice: string;
  image?: string;
  guests?: string;
};

/** One chosen extra (VAY-2416): its price when the shown prices add up to the quote's, or the day
 * it still waits for. */
export type SummaryExtra = { id: string; name: string; price: string | null; needsDay: boolean };

/** The step's main button in "Your stay" (VAY-2416): the same size and place on every step. An
 * extra still waiting for its day greys it, but it stays pressable to say why. */
export const stayButton = (waiting = false) =>
  `flex h-[52px] w-full items-center justify-center rounded-full px-5 text-[17px] font-semibold text-white disabled:opacity-40 ${waiting ? "bg-gray-400" : "bg-primary-600"}`;

function Row({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-[15px]">
      <span className="text-gray-600">
        {label}
        {sub && <span className="block text-sm text-gray-500">{sub}</span>}
      </span>
      <span className="font-semibold text-gray-900 text-right">{value}</span>
    </div>
  );
}

const sum = (lines: PublicBookingQuote["lines"]) =>
  lines.reduce((total, line) => total + BigInt(line.amountMinor), BigInt(0));
const icon = (d: string, className: string) => (
  <svg
    className={`h-4 w-4 shrink-0 ${className}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={d} />
  </svg>
);
const link = "text-sm font-semibold underline underline-offset-2 disabled:opacity-40";

/** "14:52" left on the price, on the server's clock; null once it ran out. */
function useTimeLeft(expiresAt: string | undefined): string | null {
  const left = () => (expiresAt ? Math.max(0, Date.parse(expiresAt) - serverNow()) : 0);
  const [ms, setMs] = useState(left);
  useEffect(() => {
    setMs(left());
    if (!expiresAt) return;
    const timer = setInterval(() => setMs(left()), 1000);
    return () => clearInterval(timer);
    // `left` reads only expiresAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  if (ms <= 0) return null;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "Your stay" (VAY-2347), the one summary on each checkout step: the rooms, the dates with the
 * hotel's times, what the price charges and its total, then how the guest can pay or the price's
 * payment lines, and how long the price is held.
 *
 * VAY-2416: with an `action` it is the step's checkout card. The step's main button sits at its
 * bottom (below the tick on Review); it is sticky beside the step on wide screens and a bar fixed to
 * the bottom of the screen on phones, its lines behind "Details". It also stands without a price
 * yet, with `pending` in the total's place. */
export default function StaySummary({
  quote,
  checkIn = quote?.checkIn ?? "",
  checkOut = quote?.checkOut ?? "",
  rooms,
  guests,
  rules,
  formatMoney,
  methods,
  box,
  expired = false,
  extras,
  pending,
  onChangeRoom,
  onRemoveRoom,
  locked = false,
  action,
}: {
  quote?: PublicBookingQuote;
  /** The stay's dates while there is no price. */
  checkIn?: string;
  checkOut?: string;
  rooms: SummaryRoom[];
  guests: string;
  /** The hotel's check-in and check-out times. */
  rules: Pick<PublicQuoteGuestDisclosure["choices"], "checkInTime" | "checkOutTime"> | null;
  formatMoney: (minor: string, currency: string) => string;
  /** The ways the hotel offers for these rooms, as one line (the group rooms step). */
  methods?: readonly PricingPaymentMethod[];
  /** The price's payment lines ("Pay now", "At the hotel"). */
  box?: readonly { label: string; value: string }[];
  expired?: boolean;
  /** Each chosen extra as its own line (VAY-2416); otherwise one "Extras" line. */
  extras?: readonly SummaryExtra[];
  /** Shown in the total's place without a price ("Checking price…"). */
  pending?: ReactNode;
  /** VAY-2393: Change goes back to the room cards with that room open. */
  onChangeRoom?: (index: number) => void;
  /** VAY-2393: with two or more rooms; `byKeyboard` moves focus to Undo. */
  onRemoveRoom?: ((index: number, byKeyboard: boolean) => void) | null;
  /** A booking attempt is open: the rooms can't change until it settles. */
  locked?: boolean;
  /** The step's button with what it says about it (VAY-2416). */
  action?: ReactNode;
}) {
  const t = useTranslations("reviewPay");
  const tRooms = useTranslations("extrasRooms");
  const tHome = useTranslations("home");
  const tAddons = useTranslations("addons");
  const locale = useLocale();
  const timeLeft = useTimeLeft(quote?.expiresAt);
  const currency = quote?.currency ?? "";
  const money = (minor: bigint | string) => formatMoney(String(minor), currency);
  const day = (date: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        })
      : date;
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);
  const lines = quote?.lines ?? [];
  const extraLines = lines.filter((line) => line.kind === "addon");
  const charges = lines.filter((line) => line.kind === "charge");
  // Every quote has a promo-code discount line, "0" without a code: show only a real discount
  // (VAY-2388).
  const discount = sum(lines.filter((line) => line.kind === "discount"));
  // Each extra's price only when they add up to the quote's; one "Extras" line otherwise.
  const extrasPriced =
    !!extras?.length && extras.every((extra) => extra.needsDay || extra.price !== null);
  const single = rooms.length === 1 ? rooms[0] : undefined;
  const ranOut = !!quote && (expired || !timeLeft);
  // Bank transfer and PayPal confirm once the money arrives, so "instant" holds only without them.
  const instant =
    quote?.acceptanceMode === "instant" &&
    !isManualPricingPaymentMethod(quote.paymentMethod) &&
    !methods?.some(isManualPricingPaymentMethod);
  const ways = methods?.length
    ? t("stay.methods", {
        methods: new Intl.ListFormat(resolveLocale(locale), { type: "disjunction" }).format(
          methods.map((method) => t(`method.${method}.phrase`)),
        ),
      })
    : null;
  const checkout = action !== undefined;
  // Phones: the bar shows the total and the button; "Details" opens the rest above them.
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  // While the bar is fixed, other pinned things (the cookie prompt, a toast) sit above it, and the
  // page keeps a focused field clear of it (WCAG 2.4.11).
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = card.current;
    if (!checkout || !element || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty("--fixed-bottom-bar");
      root.style.removeProperty("scroll-padding-bottom");
    };
    const update = () => {
      if (getComputedStyle(element).position !== "fixed") return clear();
      root.style.setProperty("--fixed-bottom-bar", `${element.offsetHeight}px`);
      root.style.setProperty("scroll-padding-bottom", `${element.offsetHeight}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [checkout]);
  const change = (index: number) =>
    onChangeRoom && (
      <button
        type="button"
        className={`${link} text-gray-900`}
        aria-label={tRooms("changeRoom", { number: index + 1 })}
        disabled={locked}
        onClick={() => onChangeRoom(index)}
      >
        {tRooms("change")}
      </button>
    );
  const hidden = checkout && !open ? "max-lg:hidden" : "";
  return (
    <aside
      ref={card}
      aria-label={t("stay.title")}
      className={
        checkout
          ? "z-30 flex flex-col gap-[18px] bg-white max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:max-h-[85dvh] max-lg:gap-3 max-lg:overflow-y-auto max-lg:border-t max-lg:border-gray-200 max-lg:px-4 max-lg:pb-3 max-lg:pt-3 max-lg:shadow-[0_-6px_20px_rgba(17,24,39,0.06)] lg:sticky lg:top-5 lg:max-h-[calc(100dvh-40px)] lg:rounded-2xl lg:border lg:border-gray-200 lg:p-7"
          : "bg-white rounded-2xl border border-gray-200 p-5 md:p-7 lg:sticky lg:top-8 space-y-[18px]"
      }
    >
      <div
        id={detailsId}
        className={
          checkout
            ? `${hidden} min-h-0 space-y-[18px] overflow-y-auto max-lg:border-b max-lg:border-gray-200 max-lg:pb-3`
            : "space-y-[18px]"
        }
      >
        <div>
          {/* Focused after a room is removed or brought back, as its own button is gone. */}
          <h2
            id="stay-summary-title"
            tabIndex={-1}
            className="text-xl font-bold text-gray-900 outline-none"
          >
            {t("stay.title")}
          </h2>
          {single && (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="mt-1 text-base font-semibold text-gray-900">{single.name}</p>
                <p className="text-sm text-gray-600">
                  {[single.choice, guests].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="mt-1 shrink-0">{change(0)}</span>
            </div>
          )}
          {!single && <p className="mt-1 text-sm text-gray-600">{guests}</p>}
        </div>
        <div className="flex gap-4 border-y border-gray-200 py-[18px]">
          {[
            [
              t("stay.checkIn"),
              checkIn,
              rules?.checkInTime && t("stay.from", { time: rules.checkInTime }),
            ],
            [
              t("stay.checkOut"),
              checkOut,
              rules?.checkOutTime && t("stay.by", { time: rules.checkOutTime }),
            ],
          ].map(([label, date, time]) => (
            <div key={label as string} className="flex-1">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-500">{label}</p>
              <p className="text-base font-bold text-gray-900">{day(date as string)}</p>
              {time && <p className="text-sm text-gray-600">{time}</p>}
            </div>
          ))}
        </div>
        <div className="space-y-3">
          {rooms.map((room, index) => {
            const amount = quote
              ? money(
                  sum(
                    lines.filter(
                      (line) =>
                        line.selectionId === room.selectionId &&
                        (line.kind === "room" || line.kind === "meal"),
                    ),
                  ),
                )
              : "";
            return single ? (
              <Row
                key={room.selectionId}
                label={Number.isFinite(nights) ? t("stay.nights", { count: nights }) : ""}
                value={amount}
              />
            ) : (
              <div key={room.selectionId} data-testid={`stay-room-${index + 1}`}>
                <Row
                  label={`${t("stay.room", { number: String(index + 1) })} · ${room.name}`}
                  value={amount}
                  sub={[room.choice, room.guests].filter(Boolean).join(" · ")}
                />
                {(onChangeRoom || onRemoveRoom) && (
                  <div className="mt-1 flex gap-3">
                    {change(index)}
                    {onRemoveRoom && (
                      <button
                        type="button"
                        className={`${link} text-red-700`}
                        aria-label={tHome("roomsProgress.remove", { number: index + 1 })}
                        disabled={locked}
                        onClick={(event) => onRemoveRoom(index, event.detail === 0)}
                      >
                        {tRooms("remove")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {extras?.map((extra) => (
            <Row
              key={extra.id}
              label={extra.name}
              value={
                extra.needsDay ? (
                  <span className="text-sm font-semibold text-amber-700">
                    {tAddons("chooseADayShort")}
                  </span>
                ) : extrasPriced ? (
                  extra.price
                ) : (
                  ""
                )
              }
            />
          ))}
          {extraLines.length > 0 && !extrasPriced && (
            <Row label={t("stay.extras")} value={money(sum(extraLines))} />
          )}
          {charges.length > 0 && <Row label={t("stay.fees")} value={money(sum(charges))} />}
          {discount > BigInt(0) && <Row label={t("stay.discount")} value={`−${money(discount)}`} />}
        </div>
      </div>
      <div className={`shrink-0 space-y-[18px] ${checkout ? "max-lg:space-y-3" : ""}`}>
        <div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-[17px] font-bold text-gray-900">{t("stay.total")}</span>
            <span
              role={checkout ? "status" : undefined}
              aria-label={checkout ? tAddons("stayTotalLabel") : undefined}
              data-testid="stay-total"
              className={
                !quote
                  ? "text-right text-sm text-gray-600"
                  : `text-[26px] font-bold ${checkout ? "max-lg:text-[22px]" : ""} ${ranOut ? "text-gray-400 line-through" : "text-gray-900"}`
              }
            >
              {quote ? money(quote.totalMinor) : pending}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            {checkout && (
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-semibold text-gray-900 lg:hidden"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen((value) => !value)}
              >
                {t("stay.details")}
                {icon(open ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7", "")}
              </button>
            )}
            {quote && (
              <p className="ml-auto text-right text-[13px] text-gray-500">{t("stay.includes")}</p>
            )}
          </div>
        </div>
        {((!!box?.length && quote && !ranOut) || ways) && (
          <div
            className={`space-y-2.5 rounded-xl bg-gray-50 px-4 py-3.5 text-sm ${checkout ? "max-lg:space-y-1 max-lg:py-2" : ""}`}
          >
            {box?.length && quote && !ranOut
              ? box.map((line) => (
                  <div key={line.label} className="flex justify-between gap-4">
                    <span className="text-gray-600">{line.label}</span>
                    <span className="font-bold text-gray-900 text-right">{line.value}</span>
                  </div>
                ))
              : [ways, instant && t("stay.instant")].filter(Boolean).map((line) => (
                  <p key={line as string} className="flex items-center gap-2 text-gray-700">
                    {icon("M5 13l4 4L19 7", "text-green-700")}
                    {line}
                  </p>
                ))}
          </div>
        )}
        {action}
        {quote && (
          <p
            className={`${hidden} flex items-center gap-2 text-sm ${ranOut ? "font-medium text-amber-700" : "text-gray-600"}`}
          >
            {icon("M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z", "")}
            {ranOut ? t("stay.expired") : t("stay.hold", { time: timeLeft! })}
          </p>
        )}
      </div>
    </aside>
  );
}
