"use client";
import { useEffect, useMemo, useState } from "react";
import NearbyEditor from "@vayada/product-onboarding/NearbyEditor";
import type { NearbyGuestMap } from "@vayada/product-onboarding/NearbyPlacesEditor";
import { sharedHotelSetupApi, nearbyApi } from "@/services/api/sharedHotelSetupClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { bookingLocationMapClient } from "@/services/api/bookingLocationMapClient";
import { PageLayout } from "@/components/layout/PageLayout";
import { SettingsBreadcrumb } from "@/components/settings/SettingsSubPage";
import { useTranslation } from "@/lib/i18n";
import { LocationMapCard } from "@/components/settings/LocationMapCard";

export default function LocationPage() {
  const { t, locale } = useTranslation();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [error, setError] = useState<
    "" | "nearbyPlaces.page.selectHotel" | "nearbyPlaces.page.loadFailed"
  >("");
  useEffect(() => {
    let disposed = false;
    const hotelId = getSelectedBookingHotelId();
    if (!hotelId) {
      setError("nearbyPlaces.page.selectHotel");
      return;
    }
    void getBookingHotelPropertyLink({ hotelId })
      .then((link) => {
        if (!disposed) setPropertyId(link.propertyId);
      })
      .catch(() => {
        if (!disposed) setError("nearbyPlaces.page.loadFailed");
      });
    return () => {
      disposed = true;
    };
  }, []);
  // The "Show nearby places" switch and the rooms elsewhere, from the location map's settings (VAY-2326).
  const guestMap = useMemo<NearbyGuestMap | undefined>(
    () =>
      propertyId
        ? {
            load: (signal) => bookingLocationMapClient.load(propertyId, signal),
            setNearbyEnabled: (enabled) => bookingLocationMapClient.saveNearby(propertyId, enabled),
          }
        : undefined,
    [propertyId],
  );
  return (
    <PageLayout>
      <SettingsBreadcrumb
        current={t("nearbyPlaces.page.title")}
        trail={[{ label: t("settings.cards.general.title"), href: "/settings/general" }]}
        fullPageLinks
        className="mb-2"
      />
      {propertyId ? (
        <NearbyEditor
          key={propertyId}
          propertyId={propertyId}
          api={nearbyApi}
          profileApi={sharedHotelSetupApi}
          apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
          // The address fields, shared with the PMS room editor (VAY-2322).
          addressTranslate={t}
          translate={t}
          locale={locale}
          guestMap={guestMap}
          // A saved location (pin, visibility) changes what guests see: re-read the card then.
          intro={(profileRevision) => (
            <LocationMapCard key={profileRevision} propertyId={propertyId} />
          )}
        />
      ) : (
        <div role={error ? "alert" : "status"}>
          {error ? t(error) : t("nearbyPlaces.page.loading")}
          {error && (
            <a href="/settings/location" className="ml-3 text-blue-700 underline">
              {t("nearbyPlaces.page.reload")}
            </a>
          )}
        </div>
      )}
    </PageLayout>
  );
}
