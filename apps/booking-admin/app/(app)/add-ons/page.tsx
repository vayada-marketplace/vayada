"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { useTranslation } from "@/lib/i18n";
import { settingsService, type AddonItem, type AddonSettings } from "@/services/settings";
import {
  getBookingAddonSettings,
  updateBookingAddonSettings,
} from "@/services/api/bookingAddonSettingsClient";
import {
  BookingAddonItemsClientError,
  createBookingAddonItem,
  deleteBookingAddonItem,
  getBookingAddonItemsContext,
  updateBookingAddonItem,
  type BookingAddonItem,
  type BookingAddonPricingModel,
  type BookingPropertyPlan,
  type CreateBookingAddonItemBody,
} from "@/services/api/bookingAddonItemsClient";
import { FeedbackAlert } from "@/components/ui";
import { uploadSingleImageWithMediaReference } from "@/lib/utils/uploadImage";
import AddonsTab, { type AddonItemFormValues } from "@/components/booking-flow/AddonsTab";

const DEFAULT_ADDON_SETTINGS: AddonSettings = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const DEFAULT_PROPERTY_PLAN: BookingPropertyPlan = {
  propertyId: "",
  plan: "commission",
  limits: {
    maxRoomPhotosPerType: 10,
    maxAddons: 3,
    guestContactAccess: "after_acceptance",
  },
};

function getSelectedBookingHotelId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("selectedHotelId");
}

function toSettingsAddonItem(item: BookingAddonItem): AddonItem {
  return {
    id: item.addonItemId,
    name: item.name,
    description: item.description,
    price: Number(item.price) || 0,
    currency: item.currency,
    category: item.category,
    image: item.imageUrl ?? "",
    imageMediaObjectId: item.imageMediaObjectId,
    photos: item.photos,
    location: item.location ?? undefined,
    maxGuests: item.maxGuests == null ? undefined : String(item.maxGuests),
    maxQuantity: item.maxQuantity,
    leadTime: item.leadTime ?? undefined,
    duration: item.duration ?? undefined,
    perPerson: item.pricingModel === "per_guest" || item.pricingModel === "per_guest_night",
    perNight: item.pricingModel === "per_night" || item.pricingModel === "per_guest_night",
    sortOrder: item.sortOrder,
    ownershipKind: item.ownershipKind,
    partnerCommissionRate: item.partnerCommissionRate,
    live: item.publicVisible && item.status === "active",
  };
}

function toAddonPricingModel(addon: { perPerson?: boolean; perNight?: boolean }) {
  if (addon.perPerson && addon.perNight) return "per_guest_night";
  if (addon.perPerson) return "per_guest";
  if (addon.perNight) return "per_night";
  return "per_stay";
}

function toAddonWritableFields(values: AddonItemFormValues) {
  const fields = {
    name: values.name,
    description: values.description,
    price: values.price,
    currency: values.currency,
    category: values.category,
    duration: values.duration || null,
    location: values.location || null,
    maxGuests: values.maxGuests ? Number(values.maxGuests) : null,
    maxQuantity: Number(values.maxQuantity),
    leadTime: values.leadTime || null,
    pricingModel: toAddonPricingModel(values) as BookingAddonPricingModel,
  };
  return values.ownershipKind === "partner"
    ? {
        ...fields,
        ownershipKind: "partner" as const,
        partnerCommissionRate: values.partnerCommissionRate,
      }
    : {
        ...fields,
        ownershipKind: "property" as const,
        partnerCommissionRate: null,
      };
}

async function addonPhotos(values: AddonItemFormValues, bookingHotelId: string) {
  const photos = [];
  for (const photo of values.photos) {
    const uploaded = photo.file
      ? await uploadSingleImageWithMediaReference(photo.file, "booking.addon.image", bookingHotelId)
      : photo;
    photos.push({
      mediaObjectId: uploaded.mediaObjectId,
      imageUrl: photo.file ? "" : photo.imageUrl,
      isCover: photo.isCover,
    });
  }
  return photos;
}

function toAddonCreateBody(
  values: AddonItemFormValues,
  sortOrder: number,
): CreateBookingAddonItemBody {
  return {
    ...toAddonWritableFields(values),
    publicVisible: true,
    status: "active",
    sortOrder,
  };
}

function orderAddons(addons: AddonItem[]): AddonItem[] {
  return addons
    .map((addon, index) => ({ addon, index }))
    .sort((left, right) => {
      const leftOrder = left.addon.sortOrder ?? left.index;
      const rightOrder = right.addon.sortOrder ?? right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ addon }) => addon);
}

function nextAddonSortOrder(addons: AddonItem[]): number {
  return addons.reduce((max, addon) => Math.max(max, addon.sortOrder ?? -1), -1) + 1;
}

