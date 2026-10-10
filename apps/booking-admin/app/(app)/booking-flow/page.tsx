"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/lib/i18n";
import { HomeIcon, ClipboardDocumentListIcon } from "@heroicons/react/24/outline";
import { settingsService } from "@/services/settings";
import {
  getBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import { getBookingLocalizationSettings } from "@/services/api/bookingLocalizationSettingsClient";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "@/services/api/bookingRoomFilterSettingsClient";
import {
  loadBookingFlowSetting,
  normalizeBookingRoomFilterSettings,
} from "@/services/api/bookingFlowSettingsLoader";
import { apiClient } from "@/services/api/client";
import { FeedbackAlert } from "@/components/ui";
import { SettingsLayout, type SettingsNavSection } from "@vayada/settings-ui";

import RoomsTab from "@/components/booking-flow/RoomsTab";
import GuestFormTab from "@/components/booking-flow/GuestFormTab";
import { useGuestFormSettingsTab } from "@/components/booking-flow/useBookingFlowSettingsTabs";

type Tab = "rooms" | "guest-form" | "last-minute";

type PmsRoomsResponse = {
  items?: {
    roomId: string;
    roomNumber: string;
  }[];
};

const DEFAULT_GUEST_FORM_SETTINGS: BookingGuestFormSettings = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
  phoneRequired: true,
  adultAgeThreshold: 18,
  childrenEnabled: true,
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

function getSelectedBookingHotelId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("selectedHotelId");
}

export default function BookingFlowPage() {
  const [activeTab, setActiveTab] = useState<Tab>("rooms");
  const router = useRouter();
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    // Book Direct Benefits moved to Settings (VAY-2072) and Add-ons to its own page (VAY-2077).
    if (tab === "benefits") router.replace("/settings/book-direct-benefits");
    if (tab === "addons") router.replace("/add-ons");
    if (["rooms", "guest-form"].includes(tab ?? "")) setActiveTab(tab as Tab);
  }, [router]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Rooms state (filters)
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");

  const { t } = useTranslation();

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

  const {
    specialRequestsEnabled,
    setSpecialRequestsEnabled,
    arrivalTimeEnabled,
    setArrivalTimeEnabled,
    guestCountEnabled,
    setGuestCountEnabled,
    phoneRequired,
    setPhoneRequired,
    adultAgeThreshold,
    setAdultAgeThreshold,
    childrenEnabled,
    setChildrenEnabled,
    savingGuestForm,
    applyGuestFormSettings,
    handleSaveGuestForm,
  } = useGuestFormSettingsTab({ getBookingHotelIdForSave, showFeedback });
  useEffect(() => {
    const selectedHotelId = getSelectedBookingHotelId();
    const propertyPromise = settingsService.getPropertySettings().catch(() => null);
    const loadTypedSetting = <TSettings,>(
      read: (hotelId: string) => Promise<TSettings>,
      defaultValue: TSettings,
    ) =>
      loadBookingFlowSetting({
        selectedHotelId,
        propertyPromise,
        read,
        defaultValue,
      });
    const guestFormSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingGuestFormSettings({ hotelId }),
      DEFAULT_GUEST_FORM_SETTINGS,
    );
    const localizationSettingsPromise = loadTypedSetting(
      (hotelId) =>
        getBookingLocalizationSettings({ hotelId }).then((settings) => settings.defaultCurrency),
      "EUR",
    );
    const roomFilterSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingRoomFilterSettings({ hotelId }),
      DEFAULT_ROOM_FILTER_SETTINGS,
    );

    Promise.all([
      guestFormSettingsPromise,
      localizationSettingsPromise,
      roomFilterSettingsPromise,
      propertyPromise,
    ])
      .then(([guestFormSettings, localizationCurrency, roomFilterSettings, property]) => {
        setBookingHotelId(selectedHotelId || property?.id || null);
        applyGuestFormSettings(guestFormSettings);
        setDefaultCurrency(localizationCurrency);
        const normalizedRoomFilterSettings = normalizeBookingRoomFilterSettings(
          roomFilterSettings,
          DEFAULT_ROOM_FILTER_SETTINGS,
        );
        setBookingFilters(normalizedRoomFilterSettings.bookingFilters);
        setFiltersEnabled(normalizedRoomFilterSettings.bookingFilters.length > 0);
        setCustomFilters(normalizedRoomFilterSettings.customFilters);
        setFilterRooms(normalizedRoomFilterSettings.filterRooms);
        if (property?.id) {
          setPmsRoomsLoading(true);
          apiClient
            .get<PmsRoomsResponse>(`/api/pms/properties/${encodeURIComponent(property.id)}/rooms`)
            .then((response) =>
              setPmsRooms(
                (response.items ?? []).map((room) => ({
                  id: room.roomId,
                  name: room.roomNumber,
                })),
              ),
            )
            .catch(() => setPmsRooms([]))
            .finally(() => setPmsRoomsLoading(false));
        }
      })
      .finally(() => setLoading(false));
  }, [applyGuestFormSettings]);

  // ── Filter handlers (Rooms tab) ──

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

  const sections: SettingsNavSection[] = [
    { id: "rooms", label: t("bookingFlow.tabs.filters"), icon: HomeIcon },
    {
      id: "guest-form",
      label: t("bookingFlow.tabs.guestForm"),
      icon: ClipboardDocumentListIcon,
    },
  ];

  if (loading) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <SettingsLayout
      title={t("bookingFlow.title")}
      description={t("bookingFlow.subtitle")}
      sections={sections}
      activeId={activeTab}
      onSelect={(id) => setActiveTab(id as Tab)}
    >
      {/* Feedback banner */}
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mb-4" />
      )}

      <div>
        {activeTab === "rooms" && (
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

        {activeTab === "guest-form" && (
          <GuestFormTab
            specialRequestsEnabled={specialRequestsEnabled}
            setSpecialRequestsEnabled={setSpecialRequestsEnabled}
            arrivalTimeEnabled={arrivalTimeEnabled}
            setArrivalTimeEnabled={setArrivalTimeEnabled}
            guestCountEnabled={guestCountEnabled}
            setGuestCountEnabled={setGuestCountEnabled}
            phoneRequired={phoneRequired}
            setPhoneRequired={setPhoneRequired}
            adultAgeThreshold={adultAgeThreshold}
            setAdultAgeThreshold={setAdultAgeThreshold}
            childrenEnabled={childrenEnabled}
            setChildrenEnabled={setChildrenEnabled}
            onSave={handleSaveGuestForm}
            saving={savingGuestForm}
          />
        )}
      </div>
    </SettingsLayout>
  );
}
