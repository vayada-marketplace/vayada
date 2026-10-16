"use client";
import { useTranslation } from "@/lib/i18n";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BoltIcon, PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import {
  getBookingLastMinuteSettings,
  updateBookingLastMinuteSettings,
  type BookingPromotion,
  type BookingLastMinuteSettings,
} from "@/services/api/bookingLastMinuteSettingsClient";
import type { PromoRoomType } from "./PromoCodesTab";
import PromotionForm, { names, fresh, promotionIcons, promotionTypeCopy } from "./PromotionForm";

type PromotionType = BookingPromotion["type"];
const types = Object.keys(names) as PromotionType[];
const MENU_WIDTH = 380;

function summary(p: BookingPromotion, t: ReturnType<typeof useTranslation>["t"], locale: string) {
  if (p.type === "LAST_MINUTE")
    return p.tiers.length
      ? p.tiers
          .map((tier) =>
            t("admin.minMaxDaysDiscount", {
              min: tier.daysBeforeMin,
              max: tier.daysBeforeMax ?? "∞",
              discount: tier.discountPercent,
            }),
          )
          .join("; ")
      : t("admin.checkInWithinDaysDays", { days: p.threshold });
  if (p.type === "EARLY_BIRD") return t("admin.bookDaysDaysAhead", { days: p.threshold });
  if (p.type === "EXTENDED_STAY") return t("admin.stayNightsNights", { nights: p.threshold });
  return p.weekdays
    .map((day) =>
      new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 0, 4 + day)),
      ),
    )
    .join(", ");
}

