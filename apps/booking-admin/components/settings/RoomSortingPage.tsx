"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsUpDownIcon, CheckIcon, EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useTranslation } from "@/lib/i18n";
import {
  moveOption,
  setDefault,
  shownOptions,
  toggleOption,
  type RoomSortKey,
  type RoomSorting,
} from "@/lib/utils/roomSorting";
import {
  bookingRoomSortingClient,
  type RoomSortingSummary,
} from "@/services/api/bookingRoomSortingClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { ApiErrorResponse } from "@/services/api/client";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Settings › Room Sorting (VAY-2449): whether guests can sort the rooms, whether the menu hides for a single
 * room, the options in the menu's order (drag, or the arrow keys on a handle), which are shown, and the
 * default; with a preview of what guests see. Saved through next-api; guests read it live. */
export function RoomSortingPage({
  client = bookingRoomSortingClient,
}: {
  client?: typeof bookingRoomSortingClient;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "failed" | "noAccess" | "ready">("loading");
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [summary, setSummary] = useState<RoomSortingSummary | null>(null);
  const [sorting, setSorting] = useState<RoomSorting | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const [dragging, setDragging] = useState<RoomSortKey | null>(null);
  // The latest load wins: an older hotel's answer must never land on the form a Save writes from.
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => version === loadVersion.current;
    setState("loading");
    try {
      const hotelId = getSelectedBookingHotelId();
      if (!hotelId) throw new Error("No booking hotel selected");
      const { propertyId } = await getBookingHotelPropertyLink({ hotelId });
      const loaded = await client.load(propertyId);
      if (!current()) return;
      setPropertyId(propertyId);
      setSummary(loaded);
      setSorting(loaded.sorting);
      setState("ready");
    } catch (error) {
      if (!current()) return;
      // Members who may not manage booking settings get 403 from next-api.
      setState(error instanceof ApiErrorResponse && error.status === 403 ? "noAccess" : "failed");
    }
  }, [client]);

  useEffect(() => {
    void load();
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, load);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, load);
    };
  }, [load]);

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  };

  async function save() {
    if (!propertyId || !sorting || saving) return;
    setSaving(true);
    try {
      setSorting(await client.save(propertyId, sorting));
      showFeedback("success", t("settings.roomSorting.saved"));
    } catch {
      showFeedback("error", t("settings.roomSorting.saveError"));
    } finally {
      setSaving(false);
    }
  }

  // The handle keeps focus while the arrow keys move its option.
  const move = (key: RoomSortKey, to: number, focus = false) => {
    if (!sorting) return;
    setSorting(moveOption(sorting, key, to));
    if (focus)
      requestAnimationFrame(() => document.getElementById(`room-sort-handle-${key}`)?.focus());
  };

  const title = t("settings.cards.roomSorting.title");
  if (state !== "ready" || !sorting || !summary)
    return (
      <SettingsSubPage title={title}>
        <div className="mt-5">
          {state === "loading" ? (
            <div
              className="flex justify-center py-10"
              role="status"
              aria-label={t("common.loading")}
            >
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            </div>
          ) : (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-white p-5"
            >
              <p className="text-sm text-red-700">
                {t(
                  state === "noAccess"
                    ? "settings.roomSorting.noAccess"
                    : "settings.feedback.loadError",
                )}
              </p>
              {state === "failed" && (
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
                >
                  {t("auth.chooseProperty.retry")}
                </button>
              )}
            </div>
          )}
        </div>
      </SettingsSubPage>
    );

  const shown = shownOptions(sorting).length;
  return (
    <SettingsSubPage title={title} wide>
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-4" />
      )}
      <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section
          aria-label={title}
          className="min-w-0 rounded-2xl border border-gray-200 bg-white px-4 py-2 sm:px-6"
        >
          <ToggleSwitch
            enabled={sorting.enabled}
            onChange={() => setSorting({ ...sorting, enabled: !sorting.enabled })}
            label={title}
            description={t("settings.roomSorting.description")}
          />
          {!summary.canSave && (
            <p
              role="note"
              className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
            >
              {t("settings.roomSorting.setupFirst")}
            </p>
          )}
          {/* Dimmed and not editable while sorting is off; it comes back as it was. */}
          <fieldset
            disabled={!sorting.enabled}
            className={`space-y-6 pb-2 transition-opacity ${sorting.enabled ? "" : "opacity-50"}`}
          >
            <div className="rounded-xl border border-gray-200 px-4">
              <ToggleSwitch
                enabled={sorting.hideWithOneRoom}
                onChange={() =>
                  setSorting({ ...sorting, hideWithOneRoom: !sorting.hideWithOneRoom })
                }
                label={t("settings.roomSorting.hideWithOneRoom")}
                description={t("settings.roomSorting.hideWithOneRoomHint")}
                disabled={!sorting.enabled}
              />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-gray-900">
                {t("settings.roomSorting.optionsTitle")}
              </h2>
              <p className="text-[13px] text-gray-500">{t("settings.roomSorting.optionsHint")}</p>
              <p className="mt-1 text-[13px] font-medium text-gray-700" aria-live="polite">
                {t("settings.roomSorting.shownCount", { shown, total: sorting.options.length })}
              </p>
              <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-200">
                {sorting.options.map((option, index) => {
                  const name = t(`settings.roomSorting.option.${option.key}`);
                  const isDefault = option.key === sorting.defaultOption;
                  return (
                    <li
                      key={option.key}
                      data-testid={`room-sort-option-${option.key}`}
                      draggable={sorting.enabled}
                      onDragStart={() => setDragging(option.key)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => dragging && move(dragging, index)}
                      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap sm:px-4 ${
                        dragging === option.key ? "bg-gray-50" : ""
                      }`}
                    >
                      <button
                        type="button"
                        id={`room-sort-handle-${option.key}`}
                        aria-label={t("settings.roomSorting.move", { name })}
                        onKeyDown={(event) => {
                          const to =
                            event.key === "ArrowUp"
                              ? index - 1
                              : event.key === "ArrowDown"
                                ? index + 1
                                : null;
                          if (to === null) return;
                          event.preventDefault();
                          move(option.key, to, true);
                        }}
                        className="-m-1 flex h-11 w-8 shrink-0 cursor-grab items-center justify-center rounded text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      >
                        <EllipsisVerticalIcon className="h-5 w-5" aria-hidden="true" />
                      </button>
                      <input
                        type="checkbox"
                        id={`room-sort-${option.key}`}
                        checked={option.enabled}
                        // The last option shown stays shown.
                        disabled={option.enabled && shown === 1}
                        onChange={() => setSorting(toggleOption(sorting, option.key))}
                        className="h-5 w-5 shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <label htmlFor={`room-sort-${option.key}`} className="min-w-0 flex-1">
                        <span
                          className={`block text-[14px] font-medium ${option.enabled ? "text-gray-900" : "text-gray-500"}`}
                        >
                          {name}
                        </span>
                        <span className="block text-[13px] text-gray-500">
                          {t(`settings.roomSorting.optionHint.${option.key}`)}
                        </span>
                      </label>
                      {isDefault && (
                        <span className="shrink-0 rounded-full bg-primary-50 px-2.5 py-0.5 text-[12px] font-semibold text-primary-700">
                          {t("settings.roomSorting.defaultBadge")}
                        </span>
                      )}
                      <label className="ml-11 flex min-h-[44px] shrink-0 items-center gap-2 text-[13px] text-gray-700 sm:ml-0">
                        <input
                          type="radio"
                          name="room-sort-default"
                          checked={isDefault}
                          disabled={!option.enabled}
                          onChange={() => setSorting(setDefault(sorting, option.key))}
                          aria-label={t("settings.roomSorting.setDefaultFor", { name })}
                          className="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span aria-hidden="true">{t("settings.roomSorting.setDefault")}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-[13px] text-gray-500">{t("settings.roomSorting.note")}</p>
            </div>
          </fieldset>
          <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-gray-100 py-4">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !summary.canSave}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary-500 px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50"
            >
              {saving && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {t("settings.roomSorting.save")}
            </button>
            <button
              type="button"
              onClick={() => setSorting(structuredClone(summary.defaults))}
              className="text-[13px] font-medium text-gray-700 hover:text-gray-900"
            >
              {t("settings.roomSorting.reset")}
            </button>
          </div>
        </section>
        <SortPreview sorting={sorting} t={t} />
      </div>
    </SettingsSubPage>
  );
}

// Sample rooms for the preview (the design's), with a deal on two of them.
const SAMPLE = [
  { name: "Garden Villa", size: 79, guests: 8, price: 90, deal: 10 },
  { name: "Ocean Suite", size: 45, guests: 3, price: 140, deal: 0 },
  { name: "Deluxe Double", size: 28, guests: 2, price: 65, deal: 15 },
  { name: "Family Bungalow", size: 60, guests: 5, price: 110, deal: 0 },
];
const SAMPLE_ORDER: Record<
  RoomSortKey,
  (a: (typeof SAMPLE)[number], b: (typeof SAMPLE)[number]) => number
> = {
  recommended: () => 0,
  priceLow: (a, b) => a.price - b.price,
  priceHigh: (a, b) => b.price - a.price,
  roomSize: (a, b) => b.size - a.size,
  capacity: (a, b) => b.guests - a.guests,
  bestDeal: (a, b) => b.deal - a.deal,
};

/** What guests see on step 1 · Rooms with these settings: the menu as it opens (the default ticked) and
 * sample rooms in the default's order; with one room, the menu only while the hotel keeps it. */
function SortPreview({ sorting, t }: { sorting: RoomSorting; t: Translate }) {
  const [rooms, setRooms] = useState<"several" | "one">("several");
  const options = shownOptions(sorting);
  const menu =
    sorting.enabled && options.length >= 2 && !(rooms === "one" && sorting.hideWithOneRoom);
  const order = sorting.enabled ? sorting.defaultOption : "recommended";
  const sample = rooms === "one" ? SAMPLE.slice(0, 1) : [...SAMPLE].sort(SAMPLE_ORDER[order]);
  return (
    <aside
      aria-label={t("settings.roomSorting.preview.title")}
      data-testid="room-sorting-preview"
      className="rounded-2xl border border-gray-200 bg-white p-5 lg:sticky lg:top-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-gray-900">
            {t("settings.roomSorting.preview.title")}
          </h2>
          <p className="text-[13px] text-gray-500">
            {t("settings.roomSorting.preview.description")}
          </p>
        </div>
        <div className="inline-flex rounded-lg bg-gray-100 p-1">
          {(["several", "one"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={rooms === value}
              onClick={() => setRooms(value)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
                rooms === value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
              }`}
            >
              {t(
                value === "one"
                  ? "settings.roomSorting.preview.oneRoom"
                  : "settings.roomSorting.preview.severalRooms",
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 rounded-xl bg-gray-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[16px] font-semibold text-gray-900">
            {t("settings.roomSorting.preview.heading")}
          </p>
          {menu && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-800">
              <ArrowsUpDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t(`settings.roomSorting.option.${order}`)}
            </span>
          )}
        </div>
        {menu ? (
          <ul
            data-testid="room-sorting-preview-menu"
            className="mt-3 rounded-lg bg-gray-900 p-1.5 text-[12px] text-white"
          >
            {options.map((option) => (
              <li
                key={option}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 ${option === order ? "bg-white/10" : ""}`}
              >
                <CheckIcon
                  className={`h-3.5 w-3.5 ${option === order ? "" : "invisible"}`}
                  aria-hidden="true"
                />
                {t(`settings.roomSorting.option.${option}`)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[12px] text-gray-500">
            {t("settings.roomSorting.preview.noMenu")}
          </p>
        )}
        <ul className="mt-3 space-y-2">
          {sample.map((room) => (
            <li key={room.name} className="flex items-center gap-3 rounded-lg bg-white p-2.5">
              <span className="h-9 w-11 shrink-0 rounded-md bg-gray-200" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-gray-900">{room.name}</p>
                <p className="text-[12px] text-gray-500">
                  {t("settings.roomSorting.preview.room", { size: room.size, guests: room.guests })}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[13px] font-semibold text-gray-900">US${room.price}</p>
                <p className="text-[11px] text-gray-500">
                  {room.deal
                    ? t("settings.roomSorting.preview.deal", { percent: room.deal })
                    : t("settings.roomSorting.preview.perNight")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
