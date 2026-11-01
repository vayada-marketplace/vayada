"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsUpDownIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisVerticalIcon,
} from "@heroicons/react/24/outline";
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
import { settingsService } from "@/services/settings";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Settings › Room Sorting (VAY-2449): whether guests can sort the rooms, whether the menu hides for a single
 * room, the options in the menu's order (drag a row's handle, or its Move up / Move down buttons), which are
 * shown, and the default; with a preview of what guests see. Saved through next-api; guests read it live. */
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
  // Said to screen readers after a move.
  const [announcement, setAnnouncement] = useState("");
  // The latest load wins: an older hotel's answer must never land on the form a Save writes from.
  const loadVersion = useRef(0);
  const loadingHotelId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const current = () => version === loadVersion.current;
    setState("loading");
    try {
      // As Room Filters: the header's hotel, else the signed-in member's property.
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      if (!current()) return;
      loadingHotelId.current = hotelId;
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
    // The header confirms or changes the hotel after the page starts loading: only another hotel reloads.
    const onHotelSelected = () => {
      if (getSelectedBookingHotelId() !== loadingHotelId.current) void load();
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    };
  }, [load]);

  async function save() {
    if (!propertyId || !sorting || !summary || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      setSorting(await client.save(propertyId, sorting));
      setFeedback({ type: "success", message: t("settings.roomSorting.saved") });
    } catch (error) {
      // The hotel has no booking settings yet (409): say so and stop offering Save.
      if (error instanceof ApiErrorResponse && error.status === 409)
        setSummary({ ...summary, canSave: false });
      setFeedback({ type: "error", message: t("settings.roomSorting.saveError") });
    } finally {
      setSaving(false);
    }
  }

  const move = (key: RoomSortKey, to: number) => {
    if (!sorting) return;
    const next = moveOption(sorting, key, to);
    if (next === sorting) return;
    setSorting(next);
    setAnnouncement(
      t("settings.roomSorting.moved", {
        name: t(`settings.roomSorting.option.${key}`),
        position: to + 1,
        total: next.options.length,
      }),
    );
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
  const locked = !sorting.enabled || saving;
  return (
    <SettingsSubPage title={title} wide>
      <div className="mt-5 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section
          aria-label={title}
          className="min-w-0 rounded-2xl border border-gray-200 bg-white px-4 py-2 sm:px-6"
        >
          <ToggleSwitch
            enabled={sorting.enabled}
            onChange={() => setSorting({ ...sorting, enabled: !sorting.enabled })}
            label={title}
            description={t("settings.roomSorting.description")}
            disabled={saving}
          />
          {!summary.canSave && (
            <p
              role="note"
              className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
            >
              {t("settings.roomSorting.setupFirst")}
            </p>
          )}
          {/* Dimmed and locked while sorting is off (it comes back as it was) and while saving. */}
          <fieldset
            disabled={locked}
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
                disabled={locked}
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
              <p className="sr-only" aria-live="polite">
                {announcement}
              </p>
              <ul className="mt-3 divide-y divide-gray-100 rounded-xl border border-gray-200">
                {sorting.options.map((option, index) => {
                  const name = t(`settings.roomSorting.option.${option.key}`);
                  const isDefault = option.key === sorting.defaultOption;
                  return (
                    <li
                      key={option.key}
                      data-testid={`room-sort-option-${option.key}`}
                      onDragOver={(event) => {
                        if (!dragging) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragging) move(dragging, index);
                        setDragging(null);
                      }}
                      className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-2 sm:flex-nowrap sm:px-3 ${
                        dragging === option.key ? "bg-gray-50" : ""
                      }`}
                    >
                      {/* The drag handle: a mouse drags the row by it; Move up / Move down do the same. */}
                      <span
                        aria-hidden="true"
                        draggable={!locked}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", option.key);
                          setDragging(option.key);
                        }}
                        onDragEnd={() => setDragging(null)}
                        data-testid={`room-sort-handle-${option.key}`}
                        className={`flex h-11 w-6 shrink-0 items-center justify-center text-gray-400 ${
                          locked ? "" : "cursor-grab hover:text-gray-600"
                        }`}
                      >
                        <EllipsisVerticalIcon className="h-5 w-5" />
                      </span>
                      <div className="flex shrink-0 flex-col">
                        {(
                          [
                            [-1, "settings.roomSorting.moveUp", ChevronUpIcon],
                            [1, "settings.roomSorting.moveDown", ChevronDownIcon],
                          ] as const
                        ).map(([step, label, Icon]) => (
                          <button
                            key={step}
                            type="button"
                            aria-label={t(label, { name })}
                            disabled={index + step < 0 || index + step >= sorting.options.length}
                            onClick={() => move(option.key, index + step)}
                            className="flex h-[22px] w-8 items-center justify-center rounded text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-30"
                          >
                            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                      <input
                        type="checkbox"
                        id={`room-sort-${option.key}`}
                        checked={option.enabled}
                        // The last option shown stays shown.
                        disabled={option.enabled && shown === 1}
                        onChange={() => setSorting(toggleOption(sorting, option.key))}
                        className="ml-1 h-5 w-5 shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      <label
                        htmlFor={`room-sort-${option.key}`}
                        className="min-w-0 flex-1 basis-40 py-1"
                      >
                        <span
                          data-testid="room-sort-name"
                          className={`block text-[14px] font-medium ${option.enabled ? "text-gray-900" : "text-gray-500"}`}
                        >
                          {name}
                        </span>
                        <span className="block text-[13px] text-gray-500">
                          {t(`settings.roomSorting.optionHint.${option.key}`)}
                        </span>
                      </label>
                      {/* On a phone the default sits on its own line below the name. */}
                      <div className="flex basis-full items-center justify-end gap-3 sm:basis-auto">
                        {isDefault && (
                          <span className="shrink-0 rounded-full bg-primary-50 px-2.5 py-0.5 text-[12px] font-semibold text-primary-700">
                            {t("settings.roomSorting.defaultBadge")}
                          </span>
                        )}
                        <label className="flex min-h-[44px] shrink-0 items-center gap-2 text-[13px] text-gray-700">
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
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-[13px] text-gray-500">{t("settings.roomSorting.note")}</p>
            </div>
          </fieldset>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-gray-100 py-4">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !summary.canSave}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-primary-500 px-4 text-[13px] font-medium text-white transition-colors hover:bg-primary-600 disabled:opacity-50 sm:min-h-[36px]"
            >
              {saving && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              {t("settings.roomSorting.save")}
            </button>
            <button
              type="button"
              onClick={() => setSorting(structuredClone(summary.defaults))}
              disabled={saving}
              className="min-h-[44px] px-1 text-[13px] font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50 sm:min-h-0"
            >
              {t("settings.roomSorting.reset")}
            </button>
            {/* Next to Save, where the guest's eyes are. */}
            <div role="status" className="basis-full empty:hidden">
              {feedback && <FeedbackAlert type={feedback.type} message={feedback.message} />}
            </div>
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
type SampleRoom = (typeof SAMPLE)[number];
const SAMPLE_ORDER: Record<RoomSortKey, (a: SampleRoom, b: SampleRoom) => number> = {
  recommended: () => 0,
  priceLow: (a, b) => a.price - b.price,
  priceHigh: (a, b) => b.price - a.price,
  roomSize: (a, b) => b.size - a.size,
  capacity: (a, b) => b.guests - a.guests,
  bestDeal: (a, b) => b.deal - a.deal,
};

/** What guests see on step 1 · Rooms with these settings: the menu as it opens (the default ticked) and
 * sample rooms in the order they get; with one room, the menu only while the hotel keeps it. */
function SortPreview({ sorting, t }: { sorting: RoomSorting; t: Translate }) {
  const [rooms, setRooms] = useState<"several" | "one">("several");
  const options = shownOptions(sorting);
  const order = sorting.enabled ? sorting.defaultOption : "recommended";
  const why = !sorting.enabled
    ? t("settings.roomSorting.preview.noMenu")
    : rooms === "one" && sorting.hideWithOneRoom
      ? t("settings.roomSorting.preview.noMenuOneRoom")
      : options.length < 2
        ? t("settings.roomSorting.preview.noMenuSorted", {
            option: t(`settings.roomSorting.option.${order}`),
          })
        : null;
  const sample = rooms === "one" ? SAMPLE.slice(0, 1) : [...SAMPLE].sort(SAMPLE_ORDER[order]);
  return (
    <aside
      aria-label={t("settings.roomSorting.preview.title")}
      data-testid="room-sorting-preview"
      className="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5 xl:sticky xl:top-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
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
              className={`min-h-[44px] rounded-md px-2.5 text-[12px] font-medium sm:min-h-[28px] ${
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
      <div className="mt-4 rounded-xl bg-gray-50 p-3 sm:p-4">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-[16px] font-semibold text-gray-900">
            {t("settings.roomSorting.preview.heading")}
          </p>
          {!why && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] font-medium text-gray-800">
              <ArrowsUpDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t(`settings.roomSorting.option.${order}`)}
            </span>
          )}
        </div>
        {why ? (
          <p className="mt-3 text-[12px] text-gray-500">{why}</p>
        ) : (
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
                  className={`h-3.5 w-3.5 shrink-0 ${option === order ? "" : "invisible"}`}
                  aria-hidden="true"
                />
                {t(`settings.roomSorting.option.${option}`)}
              </li>
            ))}
          </ul>
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