/** "+ New promotion" and its type menu. Types that already exist show "Added" (one per type). */
function NewPromotionMenu({
  added,
  disabled,
  onPick,
}: {
  added: PromotionType[];
  disabled: boolean;
  onPick: (type: PromotionType) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const toggle = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    // Hang the menu from the button's right edge when it fits, otherwise from its left edge.
    setAlignRight(!rect || rect.right - MENU_WIDTH >= 16);
    setOpen((current) => !current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") setOpen(false);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
      >
        <PlusIcon className="h-4 w-4" />
        {t("admin.newPromotion")}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("admin.newPromotion")}
          onKeyDown={onKeyDown}
          style={{ width: `min(${MENU_WIDTH}px, calc(100vw - 2rem))` }}
          className={`absolute top-full z-20 mt-2 rounded-xl border border-gray-200 bg-white p-1.5 shadow-lg ${alignRight ? "right-0" : "left-0"}`}
        >
          {types.map((type) => {
            const Icon = promotionIcons[type];
            const taken = added.includes(type);
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                disabled={taken}
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                  onPick(type);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-primary-50 focus:bg-primary-50 focus:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <Icon
                  className={`mt-0.5 h-5 w-5 shrink-0 ${taken ? "text-gray-300" : "text-primary-600"}`}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span
                      className={`text-sm font-semibold ${taken ? "text-gray-400" : "text-gray-900"}`}
                    >
                      {t(promotionTypeCopy[type].label)}
                    </span>
                    {taken && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                        {t("admin.added")}
                      </span>
                    )}
                  </span>
                  <span
                    className={`mt-0.5 block text-[13px] ${taken ? "text-gray-400" : "text-gray-500"}`}
                  >
                    {t(promotionTypeCopy[type].description)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Promotions({
  hotelId,
  roomTypes,
}: {
  hotelId: string;
  roomTypes: PromoRoomType[];
}) {
  const { t, locale } = useTranslation();
  const [settings, setSettings] = useState<BookingLastMinuteSettings | null>(null);
  const [promotions, setPromotions] = useState<BookingPromotion[]>([]);
  const [draft, setDraft] = useState<BookingPromotion | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setSettings(null);
    getBookingLastMinuteSettings({ hotelId })
      .then((value) => {
        if (!current) return;
        setSettings(value);
        setPromotions(
          value.promotions ??
            (value.enabled && value.tiers.length
              ? [{ ...fresh("LAST_MINUTE"), tiers: value.tiers }]
              : []),
        );
      })
      .catch(() => {
        if (current) setError("admin.couldNotLoadPromotions");
      });
    return () => {
      current = false;
    };
  }, [hotelId]);

  async function save(next: BookingPromotion[]) {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await updateBookingLastMinuteSettings({
        hotelId,
        body: {
          enabled: settings.enabled,
          stackWithPromo: settings.stackWithPromo,
          tiers: settings.tiers,
          promotions: next,
        },
      });
      setSettings(saved);
      setPromotions(saved.promotions ?? next);
      setDraft(null);
    } catch {
      setError("admin.couldNotSavePromotions");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-10 border-t border-gray-200 pt-8">
      {/* Same title block as the page header above (VAY-2234). */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <h2 className="text-xl font-semibold text-gray-900 md:text-2xl">
            {t("admin.promotions")}
          </h2>
          <p className="mt-[var(--page-subtitle-gap)] text-[13px] text-gray-500">
            {t("admin.automaticRateRulesThatApplyWithoutACodeGuestsSee")}
          </p>
          <p className="text-[13px] text-gray-500">
            {t("admin.theHighestSingleDiscountAppliesPromotionsAndPromoCodesNever")}
          </p>
        </div>
        {promotions.length < types.length && (
          <NewPromotionMenu
            added={promotions.map((p) => p.type)}
            disabled={!settings || busy}
            onPick={(type) => {
              setEditing(false);
              setDraft(fresh(type));
            }}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {t(error)}
        </p>
      )}
      {!settings && !error && (
        <p className="mt-4 text-sm text-gray-500">{t("admin.loadingPromotions")}</p>
      )}
      {settings && promotions.length === 0 && !draft && (
        <div className="mt-[var(--page-header-gap)] rounded-xl border border-gray-200 bg-white px-6 py-14 text-center shadow-sm">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
            <BoltIcon className="h-6 w-6 text-gray-500" />
          </span>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">{t("admin.noPromotionsYet")}</h3>
          <p className="mt-1 text-sm text-gray-500">
            {t("admin.addOneToGiveGuestsAnAutomaticDiscount")}
          </p>
        </div>
      )}
      {promotions.length > 0 && (
        <div className="mt-[var(--page-header-gap)] grid gap-4 md:grid-cols-2">
          {promotions.map((p) => {
            const Icon = promotionIcons[p.type];
            const name = t(names[p.type]);
            return (
              <article
                key={p.type}
                className={`rounded-xl border border-gray-200 px-5 py-4 ${p.active ? "bg-white" : "bg-gray-50"}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
                    <Icon className="h-4 w-4" />
                  </span>
                  <h3 className={`font-semibold ${p.active ? "text-gray-900" : "text-gray-600"}`}>
                    {name}
                  </h3>
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${p.active ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}
                  >
                    {p.active ? t("promos.status.Active") : t("admin.paused")}
                  </span>
                </div>
                <div className="mt-3.5 flex flex-wrap gap-2 text-xs text-gray-700">
                  {[
                    p.freeNights
                      ? t("admin.freeNightsCount", { count: p.freeNights })
                      : p.tiers.length
                        ? t("admin.tieredPercentageOff")
                        : `${p.discountPercent}${t("bookingFlow.promoCodes.percentageOff")}`,
                    summary(p, t, locale),
                    p.roomTypeIds.length
                      ? p.roomTypeIds
                          .map(
                            (id) =>
                              roomTypes.find((r) => r.roomTypeId === id)?.name ??
                              t("admin.unavailableRoom"),
                          )
                          .join(", ")
                      : t("admin.allRooms"),
                  ].map((tag, index) => (
                    <span key={index} className="rounded-md bg-gray-100 px-2 py-1">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="mt-3.5 flex items-center justify-end gap-1 border-t border-gray-100 pt-3">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t("common.edit")} ${name}`}
                    onClick={() => {
                      setEditing(true);
                      setDraft(structuredClone(p));
                    }}
                    className="rounded-md p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
                  >
                    <PencilSquareIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t("admin.deleteName2", { name })}
                    onClick={() => {
                      if (window.confirm(t("admin.deleteName", { name })))
                        void save(promotions.filter((item) => item.type !== p.type));
                    }}
                    className="rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.active}
                    aria-label={t("admin.activateName", { name })}
                    disabled={busy}
                    onClick={() =>
                      void save(
                        promotions.map((item) =>
                          item.type === p.type ? { ...p, active: !p.active } : item,
                        ),
                      )
                    }
                    className={`relative ml-2 h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${p.active ? "bg-primary-600" : "bg-gray-300"}`}
                  >
                    <span
                      className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${p.active ? "translate-x-4" : "translate-x-0"}`}
                    />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {draft && (
        <PromotionForm
          key={`${editing}-${draft.type}`}
          initial={draft}
          editing={editing}
          promotions={promotions}
          roomTypes={roomTypes}
          busy={busy}
          save={save}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}
