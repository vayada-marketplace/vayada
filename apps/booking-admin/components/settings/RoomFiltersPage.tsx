"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RoomsTab from "@/components/booking-flow/RoomsTab";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "@/services/api/bookingRoomFilterSettingsClient";
import { normalizeBookingRoomFilterSettings } from "@/services/api/bookingFlowSettingsLoader";
import {
  getSelectedBookingHotelId,
  SELECTED_HOTEL_CHANGED_EVENT,
} from "@/services/api/bookingHotelScope";
import { apiClient } from "@/services/api/client";
import { settingsService } from "@/services/settings";

type PmsRoomsResponse = {
  items?: {
    roomId: string;
    roomNumber: string;
  }[];
};

const DEFAULT_ROOM_FILTER_SETTINGS: BookingRoomFilterSettings = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

function pickRecordByKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const allowedKeys = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowedKeys.has(key)));
}

/** Settings → Room Filters: which filters guests can use on the rooms list (VAY-2144, was Booking Flow → Filters). */
export function RoomFiltersPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  };

  const getBookingHotelIdForSave = () => {
    const hotelId = bookingHotelId || getSelectedBookingHotelId();
    if (!hotelId) {
      throw new Error(t("admin.bookingHotelIdIsRequired"));
    }
    return hotelId;
  };

  // The latest load wins: an older hotel's answer must never land on the form a Save writes from.
  const loadVersion = useRef(0);
  const loadingHotelId = useRef<string | null>(null);

  // A failed read must not show "filters off", which a Save would write over the real filters.
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const isCurrent = () => version === loadVersion.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      if (!isCurrent()) return;
      loadingHotelId.current = hotelId;
      const settings = normalizeBookingRoomFilterSettings(
        await getBookingRoomFilterSettings({ hotelId }),
        DEFAULT_ROOM_FILTER_SETTINGS,
      );
      if (!isCurrent()) return;
      setBookingHotelId(hotelId);
      setBookingFilters(settings.bookingFilters);
      setFiltersEnabled(settings.bookingFilters.length > 0);
      setCustomFilters(settings.customFilters);
      setFilterRooms(settings.filterRooms);
      setPmsRoomsLoading(true);
      apiClient
        .get<PmsRoomsResponse>(`/api/pms/properties/${encodeURIComponent(hotelId)}/rooms`)
        .then((response) => {
          if (!isCurrent()) return;
          setPmsRooms(
            (response.items ?? []).map((room) => ({
              id: room.roomId,
              name: room.roomNumber,
            })),
          );
        })
        .catch(() => {
          if (isCurrent()) setPmsRooms([]);
        })
        .finally(() => {
          if (isCurrent()) setPmsRoomsLoading(false);
        });
    } catch {
      if (isCurrent()) setLoadFailed(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The header confirms or changes the hotel after the page starts loading.
    const onHotelSelected = () => {
      if (getSelectedBookingHotelId() !== loadingHotelId.current) void load();
    };
    window.addEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener(SELECTED_HOTEL_CHANGED_EVENT, onHotelSelected);
    };
  }, [load]);

  const handleToggleFiltersEnabled = async () => {
    const newEnabled = !filtersEnabled;
    setFiltersEnabled(newEnabled);
    if (!newEnabled) {
      // Auto-save when disabling filters
      try {
        const saved = await updateBookingRoomFilterSettings({
          hotelId: getBookingHotelIdForSave(),
          body: {
            bookingFilters: [],
            customFilters: {},
            filterRooms: {},
          },
        });
        setBookingFilters(saved.bookingFilters);
        setCustomFilters(saved.customFilters);
        setFilterRooms(saved.filterRooms);
      } catch {
        setFiltersEnabled(true);
        setFeedback({ type: "error", message: t("bookingFlow.rooms.feedback.disableError") });
      }
    }
  };

  const handleSaveFilters = async () => {
    try {
      setSavingFilters(true);
      const filters = filtersEnabled ? bookingFilters : [];
      const rooms = filtersEnabled ? pickRecordByKeys(filterRooms, filters) : {};
      const nextCustomFilters = filtersEnabled ? pickRecordByKeys(customFilters, filters) : {};
      const saved = await updateBookingRoomFilterSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          bookingFilters: filters,
          customFilters: nextCustomFilters,
          filterRooms: rooms,
        },
      });
      setBookingFilters(saved.bookingFilters);
      setFiltersEnabled(saved.bookingFilters.length > 0);
      if (saved.bookingFilters.length > 0) {
        setCustomFilters(saved.customFilters);
      }
      setFilterRooms(saved.filterRooms);
      showFeedback("success", t("bookingFlow.rooms.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.rooms.feedback.saveError"));
    } finally {
      setSavingFilters(false);
    }
  };

  return (
    <SettingsSubPage title={t("settings.cards.roomFilters.title")}>
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-4" />
      )}
      <div className="mt-5">
        {loading ? (
          <div className="flex justify-center py-10" role="status" aria-label={t("common.loading")}>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          </div>
        ) : loadFailed ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-white p-5"
          >
            <p className="text-sm text-red-700">{t("settings.feedback.loadError")}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:border-gray-400"
            >
              {t("auth.chooseProperty.retry")}
            </button>
          </div>
        ) : (
          <RoomsTab
            bookingFilters={bookingFilters}
            setBookingFilters={setBookingFilters}
            customFilters={customFilters}
            setCustomFilters={setCustomFilters}
            filterRooms={filterRooms}
            setFilterRooms={setFilterRooms}
            filtersEnabled={filtersEnabled}
            onToggleFiltersEnabled={handleToggleFiltersEnabled}
            handleSaveFilters={handleSaveFilters}
            savingFilters={savingFilters}
            rooms={pmsRooms}
            roomsLoading={pmsRoomsLoading}
          />
        )}
      </div>
    </SettingsSubPage>
  );
}
