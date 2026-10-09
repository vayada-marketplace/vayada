"use client";

import { useEffect, useState } from "react";
import BenefitsTab from "@/components/booking-flow/BenefitsTab";
import { useBenefitsSettingsTab } from "@/components/booking-flow/useBookingFlowSettingsTabs";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import { getBookingBenefitsSettings } from "@/services/api/bookingBenefitsSettingsClient";
import {
  loadBookingFlowSetting,
  normalizeBookingBenefitsSettings,
} from "@/services/api/bookingFlowSettingsLoader";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { settingsService } from "@/services/settings";

const NO_BENEFITS = { benefits: [] };

/** Settings → Book Direct Benefits: the perks guests see in the room detail modal (VAY-2072). */
export function BookDirectBenefitsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    const selectedHotelId = getSelectedBookingHotelId();
    const propertyPromise = settingsService.getPropertySettings().catch(() => null);
    void Promise.all([
      loadBookingFlowSetting({
        selectedHotelId,
        propertyPromise,
        read: (hotelId) => getBookingBenefitsSettings({ hotelId }),
        defaultValue: NO_BENEFITS,
      }),
      propertyPromise,
    ])
      .then(([settings, property]) => {
        setBookingHotelId(selectedHotelId || property?.id || null);
        setBenefits(normalizeBookingBenefitsSettings(settings, NO_BENEFITS).benefits);
      })
      .finally(() => setLoading(false));
  }, [setBenefits]);

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
