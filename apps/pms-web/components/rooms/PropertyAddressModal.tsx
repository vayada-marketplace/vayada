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
import { roomsService } from "@/services/rooms";

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";

type Impact = { inherit: string[]; own: string[] };

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
  const [impact, setImpact] = useState<Impact | "loading" | "failed">("loading");
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
        setDraft({ streetAddress, postalCode, city, countryCode, latitude, longitude });
        const pin = latitude !== null && longitude !== null ? { latitude, longitude } : null;
        return roomsService.list().then((rooms) => {
          if (disposed) return;
          // This room first, as it is on screen; the others as saved.
          const others = rooms.filter((other) => other.id !== room.id);
          setImpact({
            inherit: [
              room.name.trim() || t("rooms.addressModal.thisRoom"),
              ...others
                .filter((other) => roomLocationSource(other, pin) === "property")
                .map((other) => other.name),
            ],
            own: others
              .filter((other) => roomLocationSource(other, pin) === "custom")
              .map((other) => other.name),
          });
        });
      })
      .catch(() => {
        if (disposed) return;
        setProfile((current) => (current === "loading" ? "failed" : current));
        setImpact((current) => (current === "loading" ? "failed" : current));
      });
    return () => {
      disposed = true;
    };
    // Read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  const complete =
    draft !== null &&
    [draft.streetAddress, draft.city, draft.countryCode].every((part) => part.trim() !== "");

  async function save() {
    if (typeof profile !== "object" || !draft || !complete) return;
    setSaving(true);
    setError("");
    try {
      const next = await sharedHotelSetupApi.updatePropertyProfile(propertyId, {
        expectedProfileRevision: profile.profileRevision,
        patch: {
          location: {
            ...profile.profile.location,
            ...draft,
            streetAddress: draft.streetAddress.trim(),
            postalCode: draft.postalCode.trim(),
            city: draft.city.trim(),
          },
        },
      });
      onSaved(pmsPropertyPlace(propertyId, next));
    } catch (failure) {
      const status =
        (failure as { status?: number; statusCode?: number })?.status ??
        (failure as { statusCode?: number })?.statusCode;
      setError(t(status === 409 ? "rooms.addressModal.conflict" : "rooms.addressModal.saveFailed"));
      setSaving(false);
    }
  }

  const close = () => !saving && onClose();

  // Outside the room form: Enter in these fields must not submit the room.
  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="property-address-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-gray-900 backdrop:bg-black/50 open:flex open:flex-col sm:m-auto sm:h-auto sm:max-h-[92vh] sm:w-[calc(100%-2rem)] sm:max-w-[1040px] sm:rounded-2xl sm:shadow-2xl"
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
        {impact === "loading" ? null : impact === "failed" ? (
          <p className="text-[12px] text-gray-500">{t("rooms.addressModal.roomsFailed")}</p>
        ) : (
          <div
            data-testid="address-impact"
            className="flex items-start gap-2.5 rounded-xl border border-primary-100 bg-primary-50 px-3.5 py-3"
          >
            <InformationCircleIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary-600" />
            <div className="min-w-0 space-y-2">
              <p className="text-[13px] font-semibold">
                {impact.inherit.length === 1
                  ? t("rooms.addressModal.impactOne")
                  : t("rooms.addressModal.impactMany", { count: impact.inherit.length })}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {impact.inherit.map((name, index) => (
                  <li
                    key={`${index}-${name}`}
                    className="inline-flex items-center gap-1 rounded-full border border-primary-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-primary-700"
                  >
                    <BuildingOffice2Icon className="h-3 w-3" />
                    {name}
                  </li>
                ))}
              </ul>
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
            split
          />
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row sm:items-center sm:px-6">
        <div className="min-w-0 flex-1 text-[12px]">
          {error ? (
            <p role="alert" className="font-medium text-red-600">
              {error}
            </p>
          ) : draft && !complete ? (
            <p className="text-amber-800">{t("rooms.addressModal.needsAddress")}</p>
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
