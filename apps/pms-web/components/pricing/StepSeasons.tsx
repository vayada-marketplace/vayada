"use client";

import { useState } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import type { Translate } from "./pricingAmounts";
import { recurringTemplate } from "./recurringPricingInputs";
import { headlineMinor, money, yearPieces, type RoomPrice, type YearPiece } from "./stepPricing";
import { SeasonWindow } from "./SeasonWindow";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
const tones: Record<YearPiece["tone"] | "none", string> = {
  low: "bg-amber-100 font-semibold text-amber-800",
  high: "bg-amber-500 font-semibold text-amber-950",
  normal: "bg-gray-100 text-gray-500",
  none: "bg-gray-50 text-gray-400",
};
/** Days per month in the leap year 2000, so month labels line up with the bar's day-based widths. */
const monthDays = Array.from({ length: 12 }, (_, month) =>
  new Date(Date.UTC(2000, month + 1, 0)).getUTCDate(),
);
const dayText = (day: number, t: Translate) => {
  const date = new Date(Date.UTC(2000, 0, 1 + day));
  return `${date.getUTCDate()} ${t(`pricing.steps.monthShort.${date.getUTCMonth() + 1}`)}`;
};

/** Step 2: the main option's seasons as a year bar. Seasons open the season window; month prices and the normal price
 * fill the gaps (month prices are edited under More options). */
export function StepSeasons({
  room,
  offer,
  label,
  disabled,
  onChange,
  onPending,
}: {
  room: PricingConfiguration;
  offer: Offer;
  label: string;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  if (offer.price.kind !== "independent") return null;
  const seasons = offer.price.calendar.seasons;
  const price = (value: RoomPrice | null) =>
    !value
      ? ""
      : value.mode === "flat"
        ? money(value.amountMinor, room.currency)
        : t("pricing.steps.seasons.from", { amount: money(headlineMinor(value), room.currency) });
  const text = (piece: YearPiece) =>
    piece.source.kind === "season"
      ? `${seasons[piece.source.index].name} · ${price(piece.price)}`
      : piece.source.kind === "month"
        ? `${t(`pricing.steps.monthShort.${piece.source.month}`)} · ${price(piece.price)}`
        : piece.source.kind === "base"
          ? `${t("pricing.steps.seasons.normal")} · ${price(piece.price)}`
          : t("pricing.steps.seasons.noPrice");
  const open = (target: number | "new") => {
    if (disabled) return;
    setEditing(target);
    onPending(true);
  };
  const close = () => {
    setEditing(null);
    onPending(false);
  };
  return (
    <StepCard
      number={2}
      title={t("pricing.steps.seasons.title")}
      hint={t("pricing.steps.seasons.hint")}
    >
      <div className="space-y-2">
        <div aria-hidden="true" className="flex">
          {monthDays.map((days, month) => (
            <span
              key={month}
              style={{ flexGrow: days, flexBasis: 0 }}
              className="min-w-0 truncate text-[12px] leading-4 text-gray-400"
            >
              {/* Phones show the month's initial; the short name would collide. */}
              <span className="sm:hidden">
                {t(`pricing.steps.monthShort.${month + 1}`).slice(0, 1)}
              </span>
              <span className="hidden sm:inline">{t(`pricing.steps.monthShort.${month + 1}`)}</span>
            </span>
          ))}
        </div>
        <div className="flex h-10 gap-0.5 overflow-hidden rounded-[10px]">
          {yearPieces(offer).map((piece) => {
            const span = `${dayText(piece.start, t)} – ${dayText(piece.start + piece.days - 1, t)}`;
            const className = `flex min-w-0 items-center px-3 text-left text-[13px] leading-4 ${tones[piece.source.kind === "none" ? "none" : piece.tone]}`;
            const style = { flexGrow: piece.days, flexBasis: 0 };
            return piece.source.kind === "season" ? (
              <button
                key={piece.start}
                type="button"
                title={`${text(piece)} (${span})`}
                aria-label={t("pricing.steps.seasons.editAria", {
                  season: text(piece),
                  days: span,
                })}
                disabled={disabled}
                onClick={() => open((piece.source as { index: number }).index)}
                style={style}
                className={`${className} transition-[filter] hover:brightness-95 disabled:cursor-not-allowed`}
              >
                <span className="truncate">{text(piece)}</span>
              </button>
            ) : (
              <div
                key={piece.start}
                title={`${text(piece)} (${span})`}
                style={style}
                className={className}
              >
                <span className="truncate">{text(piece)}</span>
              </div>
            );
          })}
        </div>
        {/* On phones the bar is too narrow for its labels, so the seasons and month prices are listed too (the bar's
            buttons already carry the full names for screen readers). */}
        <ul aria-hidden="true" className="space-y-1 text-[13px] text-gray-600 sm:hidden">
          {yearPieces(offer)
            .filter((piece) => piece.source.kind === "season" || piece.source.kind === "month")
            .map((piece) => (
              <li key={piece.start}>
                {text(piece)} · {dayText(piece.start, t)} –{" "}
                {dayText(piece.start + piece.days - 1, t)}
              </li>
            ))}
        </ul>
      </div>
      {recurringTemplate(offer) ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => open("new")}
          className={ui.stepButton}
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" /> {t("pricing.steps.seasons.add")}
        </button>
      ) : (
        <p className={ui.stepHint}>{t("pricing.seasons.noTemplate")}</p>
      )}
      {editing !== null && (
        <SeasonWindow
          room={room}
          offer={offer}
          label={label}
          index={editing === "new" ? null : editing}
          disabled={disabled}
          onChange={(next) => {
            onChange(next);
            close();
          }}
          onClose={close}
        />
      )}
    </StepCard>
  );
}
