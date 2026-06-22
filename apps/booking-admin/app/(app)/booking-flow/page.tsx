"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  GlobeAltIcon,
  HomeIcon,
  SparklesIcon,
  TicketIcon,
  CheckBadgeIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";
import {
  settingsService,
  type AddonItem,
  type AddonSettings,
  type PromoCodeItem,
} from "@/services/settings";
import {
  getBookingAddonSettings,
  updateBookingAddonSettings,
} from "@/services/api/bookingAddonSettingsClient";
import {
  getBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "@/services/api/bookingBenefitsSettingsClient";
import {
  getBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import {
  getBookingLocalizationSettings,
  type BookingLocalizationSettings,
} from "@/services/api/bookingLocalizationSettingsClient";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "@/services/api/bookingRoomFilterSettingsClient";
import {
  loadBookingFlowSetting,
  normalizeBookingBenefitsSettings,
  normalizeBookingRoomFilterSettings,
} from "@/services/api/bookingFlowSettingsLoader";
import { apiClient } from "@/services/api/client";
import { FeedbackAlert } from "@/components/ui";
import { SettingsLayout, type SettingsNavSection } from "@/components/settings/layout";

import RoomsTab from "@/components/booking-flow/RoomsTab";
import AddonsTab from "@/components/booking-flow/AddonsTab";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import PromoCodesTab from "@/components/booking-flow/PromoCodesTab";
import LocalizationTab from "@/components/booking-flow/LocalizationTab";
import GuestFormTab from "@/components/booking-flow/GuestFormTab";
import {
  useBenefitsSettingsTab,
  useGuestFormSettingsTab,
  useLocalizationSettingsTab,
} from "@/components/booking-flow/useBookingFlowSettingsTabs";

type Tab =
  | "rooms"
  | "addons"
  | "benefits"
  | "promo-codes"
  | "localization"
  | "guest-form"
  | "last-minute";

type PmsRoomsResponse = {
  items?: {
    roomId: string;
    roomNumber: string;
  }[];
};

const DEFAULT_ADDON_SETTINGS: AddonSettings = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const DEFAULT_GUEST_FORM_SETTINGS: BookingGuestFormSettings = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
};

const DEFAULT_BENEFITS_SETTINGS: BookingBenefitsSettings = {
  benefits: [],
};

const DEFAULT_LOCALIZATION_SETTINGS: BookingLocalizationSettings = {
  defaultCurrency: "EUR",
  defaultLanguage: "en",
  supportedCurrencies: [],
  supportedLanguages: [],
};

const DEFAULT_ROOM_FILTER_SETTINGS: BookingRoomFilterSettings = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

const ADDON_ITEM_MANAGEMENT_UNAVAILABLE =
  "Add-on item management is not available on next-api yet. Display settings still save.";
const PROMO_CODE_MANAGEMENT_UNAVAILABLE = "Promo-code management is not available on next-api yet.";
const LAST_MINUTE_SETTINGS_UNAVAILABLE =
  "Last-minute discount settings are not available on next-api yet.";

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
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Add-on catalog CRUD awaits target API contracts; display settings still save.
  const addons: AddonItem[] = [];
  const [addonSettings, setAddonSettings] = useState<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsRef = useRef<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsWriteSeqRef = useRef(0);
  const addonSettingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // Promo-code CRUD awaits target API contracts.
  const promoCodes: PromoCodeItem[] = [];

  // Rooms state (filters)
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);

  const { t } = useTranslation();

  const showFeedback = (type: "success" | "error", message: string) => {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  };

  const getBookingHotelIdForSave = () => {
    const hotelId = bookingHotelId || getSelectedBookingHotelId();
    if (!hotelId) {
      throw new Error("Booking hotel id is required.");
    }
    return hotelId;
  };

  const {
    benefits,
    setBenefits,
    benefitInput,
    setBenefitInput,
    savingBenefits,
    handleSaveBenefits,
  } = useBenefitsSettingsTab({ getBookingHotelIdForSave, showFeedback });
  const {
    specialRequestsEnabled,
    setSpecialRequestsEnabled,
    arrivalTimeEnabled,
    setArrivalTimeEnabled,
    guestCountEnabled,
    setGuestCountEnabled,
    savingGuestForm,
    applyGuestFormSettings,
    handleSaveGuestForm,
  } = useGuestFormSettingsTab({ getBookingHotelIdForSave, showFeedback });
  const {
    defaultCurrency,
    setDefaultCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    savingCurrencyLang,
    applyLocalizationSettings,
    handleSaveCurrencyLang,
  } = useLocalizationSettingsTab({ getBookingHotelIdForSave, showFeedback });

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
    const addonSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingAddonSettings({ hotelId }),
      DEFAULT_ADDON_SETTINGS,
    );
    const guestFormSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingGuestFormSettings({ hotelId }),
      DEFAULT_GUEST_FORM_SETTINGS,
    );
    const benefitsSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingBenefitsSettings({ hotelId }),
      DEFAULT_BENEFITS_SETTINGS,
    );
    const localizationSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingLocalizationSettings({ hotelId }),
      DEFAULT_LOCALIZATION_SETTINGS,
    );
    const roomFilterSettingsPromise = loadTypedSetting(
      (hotelId) => getBookingRoomFilterSettings({ hotelId }),
      DEFAULT_ROOM_FILTER_SETTINGS,
    );

    Promise.all([
      addonSettingsPromise,
      benefitsSettingsPromise,
      guestFormSettingsPromise,
      localizationSettingsPromise,
      roomFilterSettingsPromise,
      propertyPromise,
    ])
      .then(
        ([
          settings,
          benefitsRes,
          guestFormSettings,
          localizationSettings,
          roomFilterSettings,
          property,
        ]) => {
          setBookingHotelId(selectedHotelId || property?.id || null);
          addonSettingsRef.current = settings;
          setAddonSettings(settings);
          setBenefits(
            normalizeBookingBenefitsSettings(benefitsRes, DEFAULT_BENEFITS_SETTINGS).benefits,
          );
          applyGuestFormSettings(guestFormSettings);
          applyLocalizationSettings(localizationSettings);
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
        },
      )
      .finally(() => setLoading(false));
  }, [applyGuestFormSettings, applyLocalizationSettings, setBenefits]);

  const handleToggleAddonSetting = async (key: keyof AddonSettings) => {
    const previous = addonSettingsRef.current;
    const newValue = !previous[key];
    const updated = { ...previous, [key]: newValue };
    const writeSeq = ++addonSettingsWriteSeqRef.current;
    addonSettingsRef.current = updated;
    setAddonSettings(updated);

    const savePromise = addonSettingsSaveChainRef.current.then(() =>
      updateBookingAddonSettings({
        hotelId: getBookingHotelIdForSave(),
        body: updated,
      }),
    );
    addonSettingsSaveChainRef.current = savePromise.catch(() => undefined);

    try {
      const saved = await savePromise;
      if (writeSeq === addonSettingsWriteSeqRef.current) {
        addonSettingsRef.current = saved;
        setAddonSettings(saved);
      }
    } catch {
      if (writeSeq === addonSettingsWriteSeqRef.current) {
        addonSettingsRef.current = previous;
        setAddonSettings(previous);
        showFeedback("error", t("bookingFlow.addons.feedback.settingError"));
      }
    }
  };

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
    { id: "addons", label: t("bookingFlow.tabs.addons"), icon: SparklesIcon },
    { id: "promo-codes", label: t("bookingFlow.tabs.promos"), icon: TicketIcon },
    { id: "benefits", label: t("bookingFlow.tabs.benefits"), icon: CheckBadgeIcon },
    {
      id: "localization",
      label: t("bookingFlow.tabs.localization"),
      icon: GlobeAltIcon,
    },
    {
      id: "guest-form",
      label: t("bookingFlow.tabs.guestForm"),
      icon: ClipboardDocumentListIcon,
    },
    { id: "last-minute", label: "Last-Minute", icon: ClockIcon },
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

        {activeTab === "addons" && (
          <AddonsTab
            addons={addons}
            addonSettings={addonSettings}
            propertyCurrency={defaultCurrency}
            itemManagementUnavailable={ADDON_ITEM_MANAGEMENT_UNAVAILABLE}
            handleToggleAddonSetting={handleToggleAddonSetting}
          />
        )}

        {activeTab === "promo-codes" && (
          <PromoCodesTab
            promoCodes={promoCodes}
            managementUnavailable={PROMO_CODE_MANAGEMENT_UNAVAILABLE}
          />
        )}

        {activeTab === "benefits" && (
          <BenefitsTab
            benefits={benefits}
            setBenefits={setBenefits}
            benefitInput={benefitInput}
            setBenefitInput={setBenefitInput}
            saveBenefits={handleSaveBenefits}
            savingBenefits={savingBenefits}
          />
        )}

        {activeTab === "localization" && (
          <LocalizationTab
            defaultCurrency={defaultCurrency}
            setDefaultCurrency={setDefaultCurrency}
            defaultLanguage={defaultLanguage}
            setDefaultLanguage={setDefaultLanguage}
            supportedCurrencies={supportedCurrencies}
            setSupportedCurrencies={setSupportedCurrencies}
            supportedLanguages={supportedLanguages}
            setSupportedLanguages={setSupportedLanguages}
            onSave={handleSaveCurrencyLang}
            saving={savingCurrencyLang}
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
            onSave={handleSaveGuestForm}
            saving={savingGuestForm}
          />
        )}

        {activeTab === "last-minute" && (
          <div className="max-w-2xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            {LAST_MINUTE_SETTINGS_UNAVAILABLE}
          </div>
        )}
      </div>
    </SettingsLayout>
  );
}
