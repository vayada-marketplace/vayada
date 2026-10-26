"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BuildingOffice2Icon, InformationCircleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { PropertyProfileResponse } from "@vayada/domain-hotels";
import PropertyAddressFields, {
  type PropertyAddress,
} from "@vayada/product-onboarding/PropertyAddressFields";
import { useTranslation } from "@/lib/i18n";
import { roomLocationSource } from "@/lib/roomLocation";
import { pmsPropertyPlace, type PmsPropertyPlace } from "@/services/api/pmsPropertyClient";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { roomsService, type RoomType } from "@/services/rooms";

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";

type Pin = { latitude: number; longitude: number } | null;

const pinOf = (place: { latitude: number | null; longitude: number | null }): Pin =>
  place.latitude !== null && place.longitude !== null
    ? { latitude: place.latitude, longitude: place.longitude }
    : null;

/** Who follows the address besides this room: rooms on "Same as property", and older rooms (saved before
 * VAY-2321) that count as the property's by their own pin on it. Those stay at their pin when the property's
 * moves away, so they are named apart. */
function addressImpact(rooms: RoomType[], roomId: string | null, saved: Pin, draft: Pin) {
  const others = rooms.filter((other) => other.id !== roomId);
  const atProperty = others.filter((other) => roomLocationSource(other, saved) === "property");
  const leftBehind = atProperty.filter(
    (other) => !other.locationSource && roomLocationSource(other, draft) === "custom",
  );
  return {
    inherit: atProperty.filter((other) => !leftBehind.includes(other)).map((other) => other.name),
    leftBehind: leftBehind.map((other) => other.name),
    own: others
      .filter((other) => roomLocationSource(other, saved) === "custom")
      .map((other) => other.name),
  };
}

/** The property's address over the room editor (VAY-2322), so the room's unsaved edits stay: the same form as
 * Booking Admin's Location settings, saved to the shared property profile. Only the address and pin change;
 * the guest map's visibility and the rest of the location stay as Booking Admin set them. */
