"use client";

import { useCallback, useEffect, useState } from "react";
import GuestFormTab from "@/components/booking-flow/GuestFormTab";
import { useGuestFormSettingsTab } from "@/components/booking-flow/useBookingFlowSettingsTabs";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import { getBookingGuestFormSettings } from "@/services/api/bookingGuestFormSettingsClient";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { settingsService } from "@/services/settings";

/** Settings → Guest Form: extra checkout fields for guests (VAY-2144, was Booking Flow → Guest Form). */
export function GuestFormPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const guestForm = useGuestFormSettingsTab({
    getBookingHotelIdForSave: () => {
      const hotelId = bookingHotelId || getSelectedBookingHotelId();
      if (!hotelId) throw new Error(t("admin.bookingHotelIdIsRequired"));
      return hotelId;
    },
    showFeedback: (type, message) => {
      setFeedback({ type, message });
      setTimeout(() => setFeedback(null), 3000);
    },
  });
  const { applyGuestFormSettings } = guestForm;

  // A failed read must not show the defaults, which a Save would write over the real form.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      applyGuestFormSettings(await getBookingGuestFormSettings({ hotelId }));
      setBookingHotelId(hotelId);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [applyGuestFormSettings]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsSubPage title={t("settings.cards.guestForm.title")}>
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
          <GuestFormTab
            specialRequestsEnabled={guestForm.specialRequestsEnabled}
            setSpecialRequestsEnabled={guestForm.setSpecialRequestsEnabled}
            arrivalTimeEnabled={guestForm.arrivalTimeEnabled}
            setArrivalTimeEnabled={guestForm.setArrivalTimeEnabled}
            guestCountEnabled={guestForm.guestCountEnabled}
            setGuestCountEnabled={guestForm.setGuestCountEnabled}
            phoneRequired={guestForm.phoneRequired}
            setPhoneRequired={guestForm.setPhoneRequired}
            adultAgeThreshold={guestForm.adultAgeThreshold}
            setAdultAgeThreshold={guestForm.setAdultAgeThreshold}
            childrenEnabled={guestForm.childrenEnabled}
            setChildrenEnabled={guestForm.setChildrenEnabled}
            onSave={guestForm.handleSaveGuestForm}
            saving={guestForm.savingGuestForm}
          />
        )}
      </div>
    </SettingsSubPage>
  );
}
