"use client";

import { useCallback, useEffect, useState } from "react";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import { useBenefitsSettingsTab } from "@/components/booking-flow/useBookingFlowSettingsTabs";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import { getBookingBenefitsSettings } from "@/services/api/bookingBenefitsSettingsClient";
import { normalizeBookingBenefitsSettings } from "@/services/api/bookingFlowSettingsLoader";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { settingsService } from "@/services/settings";

const NO_BENEFITS = { benefits: [] };

/** Settings → Book Direct Benefits: the perks guests see in the room detail modal (VAY-2072). */
export function BookDirectBenefitsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [bookingHotelId, setBookingHotelId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const {
    benefits,
    setBenefits,
    benefitInput,
    setBenefitInput,
    savingBenefits,
    handleSaveBenefits,
  } = useBenefitsSettingsTab({
    getBookingHotelIdForSave: () => {
      const hotelId = bookingHotelId || getSelectedBookingHotelId();
      if (!hotelId) throw new Error(t("admin.bookingHotelIdIsRequired"));
      return hotelId;
    },
    showFeedback: (type, message) => setFeedback({ type, message }),
  });

  // A failed read must not show an empty list that a Save would write over the real perks.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const hotelId =
        getSelectedBookingHotelId() || (await settingsService.getPropertySettings()).id || null;
      if (!hotelId) throw new Error("No booking hotel selected");
      const settings = await getBookingBenefitsSettings({ hotelId });
      setBookingHotelId(hotelId);
      setBenefits(normalizeBookingBenefitsSettings(settings, NO_BENEFITS).benefits);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [setBenefits]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsSubPage title={t("settings.cards.benefits.title")}>
      {feedback && (
        <div role={feedback.type === "error" ? "alert" : "status"} aria-live="polite">
          <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-4" />
        </div>
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
          <BenefitsTab
            benefits={benefits}
            setBenefits={setBenefits}
            benefitInput={benefitInput}
            setBenefitInput={setBenefitInput}
            saveBenefits={handleSaveBenefits}
            savingBenefits={savingBenefits}
          />
        )}
      </div>
    </SettingsSubPage>
  );
}
