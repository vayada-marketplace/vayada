"use client";
import { useState, type ReactNode } from "react";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";
import NearbyLocationForm, {
  nearbyLocationEnglish,
  type LocationFormKey,
} from "./NearbyLocationForm";
import NearbyPlacesEditor, { type NearbyGuestMap } from "./NearbyPlacesEditor";
import { englishNearbyPlaces, type Translate } from "./nearbyPlacesMessages";
import { useNearbyEditor } from "./useNearbyEditor";
import { useNearbyNavigationGuard } from "./useNearbyNavigationGuard";
const button =
  "rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50";
const primary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

/** Booking Admin › Location & surroundings: the property's address and pin, then its nearby places (VAY-2326). */
export default function NearbyEditor({
  propertyId,
  api,
  profileApi,
  apiKey,
  intro,
  addressTranslate,
  translate = englishNearbyPlaces,
  locale = "en",
  guestMap,
}: {
  propertyId: string;
  api: NearbyApi;
  profileApi: SharedHotelSetupApi;
  apiKey: string;
  /** The location form's copy (VAY-2322; its address fields are shared with the PMS). */
  addressTranslate?: (key: LocationFormKey) => string;
  /** The page's and the nearby places editor's copy (VAY-2326). */
  translate?: Translate;
  locale?: string;
  /** Shown under the page header, above the editor (Booking Admin's location map switch, VAY-2126). Given
   * the saved profile revision, so it can re-read what depends on the location saved below. */
  intro?: (profileRevision: number) => ReactNode;
  /** The "Show nearby places" switch and the rooms with their own location (VAY-2326). */
  guestMap?: NearbyGuestMap;
}) {
  const t = translate;
  const editor = useNearbyEditor(propertyId, api, profileApi);
  const [formOpen, setFormOpen] = useState(false);
  const unsaved = editor.locationDirty || editor.placesDirty || formOpen;
  useNearbyNavigationGuard(unsaved, t("nearbyPlaces.leaveConfirm"));
  const { profile, location, draft, saved } = editor;
  const reload = () => {
    if (!unsaved || window.confirm(t("nearbyPlaces.reloadConfirm"))) editor.reload();
  };
  if (!profile || !location || !draft || !saved)
    return (
      <div>
        {editor.error ? (
          <div role="alert">
            <p>{t(editor.error)}</p>
            <button className={`${button} mt-3`} onClick={reload}>
              {t("nearbyPlaces.reloadLatest")}
            </button>
          </div>
        ) : (
          <p role="status">{t("nearbyPlaces.page.loading")}</p>
        )}
      </div>
    );
  const reconfirm =
    saved.savedProfileRevision !== null && saved.savedProfileRevision !== profile.profileRevision;
  const pin =
    profile.profile.location.latitude !== null && profile.profile.location.longitude !== null
      ? {
          latitude: profile.profile.location.latitude,
          longitude: profile.profile.location.longitude,
        }
      : null;
  return (
    <div className="space-y-6">
      {/* page-header: Booking Admin's shared header spacing (VAY-2199). */}
      <div className="page-header">
        <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
          {t("nearbyPlaces.page.title")}
        </h1>
        <p className="mt-[var(--page-subtitle-gap,4px)] text-[13px] text-gray-500">
          {profile.profile.displayName}
        </p>
      </div>
      {editor.error && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-800">
          <p>{t(editor.error)}</p>
          <button type="button" className="mt-2 underline" onClick={reload}>
            {t("nearbyPlaces.reloadLatest")}
          </button>
        </div>
      )}
      {editor.notice && (
        <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-800">
          {t(editor.notice)}
        </p>
      )}
      {intro?.(profile.profileRevision)}
      {/* The address takes the full width, its map next to the fields; nearby places below (VAY-2322). */}
      <div className="space-y-8">
        <form
          className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void editor.saveLocation();
          }}
        >
          <NearbyLocationForm
            apiKey={apiKey}
            value={location}
            onChange={editor.setLocation}
            disabled={editor.busy}
            translate={addressTranslate}
            locale={locale}
          />
          <button className={primary} disabled={editor.busy || !editor.locationDirty} type="submit">
            {editor.busy
              ? (addressTranslate?.("locationForm.saving") ??
                nearbyLocationEnglish["locationForm.saving"])
              : (addressTranslate?.("locationForm.save") ??
                nearbyLocationEnglish["locationForm.save"])}
          </button>
        </form>
        {editor.locationDirty && (
          <p role="status" className="text-sm text-amber-800">
            {t("nearbyPlaces.locationDirty")}
          </p>
        )}
        <NearbyPlacesEditor
          t={t}
          locale={locale}
          apiKey={apiKey}
          propertyName={profile.profile.displayName}
          propertyPin={pin}
          saved={saved}
          draft={draft}
          setDraft={(update) => editor.setDraft((current) => current && update(current))}
          disabled={editor.busy || editor.locationDirty}
          busy={editor.busy}
          dirty={editor.placesDirty}
          locationDirty={editor.locationDirty}
          reconfirm={reconfirm}
          onSave={() => void editor.savePlaces()}
          onDiscard={editor.discard}
          guestMap={guestMap}
          onFormOpen={setFormOpen}
        />
      </div>
    </div>
  );
}