function moveAddon(addons: AddonItem[], sourceAddonId: string, targetAddonId: string): AddonItem[] {
  const ordered = orderAddons(addons);
  const sourceIndex = ordered.findIndex((addon) => addon.id === sourceAddonId);
  const targetIndex = ordered.findIndex((addon) => addon.id === targetAddonId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return ordered;

  const [movedAddon] = ordered.splice(sourceIndex, 1);
  if (!movedAddon) return ordered;
  ordered.splice(targetIndex, 0, movedAddon);
  return ordered.map((addon, index) => ({ ...addon, sortOrder: index }));
}

// Add-ons is a top-level page; it used to be a Booking Flow tab (VAY-2077).
export default function AddonsPage() {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  const [addons, setAddons] = useState<AddonItem[]>([]);
  const [propertyPlan, setPropertyPlan] = useState<BookingPropertyPlan>(DEFAULT_PROPERTY_PLAN);
  const [addonSettings, setAddonSettings] = useState<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsRef = useRef<AddonSettings>(DEFAULT_ADDON_SETTINGS);
  const addonSettingsWriteSeqRef = useRef(0);
  const addonSettingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [addonCurrency, setAddonCurrency] = useState("");

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

  // A failed read shows Retry rather than defaults: toggling a display setting would otherwise
  // save defaults over the stored ones, and an empty list hides the real add-ons.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const selectedHotelId = getSelectedBookingHotelId();
      const hotelId = selectedHotelId || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      const [settings, context] = await Promise.all([
        getBookingAddonSettings({ hotelId }),
        getBookingAddonItemsContext({ hotelId }),
      ]);
      setBookingHotelId(hotelId);
      addonSettingsRef.current = settings;
      setAddonSettings(settings);
      setAddons(orderAddons(context.addonItems.map(toSettingsAddonItem)));
      setPropertyPlan(context.propertyPlan);
      setAddonCurrency(context.propertyCurrency ?? "");
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const handleCreateAddon = async (values: AddonItemFormValues, { hidden = false } = {}) => {
    try {
      const hotelId = getBookingHotelIdForSave();
      const saved = await createBookingAddonItem({
        hotelId,
        body: {
          ...toAddonCreateBody(values, nextAddonSortOrder(addons)),
          ...(hidden && { publicVisible: false }),
          photos: await addonPhotos(values, hotelId),
        },
      });
      setAddons((current) => orderAddons([...current, toSettingsAddonItem(saved)]));
      showFeedback("success", t("bookingFlow.addons.feedback.createSuccess"));
    } catch (error) {
      const message = t("bookingFlow.addons.feedback.saveError");
      showFeedback("error", message);
      if (error instanceof BookingAddonItemsClientError && error.statusCode === 409) {
        try {
          const context = await getBookingAddonItemsContext({
            hotelId: getBookingHotelIdForSave(),
          });
          setAddons(orderAddons(context.addonItems.map(toSettingsAddonItem)));
          setPropertyPlan(context.propertyPlan);
        } catch {
          // Preserve the authoritative create error when a best-effort refresh also fails.
        }
      }
      throw error;
    }
  };

  const handleUpdateAddon = async (addonId: string, values: AddonItemFormValues) => {
    try {
      const hotelId = getBookingHotelIdForSave();
      const saved = await updateBookingAddonItem({
        hotelId,
        addonItemId: addonId,
        body: {
          ...toAddonWritableFields(values),
          photos: await addonPhotos(values, hotelId),
        },
      });
      setAddons((current) =>
        orderAddons(
          current.map((addon) => (addon.id === addonId ? toSettingsAddonItem(saved) : addon)),
        ),
      );
      showFeedback("success", t("bookingFlow.addons.feedback.updateSuccess"));
    } catch (error) {
      const message = t("bookingFlow.addons.feedback.saveError");
      showFeedback("error", message);
      throw error;
    }
  };

  const handleToggleAddonLive = async (addon: AddonItem) => {
    try {
      const saved = await updateBookingAddonItem({
        hotelId: getBookingHotelIdForSave(),
        addonItemId: addon.id,
        body: addon.live ? { publicVisible: false } : { publicVisible: true, status: "active" },
      });
      setAddons((current) =>
        current.map((item) => (item.id === addon.id ? toSettingsAddonItem(saved) : item)),
      );
    } catch {
      showFeedback("error", t("bookingFlow.addons.feedback.saveError"));
    }
  };

  const handleReorderAddon = async (sourceAddonId: string, targetAddonId: string) => {
    const previousAddons = addons;
    const reorderedAddons = moveAddon(previousAddons, sourceAddonId, targetAddonId);
    const previousOrderById = new Map(previousAddons.map((addon) => [addon.id, addon.sortOrder]));
    const changedAddons = reorderedAddons.filter(
      (addon) => previousOrderById.get(addon.id) !== addon.sortOrder,
    );
    if (changedAddons.length === 0) return;

    setAddons(reorderedAddons);
    try {
      const hotelId = getBookingHotelIdForSave();
      await Promise.all(
        changedAddons.map((addon) =>
          updateBookingAddonItem({
            hotelId,
            addonItemId: addon.id,
            body: { sortOrder: addon.sortOrder ?? 0 },
          }),
        ),
      );
    } catch {
      setAddons(previousAddons);
      showFeedback("error", t("bookingFlow.addons.feedback.saveError"));
      throw new Error(t("admin.failedToReorderAddOns"));
    }
  };

  const handleDeleteAddon = async (addonId: string) => {
    try {
      await deleteBookingAddonItem({
        hotelId: getBookingHotelIdForSave(),
        addonItemId: addonId,
      });
      setAddons((current) => current.filter((addon) => addon.id !== addonId));
      showFeedback("success", t("bookingFlow.addons.feedback.deleteSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.addons.feedback.deleteError"));
      throw new Error(t("admin.failedToDeleteAddOn"));
    }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 lg:px-8">
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
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 lg:px-8">
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mb-4" />
      )}
      <AddonsTab
        addons={addons}
        addonSettings={addonSettings}
        propertyCurrency={addonCurrency}
        propertyPlan={propertyPlan}
        handleToggleAddonSetting={handleToggleAddonSetting}
        onCreateAddon={handleCreateAddon}
        onUpdateAddon={handleUpdateAddon}
        onDeleteAddon={handleDeleteAddon}
        onToggleAddonLive={handleToggleAddonLive}
        onReorderAddon={handleReorderAddon}
      />
    </div>
  );
}
