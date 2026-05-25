"use client";

import { useState, useEffect } from "react";
import {
  BuildingOffice2Icon,
  BoltIcon,
  CalendarDaysIcon,
  ClockIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import { bookingsService } from "@/services/bookings";
import { apiClient } from "@/services/api/client";
import { pmsClient } from "@/services/api/pmsClient";
import { useTranslation } from "@/lib/i18n";
import {
  SettingsLayout,
  type SettingsNavSection,
} from "@/components/settings/layout";
import { PropertySection } from "@/components/settings/PropertySection";
import { BookingEngineSection } from "@/components/settings/BookingEngineSection";
import { CalendarSection } from "@/components/settings/CalendarSection";
import { CheckInOutSection } from "@/components/settings/CheckInOutSection";
import { LocalizationSection } from "@/components/settings/LocalizationSection";
import { humanizeApiError } from "@/components/settings/constants";

// Rail items also map to anchor IDs. Localization combines the existing
// #currency + #language anchors (both preserved as sub-targets so the global
// SearchModal links from VAY-367 still scroll to the right place).
type SectionId =
  | "property-details"
  | "booking-engine"
  | "calendar"
  | "check-in-out"
  | "localization";

// Anchors used by SearchModal (apps/pms-web/components/layout/SearchModal.tsx)
// that map onto a parent rail section.
const ANCHOR_TO_SECTION: Record<string, SectionId> = {
  "property-details": "property-details",
  "booking-engine": "booking-engine",
  calendar: "calendar",
  "check-in-out": "check-in-out",
  currency: "localization",
  language: "localization",
};

export default function SettingsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<SectionId>("property-details");

  // Currency
  const [currency, setCurrency] = useState("EUR");
  const [savingCurrency, setSavingCurrency] = useState(false);

  // Check-in / Check-out times
  const [checkInFrom, setCheckInFrom] = useState("14:00");
  const [checkInUntil, setCheckInUntil] = useState("22:00");
  const [checkOutFrom, setCheckOutFrom] = useState("07:00");
  const [checkOutUntil, setCheckOutUntil] = useState("11:00");
  const [savingTimes, setSavingTimes] = useState(false);

  // Property details — only fields Channex actually enforces (timezone + country).
  // Title/currency/contact-email live elsewhere; other address fields are filled
  // later by each OTA's own validation flow when needed.
  const [timezone, setTimezone] = useState("Asia/Makassar");
  const [country, setCountry] = useState("");
  const [savingProperty, setSavingProperty] = useState(false);

  // Booking engine
  const [instantBook, setInstantBook] = useState(false);
  const [savingInstantBook, setSavingInstantBook] = useState(false);

  // Calendar — VAY-397 auto-rearrange toggle
  const [autoRearrange, setAutoRearrange] = useState(true);
  const [savingAutoRearrange, setSavingAutoRearrange] = useState(false);

  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        setCurrency(res.paymentSettings.defaultCurrency || "EUR");
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    apiClient
      .get<{
        check_in_from?: string;
        check_in_until?: string;
        check_out_from?: string;
        check_out_until?: string;
        check_in_time?: string;
        check_out_time?: string;
      }>("/admin/settings/property")
      .then((s) => {
        if (s.check_in_from) setCheckInFrom(s.check_in_from);
        else if (s.check_in_time) setCheckInFrom(s.check_in_time);
        if (s.check_in_until) setCheckInUntil(s.check_in_until);
        if (s.check_out_from) setCheckOutFrom(s.check_out_from);
        if (s.check_out_until) setCheckOutUntil(s.check_out_until);
        else if (s.check_out_time) setCheckOutUntil(s.check_out_time);
      })
      .catch(() => {});

    pmsClient
      .get<any>("/admin/hotel")
      .then((h) => {
        if (h.timezone) setTimezone(h.timezone);
        if (h.country) setCountry(h.country);
        setInstantBook(Boolean(h.instant_book));
      })
      .catch(() => {});

    pmsClient
      .get<{ autoRearrangeEnabled: boolean }>("/admin/calendar-settings")
      .then((s) => setAutoRearrange(Boolean(s.autoRearrangeEnabled)))
      .catch(() => {});
  }, []);

  // Hash → active rail item + scrollIntoView. Re-runs on hashchange so the
  // global SearchModal navigation (VAY-367) lands on the right section even
  // when already on /settings.
  useEffect(() => {
    if (loading) return;
    const handle = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const mapped = ANCHOR_TO_SECTION[hash];
      if (mapped) setActiveId(mapped);
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [loading]);

  const handleSelect = (id: string) => {
    setActiveId(id as SectionId);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const saveTimes = async () => {
    setSavingTimes(true);
    setError("");
    setSuccess("");
    try {
      await apiClient.patch("/admin/settings/property", {
        check_in_from: checkInFrom,
        check_in_until: checkInUntil,
        check_in_time: checkInFrom,
        check_out_from: checkOutFrom,
        check_out_until: checkOutUntil,
        check_out_time: checkOutUntil,
      });
      setSuccess(t("settings.timesSaved"));
    } catch (err: any) {
      setError(err.message || t("settings.failedToSaveTimes"));
    } finally {
      setSavingTimes(false);
    }
  };

  const savePropertyDetails = async () => {
    setSavingProperty(true);
    setError("");
    setSuccess("");
    try {
      // PATCH only the fields the form actually edits; the backend leaves
      // unsent fields untouched (so any address/lat-lon set during onboarding
      // or via a future OTA-specific flow is preserved).
      await pmsClient.patch("/admin/hotel", { timezone, country });
      setSuccess("Property details saved");
    } catch (err: any) {
      setError(
        humanizeApiError(
          err,
          "Couldn’t save property details. Please try again, or contact support if the issue persists.",
        ),
      );
    } finally {
      setSavingProperty(false);
    }
  };

  const toggleAutoRearrange = async (next: boolean) => {
    setSavingAutoRearrange(true);
    setError("");
    setSuccess("");
    const previous = autoRearrange;
    setAutoRearrange(next);
    try {
      await pmsClient.patch("/admin/calendar-settings", {
        autoRearrangeEnabled: next,
      });
      setSuccess(
        next
          ? "Auto-rearrange enabled — new bookings will shuffle existing reservations when needed"
          : "Auto-rearrange disabled — bookings that don’t fit will go to Unassigned",
      );
    } catch (err: any) {
      setAutoRearrange(previous);
      setError(
        humanizeApiError(
          err,
          "Couldn’t update auto-rearrange setting. Please try again.",
        ),
      );
    } finally {
      setSavingAutoRearrange(false);
    }
  };

  const toggleInstantBook = async (next: boolean) => {
    setSavingInstantBook(true);
    setError("");
    setSuccess("");
    const previous = instantBook;
    setInstantBook(next);
    try {
      await pmsClient.patch("/admin/hotel", { instant_book: next });
      setSuccess(
        next ? "Instant booking enabled" : "Booking requests re-enabled",
      );
    } catch (err: any) {
      setInstantBook(previous);
      setError(
        humanizeApiError(
          err,
          "Couldn’t update booking acceptance setting. Please try again, or contact support if the issue persists.",
        ),
      );
    } finally {
      setSavingInstantBook(false);
    }
  };

  const saveCurrency = async () => {
    setSavingCurrency(true);
    setError("");
    setSuccess("");
    try {
      await bookingsService.updatePaymentSettings({ defaultCurrency: currency });
      setSuccess(t("settings.currencySaved"));
    } catch (err: any) {
      setError(err.message || t("settings.failedToSaveCurrency"));
    } finally {
      setSavingCurrency(false);
    }
  };

  const sections: SettingsNavSection[] = [
    {
      id: "property-details",
      label: "Property",
      icon: BuildingOffice2Icon,
    },
    { id: "booking-engine", label: "Booking Engine", icon: BoltIcon },
    { id: "calendar", label: "Calendar", icon: CalendarDaysIcon },
    {
      id: "check-in-out",
      label: t("settings.checkInCheckOut"),
      icon: ClockIcon,
    },
    { id: "localization", label: "Localization", icon: GlobeAltIcon },
  ];

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <SettingsLayout
      title={t("settings.title")}
      sections={sections}
      activeId={activeId}
      onSelect={handleSelect}
    >
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      <PropertySection
        timezone={timezone}
        setTimezone={setTimezone}
        country={country}
        setCountry={setCountry}
        saving={savingProperty}
        onSave={savePropertyDetails}
      />

      <BookingEngineSection
        instantBook={instantBook}
        saving={savingInstantBook}
        onToggle={toggleInstantBook}
      />

      <CalendarSection
        autoRearrange={autoRearrange}
        saving={savingAutoRearrange}
        onToggle={toggleAutoRearrange}
      />

      <CheckInOutSection
        checkInFrom={checkInFrom}
        setCheckInFrom={setCheckInFrom}
        checkInUntil={checkInUntil}
        setCheckInUntil={setCheckInUntil}
        checkOutFrom={checkOutFrom}
        setCheckOutFrom={setCheckOutFrom}
        checkOutUntil={checkOutUntil}
        setCheckOutUntil={setCheckOutUntil}
        saving={savingTimes}
        onSave={saveTimes}
      />

      <LocalizationSection
        currency={currency}
        setCurrency={setCurrency}
        savingCurrency={savingCurrency}
        onSaveCurrency={saveCurrency}
      />
    </SettingsLayout>
  );
}
