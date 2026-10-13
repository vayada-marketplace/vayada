"use client";

import { useState, type ReactNode } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";
import type { PricingConfiguration } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { recurringTemplate } from "./recurringPricingInputs";
import { headlineMinor, money, type RoomPrice } from "./stepPricing";
import { SeasonWindow } from "./SeasonWindow";
import { StepCard } from "./StepCard";
import * as ui from "./pricingStyles";

type Offer = PricingConfiguration["offers"][number];
const tones = { low: "bg-amber-300", high: "bg-amber-500", normal: "bg-gray-300" };

/** The card's "Busier dates": the main option's seasons as a list, each with its dates, price and Edit (the season
 * window), and "Add a season". `children` is the weekend row. Month prices are edited under More options. */
export function StepSeasons({
  room,
  offer,
  label,
  disabled,
  onChange,
  onPending,
  children,
}: {
  room: PricingConfiguration;
  offer: Offer;
  label: string;
  disabled: boolean;
  onChange: (room: PricingConfiguration) => void;
  onPending: (pending: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  if (offer.price.kind !== "independent") return null;
  const { seasons, base } = offer.price.calendar;
  const normal = base ? BigInt(headlineMinor(base)) : null;
  const price = (value: RoomPrice) =>
    value.mode === "flat"
      ? money(value.amountMinor, room.currency)
      : t("pricing.steps.seasons.from", { amount: money(headlineMinor(value), room.currency) });
  const tone = (value: RoomPrice) => {
    const figure = BigInt(headlineMinor(value));
    return normal === null || figure === normal ? "normal" : figure < normal ? "low" : "high";
  };
  const day = (monthDay: string) =>
    `${Number(monthDay.slice(3))} ${t(`pricing.steps.monthShort.${Number(monthDay.slice(0, 2))}`)}`;
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
      title={t("pricing.steps.seasons.title")}
      hint={t("pricing.steps.seasons.hint")}
      optional
    >
      {seasons.length > 0 && (
        <ul className="divide-y divide-gray-100 border-b border-gray-100">
          {seasons.map((season, index) => {
            const days = `${day(season.from)} – ${day(season.through)}`;
            return (
              <li key={index} className="flex min-h-12 items-center gap-3.5 py-2">
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${tones[tone(season.price)]}`}
                />
                <span className="w-32 min-w-0 truncate text-[15px] font-medium text-gray-900">
                  {season.name}
                </span>
                <span className="min-w-0 grow text-[14px] text-gray-500">{days}</span>
                <span className="text-[15px] font-semibold text-gray-900">
                  {price(season.price)}
                </span>
                <button
                  type="button"
                  aria-label={t("pricing.steps.seasons.editAria", {
                    season: `${season.name} · ${price(season.price)}`,
                    days,
                  })}
                  disabled={disabled}
                  onClick={() => open(index)}
                  className={`w-10 text-right ${ui.stepLink}`}
                >
                  {t("pricing.steps.options.edit")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {recurringTemplate(offer) ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => open("new")}
          className={`inline-flex items-center gap-1.5 ${ui.stepLink}`}
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" /> {t("pricing.steps.seasons.add")}
        </button>
      ) : (
        <p className={ui.stepHint}>{t("pricing.seasons.noTemplate")}</p>
      )}
      {children}
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
