"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { AgencyFilterOptions, AgencyFilters as Filters } from "@/lib/agencyOverview";

const chip = (active: boolean) =>
  `inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-[15px] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
    active
      ? "border-primary-600 bg-primary-600 text-white"
      : "border-gray-300 bg-white text-gray-900 hover:border-gray-900"
  }`;

/**
 * The agency overview's filter chips (VAY-2460), on the row under the count: property type and
 * area as single choices ("All" first), a price box with a minimum and maximum per night, and
 * on/off chips for a private pool, breakfast and free cancellation. Only the chips in `options`.
 */
export default function AgencyFilters({
  options,
  filters,
  onChange,
  typeLabel,
  currency,
  formatPrice,
}: {
  options: AgencyFilterOptions;
  filters: Filters;
  onChange: (next: Filters) => void;
  typeLabel: (type: string) => string;
  /** The price box's currency: the guest's display currency. */
  currency: string;
  /** Whole units in `currency`. */
  formatPrice: (value: number) => string;
}) {
  const t = useTranslations("agency");
  const set = (change: Partial<Filters>) => onChange({ ...filters, ...change });
  const toggles = (["privatePool", "breakfast", "freeCancellation"] as const).filter(
    (key) => options[key],
  );
  if (!options.types.length && !options.areas.length && !options.price && !toggles.length)
    return null;

  return (
    // Positioned: on a phone the price box opens under the whole row.
    <div
      role="group"
      aria-label={t("filters")}
      className="relative flex flex-wrap items-center gap-2"
    >
      {options.types.length > 0 && (
        <Choices
          label={t("filterType")}
          all={t("filterAll")}
          values={options.types}
          chosen={filters.type}
          name={typeLabel}
          onChoose={(type) => set({ type })}
        />
      )}
      {options.areas.length > 0 && (
        <Choices
          label={t("filterArea")}
          all={t("filterAllAreas")}
          values={options.areas}
          chosen={filters.area}
          name={(area) => area}
          onChoose={(area) => set({ area })}
        />
      )}
      {options.price && (
        <PriceBox
          bounds={options.price}
          value={filters.price}
          onChange={(price) => set({ price })}
          currency={currency}
          format={formatPrice}
        />
      )}
      {toggles.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={filters[key]}
          onClick={() => set({ [key]: !filters[key] })}
          className={chip(filters[key])}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

function Choices({
  label,
  all,
  values,
  chosen,
  name,
  onChoose,
}: {
  label: string;
  all: string;
  values: string[];
  chosen: string | null;
  name: (value: string) => string;
  onChoose: (value: string | null) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {[null, ...values].map((value) => (
        <button
          key={value ?? ""}
          type="button"
          aria-pressed={chosen === value}
          onClick={() => onChoose(value)}
          className={chip(chosen === value)}
        >
          {value === null ? all : name(value)}
        </button>
      ))}
    </div>
  );
}

/** The price box's width from tablets up (`sm:w-80`). */
const BOX_WIDTH = 320;

/** "Price": a small box with the lowest and highest price per night the guest wants. Empty
 * fields show the stays' own lowest and highest; changes apply as they are typed. */
function PriceBox({
  bounds,
  value,
  onChange,
  currency,
  format,
}: {
  bounds: { min: number; max: number };
  value: Filters["price"];
  onChange: (price: Filters["price"]) => void;
  currency: string;
  format: (value: number) => string;
}) {
  const t = useTranslations("agency");
  const [open, setOpen] = useState(false);
  // Opened near the window's right edge, the box lines up with the chip's right side instead.
  const [alignEnd, setAlignEnd] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const active = value.min !== null || value.max !== null;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const label =
    value.min !== null && value.max !== null
      ? t("priceRange", { min: format(value.min), max: format(value.max) })
      : value.min !== null
        ? t("priceFrom", { min: format(value.min) })
        : value.max !== null
          ? t("priceUpTo", { max: format(value.max) })
          : t("filterPrice");
  const amount = (raw: string) => {
    const number = Math.floor(Number(raw));
    return raw.trim() === "" || !Number.isFinite(number) || number < 0 ? null : number;
  };
  const field = (key: "min" | "max") => (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px] text-gray-500">
      {t(key === "min" ? "priceMin" : "priceMax")}
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value[key] ?? ""}
        placeholder={String(bounds[key])}
        onChange={(event) => onChange({ ...value, [key]: amount(event.target.value) })}
        className="min-h-[44px] w-full rounded-xl border border-gray-200 px-3 text-[15px] text-gray-900 focus:border-gray-900 focus:outline-none"
      />
    </label>
  );

  return (
    <div ref={box} className="sm:relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          const chip = event.currentTarget.getBoundingClientRect();
          setAlignEnd(chip.left + BOX_WIDTH > window.innerWidth - 16);
          setOpen((shown) => !shown);
        }}
        className={chip(active)}
      >
        {label}
        <svg
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={id}
          role="group"
          aria-label={t("pricePerNight", { currency })}
          className={`absolute inset-x-0 top-full z-30 mt-2 rounded-2xl border border-gray-200 bg-white p-4 shadow-[0_8px_24px_rgba(0,0,0,0.12)] sm:inset-x-auto sm:w-80 ${
            alignEnd ? "sm:right-0" : "sm:left-0"
          }`}
        >
          <p className="text-[15px] font-semibold text-gray-900">
            {t("pricePerNight", { currency })}
          </p>
          <div className="mt-3 flex items-end gap-2">
            {field("min")}
            <span aria-hidden="true" className="pb-3 text-gray-500">
              –
            </span>
            {field("max")}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => onChange({ min: null, max: null })}
              disabled={!active}
              className="min-h-[44px] px-1 text-[15px] font-semibold text-gray-900 underline disabled:text-gray-300 disabled:no-underline"
            >
              {t("priceClear")}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-[44px] rounded-full bg-primary-600 px-5 text-[15px] font-semibold text-white hover:bg-primary-700"
            >
              {t("priceDone")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