export default function PropertyAddressModal({
  propertyId,
  room,
  onClose,
  onSaved,
}: {
  propertyId: string;
  /** The room type being edited: on "Same as property" while this is open, whatever it saved. */
  room: { id: string | null; name: string };
  onClose: () => void;
  onSaved: (place: PmsPropertyPlace) => void;
}) {
  const { t, locale } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [profile, setProfile] = useState<PropertyProfileResponse | "loading" | "failed">("loading");
  const [draft, setDraft] = useState<PropertyAddress | null>(null);
  const [rooms, setRooms] = useState<RoomType[] | "loading" | "failed">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal?.();
  }, []);

  useEffect(() => {
    let disposed = false;
    sharedHotelSetupApi
      .getPropertyProfile(propertyId)
      .then((read) => {
        if (disposed) return;
        setProfile(read);
        const { streetAddress, postalCode, city, countryCode, latitude, longitude } =
          read.profile.location;
        setDraft({
          streetAddress,
          postalCode,
          city,
          countryCode,
          latitude,
          longitude,
          area: read.profile.location.area ?? "",
          arrivalDirections: read.profile.location.arrivalDirections ?? "",
        });
      })
      .catch(() => !disposed && setProfile("failed"));
    roomsService
      .list()
      .then((list) => !disposed && setRooms(list))
      .catch(() => !disposed && setRooms("failed"));
    return () => {
      disposed = true;
    };
  }, [propertyId]);

  const location = typeof profile === "object" ? profile.profile.location : null;
  const impact =
    location && draft && typeof rooms === "object"
      ? addressImpact(rooms, room.id, pinOf(location), pinOf(draft))
      : null;
  // This room first, as it is on screen; the others as saved.
  const inherit = impact && [
    room.name.trim() || t("rooms.addressModal.thisRoom"),
    ...impact.inherit,
  ];
  // What the profile accepts: street, city and country; a whole pin in range; a pin while guests see a map.
  const problem = !draft
    ? null
    : [draft.streetAddress, draft.city, draft.countryCode].some((part) => part.trim() === "")
      ? "rooms.addressModal.needsAddress"
      : (draft.latitude === null) !== (draft.longitude === null) ||
          (draft.latitude !== null && Math.abs(draft.latitude) > 90) ||
          (draft.longitude !== null && Math.abs(draft.longitude) > 180)
        ? "rooms.addressModal.needsWholePin"
        : location?.geoPublic && draft.latitude === null
          ? "rooms.addressModal.needsPin"
          : null;
  const complete = draft !== null && problem === null;

  async function save() {
    if (typeof profile !== "object" || !draft || !complete) return;
    setSaving(true);
    setError("");
    try {
      const { area, arrivalDirections, ...address } = draft;
      const saved = profile.profile.location;
      // Sent only when given or being cleared: an API from before VAY-2322 F2 refuses them.
      const optional = (value: string | undefined, before: string | undefined) => {
        const text = value?.trim() ?? "";
        return text || before ? text : undefined;
      };
      const newArea = optional(area, saved.area);
      const newDirections = optional(arrivalDirections, saved.arrivalDirections);
      const next = await sharedHotelSetupApi.updatePropertyProfile(propertyId, {
        expectedProfileRevision: profile.profileRevision,
        patch: {
          location: {
            ...saved,
            ...address,
            streetAddress: address.streetAddress.trim(),
            postalCode: address.postalCode.trim(),
            city: address.city.trim(),
            ...(newArea !== undefined ? { area: newArea } : {}),
            ...(newDirections !== undefined ? { arrivalDirections: newDirections } : {}),
          },
        },
      });
      // Closed first, so the focus goes back to "Edit property address".
      dialog.current?.close();
      onSaved(pmsPropertyPlace(propertyId, next));
    } catch (failure) {
      const status =
        (failure as { status?: number; statusCode?: number })?.status ??
        (failure as { statusCode?: number })?.statusCode;
      setError(
        t(
          status === 409
            ? "rooms.addressModal.conflict"
            : status === 403
              ? "rooms.addressModal.noPermission"
              : "rooms.addressModal.saveFailed",
        ),
      );
      setSaving(false);
    }
  }

  const close = () => !saving && dialog.current?.close();

  // Outside the room form: Enter in these fields must not submit the room.
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="property-address-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      // However it closed (a second Escape can't be held back), the room editor hears it.
      onClose={onClose}
      className="m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-gray-900 backdrop:bg-black/50 open:flex open:flex-col sm:m-auto sm:h-fit sm:max-h-[92vh] sm:w-[calc(100%-2rem)] sm:max-w-[1040px] sm:rounded-2xl sm:shadow-2xl"
    >
      <div className="flex items-start gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <div className="min-w-0 flex-1">
          <h2 id="property-address-title" className="text-[18px] font-bold sm:text-[20px]">
            {t("rooms.addressModal.title")}
          </h2>
          <p className="mt-1 text-[12px] text-gray-500">{t("rooms.addressModal.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={t("rooms.addressModal.close")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
        {rooms === "failed" ? (
          <p className="text-[12px] text-gray-500">{t("rooms.addressModal.roomsFailed")}</p>
        ) : !impact || !inherit ? null : (
          <div
            data-testid="address-impact"
            className="flex items-start gap-2.5 rounded-xl border border-primary-100 bg-primary-50 px-3.5 py-3"
          >
            <InformationCircleIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary-600" />
            <div className="min-w-0 space-y-2">
              <p className="text-[13px] font-semibold">
                {inherit.length === 1
                  ? t("rooms.addressModal.impactOne")
                  : t("rooms.addressModal.impactMany", { count: inherit.length })}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {inherit.map((name, index) => (
                  <li
                    key={`${index}-${name}`}
                    className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-primary-700"
                  >
                    <BuildingOffice2Icon className="h-3 w-3" />
                    {name}
                  </li>
                ))}
              </ul>
              {impact.leftBehind.length > 0 && (
                <p className="text-[11px] font-medium text-amber-800">
                  {t(
                    impact.leftBehind.length === 1
                      ? "rooms.addressModal.leftBehindOne"
                      : "rooms.addressModal.leftBehindMany",
                    { names: impact.leftBehind.join(", ") },
                  )}
                </p>
              )}
              {impact.own.length > 0 && (
                <p className="text-[11px] text-gray-600">
                  {t("rooms.addressModal.ownPins", { names: impact.own.join(", ") })}
                </p>
              )}
            </div>
          </div>
        )}

        {profile === "loading" ? (
          <p role="status" className="text-[12px] text-gray-500">
            {t("rooms.addressModal.loading")}
          </p>
        ) : profile === "failed" || !draft ? (
          <p role="alert" className="text-[12px] font-medium text-red-600">
            {t("rooms.addressModal.loadFailed")}
          </p>
        ) : (
          <PropertyAddressFields
            value={draft}
            onChange={(patch) => setDraft((current) => current && { ...current, ...patch })}
            apiKey={GOOGLE_MAPS_API_KEY}
            disabled={saving}
            translate={t}
            locale={locale}
            markerTitle={profile.profile.displayName}
          />
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:px-6">
        <div className="min-w-0 flex-1 text-[12px]">
          {error ? (
            <p role="alert" className="font-medium text-red-600">
              {error}
            </p>
          ) : problem ? (
            <p className="text-amber-800">{t(problem)}</p>
          ) : (
            <p className="text-gray-500">{t("rooms.addressModal.goesLive")}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="h-11 flex-1 rounded-lg border border-gray-300 bg-white px-4 text-[13px] font-medium text-gray-700 sm:h-[38px] sm:flex-none"
          >
            {t("rooms.addressModal.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !complete || typeof profile !== "object"}
            className="h-11 flex-1 rounded-lg bg-primary-600 px-[18px] text-[13px] font-semibold text-white disabled:opacity-50 sm:h-[38px] sm:flex-none"
          >
            {saving ? t("rooms.addressModal.saving") : t("rooms.addressModal.save")}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
