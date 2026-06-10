"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  XMarkIcon,
  PhotoIcon,
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
  updateBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "@/services/api/bookingBenefitsSettingsClient";
import {
  getBookingGuestFormSettings,
  updateBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import {
  getBookingLocalizationSettings,
  updateBookingLocalizationSettings,
  type BookingLocalizationSettings,
} from "@/services/api/bookingLocalizationSettingsClient";
import {
  getBookingRoomFilterSettings,
  updateBookingRoomFilterSettings,
  type BookingRoomFilterSettings,
} from "@/services/api/bookingRoomFilterSettingsClient";
import { loadBookingFlowSetting } from "@/services/api/bookingFlowSettingsLoader";
import { pmsClient } from "@/services/api/pmsClient";
import { ToggleSwitch, FeedbackAlert, SaveButton, ConfirmDialog } from "@/components/ui";
import { uploadSingleImage } from "@/lib/utils/uploadImage";
import {
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@/lib/constants/options";
import type { CurrencyOption, LanguageOption } from "@/lib/constants/options";
import { SettingsLayout, type SettingsNavSection } from "@/components/settings/layout";

import RoomsTab from "@/components/booking-flow/RoomsTab";
import AddonsTab from "@/components/booking-flow/AddonsTab";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import PromoCodesTab from "@/components/booking-flow/PromoCodesTab";
import LastMinuteTab from "@/components/booking-flow/LastMinuteTab";

type Tab =
  | "rooms"
  | "addons"
  | "benefits"
  | "promo-codes"
  | "localization"
  | "guest-form"
  | "last-minute";

const CATEGORIES = [
  { value: "dining", label: "Dining" },
  { value: "experience", label: "Experience" },
  { value: "transport", label: "Transport" },
  { value: "wellness", label: "Wellness" },
  { value: "other", label: "Other" },
];

const emptyPromoCode = {
  code: "",
  discountType: "percentage" as "percentage" | "fixed",
  discountValue: 0,
  validFrom: "" as string | null,
  validUntil: "" as string | null,
  isActive: true,
  maxUses: null as number | null,
};

const emptyAddon = {
  name: "",
  description: "",
  price: 0,
  currency: "EUR",
  category: "experience",
  image: "",
  duration: "",
  perPerson: false,
  perNight: false,
  location: "",
  maxGuests: "",
  highlights: [] as string[],
  includedItems: [] as string[],
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

function normalizeBenefitsSettings(settings: unknown): BookingBenefitsSettings {
  if (!isRecord(settings) || !Array.isArray(settings.benefits)) {
    return DEFAULT_BENEFITS_SETTINGS;
  }

  return {
    benefits: settings.benefits.filter((benefit): benefit is string => typeof benefit === "string"),
  };
}

function normalizeRoomFilterSettings(settings: unknown): BookingRoomFilterSettings {
  if (!isRecord(settings)) return DEFAULT_ROOM_FILTER_SETTINGS;

  return {
    bookingFilters: Array.isArray(settings.bookingFilters)
      ? settings.bookingFilters.filter((key): key is string => typeof key === "string")
      : [],
    customFilters: toStringRecord(settings.customFilters),
    filterRooms: toStringArrayRecord(settings.filterRooms),
  };
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function toStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([key, roomIds]) => [
        key,
        roomIds.filter((roomId): roomId is string => typeof roomId === "string"),
      ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

  // Add-ons state
  const [addons, setAddons] = useState<AddonItem[]>([]);
  const [addonSettings, setAddonSettings] = useState<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const [showModal, setShowModal] = useState(false);
  const [editingAddon, setEditingAddon] = useState<AddonItem | null>(null);
  const [formData, setFormData] = useState(emptyAddon);
  const [savingAddon, setSavingAddon] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [highlightInput, setHighlightInput] = useState("");
  const [includedItemInput, setIncludedItemInput] = useState("");
  const addonSettingsRef = useRef<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsWriteSeqRef = useRef(0);
  const addonSettingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const addonFileInputRef = useRef<HTMLInputElement>(null);

  // Pending delete confirmation
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "addon" | "promo";
    id: string;
  } | null>(null);

  // Promo codes state
  const [promoCodes, setPromoCodes] = useState<PromoCodeItem[]>([]);
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState<PromoCodeItem | null>(null);
  const [promoFormData, setPromoFormData] = useState(emptyPromoCode);
  const [savingPromo, setSavingPromo] = useState(false);
  const [deletingPromoId, setDeletingPromoId] = useState<string | null>(null);

  // Benefits state
  const [benefits, setBenefits] = useState<string[]>([]);
  const [benefitInput, setBenefitInput] = useState("");
  const [savingBenefits, setSavingBenefits] = useState(false);

  // Rooms state (filters)
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [bookingFilters, setBookingFilters] = useState<string[]>([]);
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({});
  const [filtersEnabled, setFiltersEnabled] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([]);
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false);

  // Guest Information Form state
  const [specialRequestsEnabled, setSpecialRequestsEnabled] = useState(
    DEFAULT_GUEST_FORM_SETTINGS.specialRequestsEnabled,
  );
  const [arrivalTimeEnabled, setArrivalTimeEnabled] = useState(
    DEFAULT_GUEST_FORM_SETTINGS.arrivalTimeEnabled,
  );
  const [guestCountEnabled, setGuestCountEnabled] = useState(
    DEFAULT_GUEST_FORM_SETTINGS.guestCountEnabled,
  );
  const [savingGuestForm, setSavingGuestForm] = useState(false);

  const { t } = useTranslation();

  // Currency & Languages state
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([]);
  const [savingCurrencyLang, setSavingCurrencyLang] = useState(false);

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
      settingsService.listAddons().catch(() => []),
      addonSettingsPromise,
      benefitsSettingsPromise,
      guestFormSettingsPromise,
      localizationSettingsPromise,
      roomFilterSettingsPromise,
      propertyPromise,
      settingsService.listPromoCodes().catch(() => []),
    ])
      .then(
        ([
          addonList,
          settings,
          benefitsRes,
          guestFormSettings,
          localizationSettings,
          roomFilterSettings,
          property,
          promoList,
        ]) => {
          setBookingHotelId(selectedHotelId || property?.id || null);
          setAddons(addonList);
          addonSettingsRef.current = settings;
          setAddonSettings(settings);
          setPromoCodes(promoList);
          setBenefits(normalizeBenefitsSettings(benefitsRes).benefits);
          setSpecialRequestsEnabled(guestFormSettings.specialRequestsEnabled);
          setArrivalTimeEnabled(guestFormSettings.arrivalTimeEnabled);
          setGuestCountEnabled(guestFormSettings.guestCountEnabled);
          setDefaultCurrency(localizationSettings.defaultCurrency);
          setDefaultLanguage(localizationSettings.defaultLanguage);
          setSupportedCurrencies(localizationSettings.supportedCurrencies);
          setSupportedLanguages(localizationSettings.supportedLanguages);
          const normalizedRoomFilterSettings = normalizeRoomFilterSettings(roomFilterSettings);
          setBookingFilters(normalizedRoomFilterSettings.bookingFilters);
          setFiltersEnabled(normalizedRoomFilterSettings.bookingFilters.length > 0);
          setCustomFilters(normalizedRoomFilterSettings.customFilters);
          setFilterRooms(normalizedRoomFilterSettings.filterRooms);
          // Fetch rooms from PMS
          if (property?.slug) {
            setPmsRoomsLoading(true);
            pmsClient
              .get<{ id: string; name: string }[]>(`/api/hotels/${property.slug}/rooms`)
              .then((rooms) => setPmsRooms(rooms.map((r) => ({ id: r.id, name: r.name }))))
              .catch(() => setPmsRooms([]))
              .finally(() => setPmsRoomsLoading(false));
          }
        },
      )
      .finally(() => setLoading(false));
  }, []);

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

  // ── Add-on CRUD handlers ──

  const openCreateModal = () => {
    setEditingAddon(null);
    setFormData({
      ...emptyAddon,
      currency: defaultCurrency || "EUR",
      highlights: [],
      includedItems: [],
    });
    setHighlightInput("");
    setIncludedItemInput("");
    setShowModal(true);
  };

  const openEditModal = (addon: AddonItem) => {
    setEditingAddon(addon);
    setFormData({
      name: addon.name,
      description: addon.description,
      price: addon.price,
      currency: defaultCurrency || addon.currency,
      category: addon.category,
      image: addon.image,
      duration: addon.duration || "",
      perPerson: addon.perPerson || false,
      perNight: addon.perNight || false,
      location: addon.location || "",
      maxGuests: addon.maxGuests || "",
      highlights: addon.highlights || [],
      includedItems: addon.includedItems || [],
    });
    setHighlightInput("");
    setIncludedItemInput("");
    setShowModal(true);
  };

  const handleAddonImageUpload = async (file: File) => {
    const previousImage = formData.image;
    const previewUrl = URL.createObjectURL(file);
    setFormData((prev) => ({ ...prev, image: previewUrl }));

    try {
      setUploadingImage(true);
      const s3Url = await uploadSingleImage(file);
      URL.revokeObjectURL(previewUrl);
      setFormData((prev) => ({ ...prev, image: s3Url }));
    } catch (err) {
      console.error("Image upload failed:", err);
      URL.revokeObjectURL(previewUrl);
      setFormData((prev) => ({ ...prev, image: previousImage }));
      showFeedback("error", t("bookingFlow.addons.feedback.uploadError"));
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveAddon = async () => {
    if (!formData.name.trim()) return;
    try {
      setSavingAddon(true);
      const payload = {
        name: formData.name,
        description: formData.description,
        price: formData.price,
        currency: formData.currency,
        category: formData.category,
        image: formData.image.startsWith("blob:") ? "" : formData.image,
        duration: formData.duration || undefined,
        perPerson: formData.perPerson,
        perNight: formData.perNight,
        location: formData.location || undefined,
        maxGuests: formData.maxGuests || undefined,
        highlights: formData.highlights.length > 0 ? formData.highlights : undefined,
        includedItems: formData.includedItems.length > 0 ? formData.includedItems : undefined,
      };
      if (editingAddon) {
        const updated = await settingsService.updateAddon(editingAddon.id, payload);
        setAddons((prev) => prev.map((a) => (a.id === editingAddon.id ? updated : a)));
        showFeedback("success", t("bookingFlow.addons.feedback.updateSuccess"));
      } else {
        const created = await settingsService.createAddon(payload as Omit<AddonItem, "id">);
        setAddons((prev) => [...prev, created]);
        showFeedback("success", t("bookingFlow.addons.feedback.createSuccess"));
      }
      setShowModal(false);
    } catch {
      showFeedback("error", t("bookingFlow.addons.feedback.saveError"));
    } finally {
      setSavingAddon(false);
    }
  };

  const handleDeleteAddon = (id: string) => {
    setPendingDelete({ kind: "addon", id });
  };

  const confirmDeleteAddon = async (id: string) => {
    try {
      setDeletingId(id);
      await settingsService.deleteAddon(id);
      setAddons((prev) => prev.filter((a) => a.id !== id));
      showFeedback("success", t("bookingFlow.addons.feedback.deleteSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.addons.feedback.deleteError"));
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  };

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

  // ── Promo Code CRUD handlers ──

  const openCreatePromoModal = () => {
    setEditingPromo(null);
    setPromoFormData({ ...emptyPromoCode });
    setShowPromoModal(true);
  };

  const openEditPromoModal = (promo: PromoCodeItem) => {
    setEditingPromo(promo);
    setPromoFormData({
      code: promo.code,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      validFrom: promo.validFrom || "",
      validUntil: promo.validUntil || "",
      isActive: promo.isActive,
      maxUses: promo.maxUses ?? null,
    });
    setShowPromoModal(true);
  };

  const handleSavePromoCode = async () => {
    if (!promoFormData.code.trim()) return;
    try {
      setSavingPromo(true);
      const payload = {
        code: promoFormData.code.toUpperCase(),
        discountType: promoFormData.discountType,
        discountValue: promoFormData.discountValue,
        validFrom: promoFormData.validFrom || undefined,
        validUntil: promoFormData.validUntil || undefined,
        isActive: promoFormData.isActive,
        maxUses: promoFormData.maxUses,
      };
      if (editingPromo) {
        const updated = await settingsService.updatePromoCode(editingPromo.id, payload);
        setPromoCodes((prev) => prev.map((p) => (p.id === editingPromo.id ? updated : p)));
        showFeedback("success", t("bookingFlow.promoCodes.feedback.updateSuccess"));
      } else {
        const created = await settingsService.createPromoCode(payload as any);
        setPromoCodes((prev) => [created, ...prev]);
        showFeedback("success", t("bookingFlow.promoCodes.feedback.createSuccess"));
      }
      setShowPromoModal(false);
    } catch {
      showFeedback("error", t("bookingFlow.promoCodes.feedback.saveError"));
    } finally {
      setSavingPromo(false);
    }
  };

  const handleDeletePromoCode = (id: string) => {
    setPendingDelete({ kind: "promo", id });
  };

  const confirmDeletePromoCode = async (id: string) => {
    try {
      setDeletingPromoId(id);
      await settingsService.deletePromoCode(id);
      setPromoCodes((prev) => prev.filter((p) => p.id !== id));
      showFeedback("success", t("bookingFlow.promoCodes.feedback.deleteSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.promoCodes.feedback.deleteError"));
    } finally {
      setDeletingPromoId(null);
      setPendingDelete(null);
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

  // ── Benefits handlers ──

  const handleSaveBenefits = async () => {
    try {
      setSavingBenefits(true);
      // Auto-add pending custom benefit input before saving
      const trimmed = benefitInput.trim();
      let finalBenefits = benefits;
      if (trimmed && !benefits.includes(trimmed)) {
        finalBenefits = [...benefits, trimmed];
        setBenefits(finalBenefits);
        setBenefitInput("");
      }
      const saved = await updateBookingBenefitsSettings({
        hotelId: getBookingHotelIdForSave(),
        body: { benefits: finalBenefits },
      });
      setBenefits(saved.benefits);
      showFeedback("success", t("bookingFlow.benefits.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.benefits.feedback.saveError"));
    } finally {
      setSavingBenefits(false);
    }
  };

  // ── Guest Information Form handlers ──

  const handleSaveGuestForm = async () => {
    try {
      setSavingGuestForm(true);
      const guestFormData = {
        specialRequestsEnabled,
        arrivalTimeEnabled,
        guestCountEnabled,
      };
      const saved = await updateBookingGuestFormSettings({
        hotelId: getBookingHotelIdForSave(),
        body: guestFormData,
      });
      setSpecialRequestsEnabled(saved.specialRequestsEnabled);
      setArrivalTimeEnabled(saved.arrivalTimeEnabled);
      setGuestCountEnabled(saved.guestCountEnabled);
      showFeedback("success", t("bookingFlow.guestForm.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.guestForm.feedback.saveError"));
    } finally {
      setSavingGuestForm(false);
    }
  };

  // ── Currency & Language handlers ──

  const toggleCurrency = (code: string) => {
    setSupportedCurrencies((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const toggleLanguage = (code: string) => {
    setSupportedLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );
  };

  const handleSaveCurrencyLang = async () => {
    try {
      setSavingCurrencyLang(true);
      const saved = await updateBookingLocalizationSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          defaultCurrency,
          defaultLanguage,
          supportedCurrencies,
          supportedLanguages,
        },
      });
      setDefaultCurrency(saved.defaultCurrency);
      setDefaultLanguage(saved.defaultLanguage);
      setSupportedCurrencies(saved.supportedCurrencies);
      setSupportedLanguages(saved.supportedLanguages);
      showFeedback("success", t("bookingFlow.localization.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.localization.feedback.saveError"));
    } finally {
      setSavingCurrencyLang(false);
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
            deletingId={deletingId}
            propertyCurrency={defaultCurrency}
            openCreateModal={openCreateModal}
            openEditModal={openEditModal}
            handleDeleteAddon={handleDeleteAddon}
            handleToggleAddonSetting={handleToggleAddonSetting}
          />
        )}

        {activeTab === "promo-codes" && (
          <PromoCodesTab
            promoCodes={promoCodes}
            deletingId={deletingPromoId}
            openCreateModal={openCreatePromoModal}
            openEditModal={openEditPromoModal}
            handleDeletePromoCode={handleDeletePromoCode}
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
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 space-y-4">
            <div className="flex items-center gap-1.5">
              <GlobeAltIcon className="w-4 h-4 text-gray-700" />
              <h2 className="text-sm font-semibold text-gray-900">
                {t("bookingFlow.localization.title")}
              </h2>
            </div>

            {/* Default Currency & Language */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.localization.defaultCurrency")}{" "}
                  <span className="text-gray-700">*</span>
                </label>
                <FlagSelect<CurrencyOption>
                  value={defaultCurrency}
                  onChange={(code) => {
                    const oldDefault = defaultCurrency;
                    setDefaultCurrency(code);
                    setSupportedCurrencies((prev) => {
                      const without = prev.filter((c) => c !== code);
                      return oldDefault && !without.includes(oldDefault)
                        ? [...without, oldDefault]
                        : without;
                    });
                  }}
                  options={CURRENCY_OPTIONS}
                  getLabel={(o) => o.name}
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.localization.defaultLanguage")}{" "}
                  <span className="text-gray-700">*</span>
                </label>
                <FlagSelect<LanguageOption>
                  value={defaultLanguage}
                  onChange={(code) => {
                    const oldDefault = defaultLanguage;
                    setDefaultLanguage(code);
                    setSupportedLanguages((prev) => {
                      const without = prev.filter((l) => l !== code);
                      return oldDefault && !without.includes(oldDefault)
                        ? [...without, oldDefault]
                        : without;
                    });
                  }}
                  options={LANGUAGE_OPTIONS}
                  getLabel={(o) => o.name}
                />
              </div>
            </div>

            {/* Additional Currencies */}
            <div>
              <label className="block text-[13px] text-gray-700 mb-1">
                <span className="font-medium">
                  {t("bookingFlow.localization.additionalCurrencies")}
                </span>{" "}
                <span className="text-gray-400 font-normal text-[11px]">
                  {t("bookingFlow.localization.optional")}
                </span>
              </label>
              <SearchableMultiSelect<CurrencyOption>
                selected={supportedCurrencies}
                onToggle={toggleCurrency}
                options={CURRENCY_OPTIONS}
                excludeCode={defaultCurrency}
                placeholder={`Search currencies, e.g. "Swiss" or "CHF"...`}
                getLabel={(o) => o.code}
                getSearchLabel={(o) => `${o.name} \u00b7 ${o.code}`}
                popularCodes={POPULAR_CURRENCY_CODES}
                emptyMessage={`No additional currencies added \u2014 your booking page will show only ${defaultCurrency}`}
              />
            </div>

            {/* Additional Languages */}
            <div>
              <label className="block text-[13px] text-gray-700 mb-1">
                <span className="font-medium">
                  {t("bookingFlow.localization.additionalLanguages")}
                </span>{" "}
                <span className="text-gray-400 font-normal text-[11px]">
                  {t("bookingFlow.localization.optional")}
                </span>
              </label>
              <SearchableMultiSelect<LanguageOption>
                selected={supportedLanguages}
                onToggle={toggleLanguage}
                options={LANGUAGE_OPTIONS}
                excludeCode={defaultLanguage}
                placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
                getLabel={(o) => o.nativeName}
                getSearchLabel={(o) => `${o.name} \u00b7 ${o.nativeName}`}
                popularCodes={POPULAR_LANGUAGE_CODES}
                emptyMessage={`No additional languages added \u2014 your booking page will show only ${defaultLanguage.toUpperCase()}`}
              />
            </div>

            {/* Save button */}
            <div className="flex justify-end">
              <SaveButton onClick={handleSaveCurrencyLang} saving={savingCurrencyLang} />
            </div>
          </div>
        )}

        {activeTab === "guest-form" && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("bookingFlow.guestForm.title")}
            </h2>
            <p className="text-[12px] text-gray-500 mt-0.5 mb-3">
              {t("bookingFlow.guestForm.subtitle")}
            </p>
            <div className="space-y-2">
              <div
                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${specialRequestsEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
              >
                <div>
                  <span className="text-[13px] font-medium text-gray-900">
                    {t("bookingFlow.guestForm.specialRequests")}
                  </span>
                  <span className="ml-2 text-[10px] font-medium text-green-600">
                    {t("bookingFlow.guestForm.recommended")}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={t("bookingFlow.guestForm.specialRequests")}
                  aria-pressed={specialRequestsEnabled}
                  onClick={() => setSpecialRequestsEnabled(!specialRequestsEnabled)}
                  className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${specialRequestsEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${specialRequestsEnabled ? "left-4" : "left-0.5"}`}
                  />
                </button>
              </div>
              <div
                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${arrivalTimeEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
              >
                <span className="text-[13px] font-medium text-gray-900">
                  {t("bookingFlow.guestForm.estimatedArrivalTime")}
                </span>
                <button
                  type="button"
                  aria-label={t("bookingFlow.guestForm.estimatedArrivalTime")}
                  aria-pressed={arrivalTimeEnabled}
                  onClick={() => setArrivalTimeEnabled(!arrivalTimeEnabled)}
                  className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${arrivalTimeEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${arrivalTimeEnabled ? "left-4" : "left-0.5"}`}
                  />
                </button>
              </div>
              <div
                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${guestCountEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
              >
                <span className="text-[13px] font-medium text-gray-900">
                  {t("bookingFlow.guestForm.numberOfGuests")}
                </span>
                <button
                  type="button"
                  aria-label={t("bookingFlow.guestForm.numberOfGuests")}
                  aria-pressed={guestCountEnabled}
                  onClick={() => setGuestCountEnabled(!guestCountEnabled)}
                  className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${guestCountEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${guestCountEnabled ? "left-4" : "left-0.5"}`}
                  />
                </button>
              </div>
            </div>

            {/* Save button */}
            <div className="flex justify-end mt-4">
              <SaveButton onClick={handleSaveGuestForm} saving={savingGuestForm} />
            </div>
          </div>
        )}

        {activeTab === "last-minute" && <LastMinuteTab />}
      </div>

      {/* ADD/EDIT ADDON MODAL */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                {editingAddon
                  ? t("bookingFlow.addons.modal.editTitle")
                  : t("bookingFlow.addons.modal.createTitle")}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded-md"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Name */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.nameLabel")}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder={t("bookingFlow.addons.modal.namePlaceholder")}
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.descriptionLabel")}
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                  placeholder={t("bookingFlow.addons.modal.descriptionPlaceholder")}
                />
              </div>

              {/* Price (currency inherited from property settings) */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.priceLabel")}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.price || ""}
                    onChange={(e) =>
                      setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })
                    }
                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="px-2.5 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-[13px] font-medium text-gray-600 shrink-0">
                    {formData.currency}
                  </span>
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.categoryLabel")}
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Image */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.imageLabel")}
                </label>
                {formData.image ? (
                  <div className="relative rounded-lg overflow-hidden bg-gray-200">
                    <img
                      src={formData.image}
                      alt="Add-on"
                      className="w-full h-36 object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, image: "" })}
                      className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                    {uploadingImage && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => addonFileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith("image/")) handleAddonImageUpload(file);
                    }}
                    className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
                  >
                    {uploadingImage ? (
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <PhotoIcon className="w-6 h-6" />
                        <span className="text-[12px]">
                          {t("bookingFlow.addons.modal.clickOrDrag")}
                        </span>
                      </>
                    )}
                  </button>
                )}
                <input
                  ref={addonFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAddonImageUpload(file);
                    e.target.value = "";
                  }}
                  className="hidden"
                />
                {formData.image && !uploadingImage && (
                  <button
                    type="button"
                    onClick={() => addonFileInputRef.current?.click()}
                    className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {t("bookingFlow.addons.modal.replaceImage")}
                  </button>
                )}
              </div>

              {/* Duration */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.addons.modal.durationLabel")}
                </label>
                <input
                  type="text"
                  value={formData.duration}
                  onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder={t("bookingFlow.addons.modal.durationPlaceholder")}
                />
              </div>

              {/* Location */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Location
                </label>
                <input
                  type="text"
                  value={formData.location}
                  onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., Hotel Lobby, Gili Islands"
                />
              </div>

              {/* Max Guests */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Max Guests
                </label>
                <input
                  type="text"
                  value={formData.maxGuests}
                  onChange={(e) => setFormData({ ...formData, maxGuests: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., 2-4 guests"
                />
              </div>

              {/* Highlights */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Highlights (optional)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={highlightInput}
                    onChange={(e) => setHighlightInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const val = highlightInput.trim();
                        if (val && !formData.highlights.includes(val)) {
                          setFormData({ ...formData, highlights: [...formData.highlights, val] });
                          setHighlightInput("");
                        }
                      }
                    }}
                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder="e.g., PADI certification"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = highlightInput.trim();
                      if (val && !formData.highlights.includes(val)) {
                        setFormData({ ...formData, highlights: [...formData.highlights, val] });
                        setHighlightInput("");
                      }
                    }}
                    className="px-3 py-1.5 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Add
                  </button>
                </div>
                {formData.highlights.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {formData.highlights.map((item, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-[12px] text-gray-700 rounded-full"
                      >
                        {item}
                        <button
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              highlights: formData.highlights.filter((_, i) => i !== idx),
                            })
                          }
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <XMarkIcon className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* What's Included */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  What&apos;s Included (optional)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={includedItemInput}
                    onChange={(e) => setIncludedItemInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const val = includedItemInput.trim();
                        if (val && !formData.includedItems.includes(val)) {
                          setFormData({
                            ...formData,
                            includedItems: [...formData.includedItems, val],
                          });
                          setIncludedItemInput("");
                        }
                      }
                    }}
                    className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    placeholder="e.g., Equipment rental"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = includedItemInput.trim();
                      if (val && !formData.includedItems.includes(val)) {
                        setFormData({
                          ...formData,
                          includedItems: [...formData.includedItems, val],
                        });
                        setIncludedItemInput("");
                      }
                    }}
                    className="px-3 py-1.5 text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Add
                  </button>
                </div>
                {formData.includedItems.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {formData.includedItems.map((item, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-[12px] text-gray-700 rounded-full"
                      >
                        {item}
                        <button
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              includedItems: formData.includedItems.filter((_, i) => i !== idx),
                            })
                          }
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <XMarkIcon className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Per Person toggle */}
              <ToggleSwitch
                size="sm"
                enabled={formData.perPerson}
                onChange={() => setFormData({ ...formData, perPerson: !formData.perPerson })}
                label={t("bookingFlow.addons.modal.perPersonPricing")}
                description={t("bookingFlow.addons.modal.perPersonPricingDesc")}
              />

              {/* Per Night toggle */}
              <ToggleSwitch
                size="sm"
                enabled={formData.perNight}
                onChange={() => setFormData({ ...formData, perNight: !formData.perNight })}
                label={t("bookingFlow.addons.modal.perNightPricing")}
                description={t("bookingFlow.addons.modal.perNightPricingDesc")}
              />
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleSaveAddon}
                disabled={savingAddon || !formData.name.trim()}
                className="flex-1 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
              >
                {savingAddon && (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {editingAddon
                  ? t("bookingFlow.addons.modal.saveChanges")
                  : t("bookingFlow.addons.modal.createAddon")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ADD/EDIT PROMO CODE MODAL */}
      {showPromoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowPromoModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                {editingPromo
                  ? t("bookingFlow.promoCodes.modal.editTitle")
                  : t("bookingFlow.promoCodes.modal.createTitle")}
              </h3>
              <button
                onClick={() => setShowPromoModal(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded-md"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Code */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.promoCodes.modal.codeLabel")}
                </label>
                <input
                  type="text"
                  value={promoFormData.code}
                  onChange={(e) =>
                    setPromoFormData({ ...promoFormData, code: e.target.value.toUpperCase() })
                  }
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder={t("bookingFlow.promoCodes.modal.codePlaceholder")}
                />
              </div>

              {/* Discount Type + Value */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("bookingFlow.promoCodes.modal.discountTypeLabel")}
                  </label>
                  <select
                    value={promoFormData.discountType}
                    onChange={(e) =>
                      setPromoFormData({
                        ...promoFormData,
                        discountType: e.target.value as "percentage" | "fixed",
                      })
                    }
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                  >
                    <option value="percentage">
                      {t("bookingFlow.promoCodes.modal.percentage")}
                    </option>
                    <option value="fixed">{t("bookingFlow.promoCodes.modal.fixedAmount")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {promoFormData.discountType === "percentage"
                      ? t("bookingFlow.promoCodes.modal.discountPercent")
                      : t("bookingFlow.promoCodes.modal.discountAmount")}{" "}
                    *
                  </label>
                  <input
                    type="number"
                    min="0"
                    step={promoFormData.discountType === "percentage" ? "1" : "0.01"}
                    max={promoFormData.discountType === "percentage" ? "100" : undefined}
                    value={promoFormData.discountValue || ""}
                    onChange={(e) =>
                      setPromoFormData({
                        ...promoFormData,
                        discountValue: parseFloat(e.target.value) || 0,
                      })
                    }
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>

              {/* Validity Dates */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("bookingFlow.promoCodes.modal.validFromLabel")}
                  </label>
                  <input
                    type="date"
                    value={promoFormData.validFrom || ""}
                    onChange={(e) =>
                      setPromoFormData({ ...promoFormData, validFrom: e.target.value || null })
                    }
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    {t("bookingFlow.promoCodes.modal.validUntilLabel")}
                  </label>
                  <input
                    type="date"
                    value={promoFormData.validUntil || ""}
                    onChange={(e) =>
                      setPromoFormData({ ...promoFormData, validUntil: e.target.value || null })
                    }
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Max Uses */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  {t("bookingFlow.promoCodes.modal.maxUsesLabel")}
                </label>
                <input
                  type="number"
                  min="0"
                  value={promoFormData.maxUses ?? ""}
                  onChange={(e) =>
                    setPromoFormData({
                      ...promoFormData,
                      maxUses: e.target.value ? parseInt(e.target.value) : null,
                    })
                  }
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  placeholder={t("bookingFlow.promoCodes.modal.maxUsesPlaceholder")}
                />
              </div>

              {/* Active toggle */}
              <ToggleSwitch
                size="sm"
                enabled={promoFormData.isActive}
                onChange={() =>
                  setPromoFormData({ ...promoFormData, isActive: !promoFormData.isActive })
                }
                label={t("bookingFlow.promoCodes.modal.activeLabel")}
                description={t("bookingFlow.promoCodes.modal.activeDesc")}
              />
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button
                onClick={() => setShowPromoModal(false)}
                className="flex-1 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleSavePromoCode}
                disabled={savingPromo || !promoFormData.code.trim() || !promoFormData.discountValue}
                className="flex-1 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
              >
                {savingPromo && (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {editingPromo
                  ? t("bookingFlow.promoCodes.modal.saveChanges")
                  : t("bookingFlow.promoCodes.modal.createPromoCode")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION DIALOG */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("common.delete")}
        message={
          pendingDelete?.kind === "promo"
            ? t("bookingFlow.promoCodes.confirm.delete")
            : t("bookingFlow.addons.confirm.delete")
        }
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        loading={deletingId !== null || deletingPromoId !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === "addon") confirmDeleteAddon(pendingDelete.id);
          else confirmDeletePromoCode(pendingDelete.id);
        }}
      />
    </SettingsLayout>
  );
}

// ── Flag Select ──────────────────────────────────────────────────────
function FlagSelect<T extends { code: string; flag: string }>({
  value,
  onChange,
  options,
  getLabel,
}: {
  value: string;
  onChange: (code: string) => void;
  options: T[];
  getLabel: (opt: T) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = options.find((o) => o.code === value);
  const filtered = options.filter(
    (o) =>
      getLabel(o).toLowerCase().includes(search.toLowerCase()) ||
      o.code.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
        className="w-full flex items-center justify-between px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900"
      >
        <span>{selected ? `${selected.flag} ${getLabel(selected)}` : "Select..."}</span>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-1.5">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="w-full px-2.5 py-1.5 text-[13px] border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-gray-400">No results</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => {
                    onChange(opt.code);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left hover:bg-gray-50 ${opt.code === value ? "bg-gray-50 font-medium" : ""}`}
                >
                  {opt.code === value && (
                    <svg
                      className="w-3.5 h-3.5 text-gray-700 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                  {opt.code !== value && <span className="w-3.5 flex-shrink-0" />}
                  <span>
                    {opt.flag} {getLabel(opt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Searchable Multi-Select ──────────────────────────────────────────
function SearchableMultiSelect<T extends { code: string; flag: string }>({
  selected,
  onToggle,
  options,
  excludeCode,
  placeholder,
  getLabel,
  getSearchLabel,
  popularCodes,
  emptyMessage,
}: {
  selected: string[];
  onToggle: (code: string) => void;
  options: T[];
  excludeCode: string;
  placeholder: string;
  getLabel: (opt: T) => string;
  getSearchLabel: (opt: T) => string;
  popularCodes: string[];
  emptyMessage: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const available = options.filter((o) => o.code !== excludeCode);
  const filtered = query.trim()
    ? available.filter((o) => getSearchLabel(o).toLowerCase().includes(query.toLowerCase()))
    : available;
  const popular = available.filter((o) => popularCodes.includes(o.code));

  return (
    <div ref={ref}>
      {/* Search input */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900 placeholder:text-gray-400"
        />
        {/* Dropdown */}
        {open && query.trim() && (
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-gray-400">No results found</p>
            ) : (
              filtered.map((opt) => {
                const isSelected = selected.includes(opt.code);
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => {
                      onToggle(opt.code);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left transition-colors ${isSelected ? "bg-primary-500 text-white" : "hover:bg-gray-50 text-gray-900"}`}
                  >
                    <span>{opt.flag}</span>
                    <span>{getSearchLabel(opt)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Popular choices */}
      <div className="mt-2">
        <p className="text-[11px] text-gray-400 font-medium mb-1.5">Popular choices &mdash;</p>
        <div className="flex flex-wrap gap-1.5">
          {popular.map((opt) => {
            const isSelected = selected.includes(opt.code);
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => onToggle(opt.code)}
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full transition-colors ${
                  isSelected
                    ? "bg-primary-100 text-primary-700 border border-primary-300"
                    : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
                }`}
              >
                {opt.flag} {getLabel(opt)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Added items */}
      {selected.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] text-gray-400 font-medium mb-1.5">Added ({selected.length}):</p>
          <div className="flex flex-wrap gap-1.5">
            {selected.map((code) => {
              const opt = options.find((o) => o.code === code);
              if (!opt) return null;
              return (
                <span
                  key={code}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full bg-primary-100 text-primary-700 border border-primary-300"
                >
                  {opt.flag} {getLabel(opt)}
                  <button
                    type="button"
                    onClick={() => onToggle(code)}
                    className="ml-0.5 text-primary-400 hover:text-primary-600"
                  >
                    &times;
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-gray-400 italic">{emptyMessage}</p>
      )}
    </div>
  );
}
