"use client";

import { useCallback, useEffect, useState } from "react";
import { SettingsSection } from "@vayada/settings-ui";
import { bookingsService } from "@/services/bookings";
import { getPmsPropertyProfile, updatePmsPropertyProfile } from "@/services/api/pmsPropertyClient";
import { useTranslation } from "@/lib/i18n";
import { localizedErrorText } from "@/lib/i18n/localizedErrorText";
import { ArrivalTimesSection } from "@/components/settings/ArrivalTimesSection";
import { LocalizationSection } from "@/components/settings/LocalizationSection";
import { PropertySection } from "@/components/settings/PropertySection";
import { SettingsFeedback } from "@/components/settings/SettingsFeedback";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { humanizeApiError } from "@/components/settings/constants";
import { useScrollToHash } from "@/components/settings/useScrollToHash";
import {
  pmsPropertyDetailsSaveError,
  type PmsPropertyProfileLoadStatus,
} from "@/lib/settings/propertyDetails";

// Location, arrival times, currency and language: what used to be Property, the Booking Engine
// times and Localization on the single Settings page (VAY-2275).
export default function PropertySettingsPage() {
  const { t } = useTranslation();
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [currency, setCurrency] = useState("");
  const [currencyLoadError, setCurrencyLoadError] = useState("");
  const [currencyLoadStatus, setCurrencyLoadStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  // Only the fields Channex enforces (timezone + country); other address fields are filled later
  // by each OTA's own validation flow when needed.
  const [timezone, setTimezone] = useState("");
  const [country, setCountry] = useState("");
  const [savingProperty, setSavingProperty] = useState(false);
  const [propertyProfileLoadStatus, setPropertyProfileLoadStatus] =
    useState<PmsPropertyProfileLoadStatus>("loading");
  const [propertyProfileLoadError, setPropertyProfileLoadError] = useState("");
  useScrollToHash();

  const loadPropertyProfile = useCallback(async () => {
    setPropertyProfileLoadStatus("loading");
    setPropertyProfileLoadError("");
    try {
      const profile = await getPmsPropertyProfile();
      setTimezone(profile.timezone ?? "");
      setCountry(profile.country ?? "");
      setPropertyProfileLoadStatus("ready");
    } catch (loadError) {
      setPropertyProfileLoadStatus("error");
      setPropertyProfileLoadError(
        localizedErrorText(
          loadError,
          humanizeApiError(loadError, t("settings.property.loadBeforeEditing")),
          t,
        ),
      );
    }
  }, [t]);

  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        setCurrency(res.paymentSettings.defaultCurrency || "");
        setCurrencyLoadError("");
        setCurrencyLoadStatus("ready");
      })
      .catch(() => {
        setCurrency("");
        setCurrencyLoadError(t("settings.localization.currencyLoadError"));
        setCurrencyLoadStatus("error");
      });
    void loadPropertyProfile();
  }, [loadPropertyProfile, t]);

  const savePropertyDetails = async () => {
    const validationError = pmsPropertyDetailsSaveError({
      loadStatus: propertyProfileLoadStatus,
      timezone,
      country,
    });
    if (validationError) {
      setError(
        t(
          validationError === "profile_not_ready"
            ? "settings.property.profileNotReady"
            : "settings.property.invalidLocation",
        ),
      );
      return;
    }

    setSavingProperty(true);
    setError("");
    setSuccess("");
    try {
      // PATCH only the fields the form edits; the backend leaves unsent fields untouched (so any
      // address/lat-lon set during onboarding or via an OTA-specific flow is preserved).
      const normalizedTimezone = timezone.trim();
      const normalizedCountry = country.trim().toUpperCase();
      await updatePmsPropertyProfile({ timezone: normalizedTimezone, country: normalizedCountry });
      setTimezone(normalizedTimezone);
      setCountry(normalizedCountry);
      setSuccess(t("settings.property.saved"));
    } catch (err) {
      setError(humanizeApiError(err, t("settings.property.saveError")));
    } finally {
      setSavingProperty(false);
    }
  };

  return (
    <SettingsSubPage
      title={t("settings.navigation.property")}
      description={t("settings.cards.property.description")}
    >
      <SettingsFeedback error={error} success={success} />
      <PropertySection
        timezone={timezone}
        setTimezone={setTimezone}
        country={country}
        setCountry={setCountry}
        saving={savingProperty}
        loadStatus={propertyProfileLoadStatus}
        loadError={propertyProfileLoadError}
        onRetry={loadPropertyProfile}
        onSave={savePropertyDetails}
      />
      <SettingsSection
        id="arrival-times"
        title={t("settings.arrivalTimes.title")}
        description={t("settings.arrivalTimes.description")}
      >
        <ArrivalTimesSection />
      </SettingsSection>
      <LocalizationSection
        currency={currency}
        currencyLoadError={currencyLoadError}
        currencyLoadStatus={currencyLoadStatus}
      />
    </SettingsSubPage>
  );
}
