"use client";
import { useEffect, useState } from "react";
import NearbyEditor from "@vayada/product-onboarding/NearbyEditor";
import { sharedHotelSetupApi, nearbyApi } from "@/services/api/sharedHotelSetupClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { PageLayout } from "@/components/layout/PageLayout";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import { useTranslation } from "@/lib/i18n";

export default function LocationPage() {
  const { t } = useTranslation();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const hotelId = getSelectedBookingHotelId();
    if (!hotelId) {
      setError("Select a hotel before editing its location.");
      return;
    }
    void getBookingHotelPropertyLink({ hotelId })
      .then((link) => {
        if (!disposed) setPropertyId(link.propertyId);
      })
      .catch(() => {
        if (!disposed)
          setError("This hotel's location could not load. Please reload and try again.");
      });
    return () => {
      disposed = true;
    };
  }, []);
  if (!propertyId)
    return (
      <PageLayout role={error ? "alert" : "status"}>
        {error || "Loading location…"}
        {error && (
          <a href="/settings/location" className="ml-3 text-blue-700 underline">
            Reload
          </a>
        )}
      </PageLayout>
    );
  return (
    <PageLayout>
      <SettingsBreadcrumb
        current="Location & surroundings"
        trail={[{ label: t("settings.cards.general.title"), href: "/settings/general" }]}
        fullPageLinks
        className="mb-2"
      />
      <NearbyEditor
        key={propertyId}
        propertyId={propertyId}
        api={nearbyApi}
        profileApi={sharedHotelSetupApi}
        apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
      />
    </PageLayout>
  );
}
