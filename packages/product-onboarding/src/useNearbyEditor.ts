"use client";
import { useEffect, useState } from "react";
import {
  type NearbyCurationState,
  type PropertyProfileLocation,
  type PropertyProfileResponse,
} from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { NearbyPlacesMessageKey } from "./nearbyPlacesMessages";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

/** The location page's state: the property's location and its nearby places, each saved on its own. Errors and
 * notices are message keys. Google suggestions left the editor in v1 (VAY-2326): saves leave the stored Google
 * choices out, and the server keeps them. */
export function useNearbyEditor(
  propertyId: string,
  api: NearbyApi,
  profileApi: SharedHotelSetupApi,
) {
  const [profile, setProfile] = useState<PropertyProfileResponse | null>(null);
  const [location, setLocation] = useState<PropertyProfileLocation | null>(null);
  const [saved, setSaved] = useState<NearbyCurationState | null>(null);
  const [draft, setDraft] = useState<NearbyCurationState | null>(null);
  const [error, setError] = useState<NearbyPlacesMessageKey | "">("");
  const [notice, setNotice] = useState<NearbyPlacesMessageKey | "">("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    setProfile(null);
    setSaved(null);
    setDraft(null);
    setLocation(null);
    setError("");
    void Promise.all([profileApi.getPropertyProfile(propertyId), api.read(propertyId)])
      .then(([profile, curation]) => {
        if (disposed) return;
        if (
          profile.propertyId !== propertyId ||
          profile.profileRevision !== curation.profileRevision
        ) {
          setError("nearbyPlaces.error.locationChanged");
          return;
        }
        setProfile(profile);
        setLocation(profile.profile.location);
        setSaved(curation);
        setDraft(curation);
      })
      .catch(() => {
        if (!disposed) setError("nearbyPlaces.error.load");
      });
    return () => {
      disposed = true;
    };
  }, [propertyId, api, profileApi, reload]);
  const locationDirty = Boolean(
    profile && location && JSON.stringify(profile.profile.location) !== JSON.stringify(location),
  );
  const placesDirty = Boolean(
    saved &&
    draft &&
    (JSON.stringify(saved.customPlaces) !== JSON.stringify(draft.customPlaces) ||
      JSON.stringify(saved.customCategories) !== JSON.stringify(draft.customCategories) ||
      JSON.stringify(saved.categoryNames) !== JSON.stringify(draft.categoryNames)),
  );
  async function saveLocation() {
    if (!profile || !location) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await profileApi.updatePropertyProfile(propertyId, {
        expectedProfileRevision: profile.profileRevision,
        patch: { location },
      });
      setProfile(next);
      setLocation(next.profile.location);
      // The server keeps saved places confirmed while the public pin is unchanged (VAY-2104).
      const curation = await api.read(propertyId).catch(() => null);
      const revisions = curation ?? {
        profileRevision: next.profileRevision,
        savedProfileRevision: saved?.savedProfileRevision ?? null,
      };
      setSaved((current) => curation ?? (current && { ...current, ...revisions }));
      setDraft(
        (current) =>
          current && {
            ...current,
            profileRevision: revisions.profileRevision,
            savedProfileRevision: revisions.savedProfileRevision,
          },
      );
      setNotice(
        revisions.savedProfileRevision === null ||
          revisions.savedProfileRevision === revisions.profileRevision
          ? "nearbyPlaces.notice.locationSaved"
          : "nearbyPlaces.notice.locationSavedReview",
      );
    } catch (error) {
      setError(saveError(error));
    } finally {
      setBusy(false);
    }
  }
  async function savePlaces() {
    if (!profile || !draft || !saved || locationDirty) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.save(propertyId, {
        schemaVersion: 1,
        expectedProfileRevision: profile.profileRevision,
        expectedCurationRevision: saved.curationRevision,
        customPlaces: draft.customPlaces,
        customCategories: draft.customCategories,
        categoryNames: draft.categoryNames,
      });
      setSaved(next);
      setDraft(next);
      setNotice("nearbyPlaces.notice.placesSaved");
    } catch (error) {
      setError(saveError(error));
    } finally {
      setBusy(false);
    }
  }
  return {
    profile,
    location,
    setLocation,
    saved,
    draft,
    setDraft,
    error,
    setError,
    notice,
    busy,
    locationDirty,
    placesDirty,
    saveLocation,
    savePlaces,
    reload: () => setReload((value) => value + 1),
    discard: () => {
      if (profile) setLocation(profile.profile.location);
      setDraft(saved);
      setError("");
      setNotice("");
    },
  };
}
function saveError(error: unknown): NearbyPlacesMessageKey {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  return status === 409 ? "nearbyPlaces.error.conflict" : "nearbyPlaces.error.save";
}
