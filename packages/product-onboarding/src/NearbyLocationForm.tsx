"use client";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import PropertyAddressFields, { propertyAddressEnglish } from "./PropertyAddressFields";

/** Booking Admin's own location settings around the shared address fields (VAY-2322). */
export const nearbyLocationEnglish = {
  "locationForm.title": "Location",
  // Google suggestions left the editor in v1 (VAY-2326); they return with VAY-2207.
  "locationForm.intro": "Confirm your address and pin.",
  "locationForm.timezone": "Time zone",
  "locationForm.visibility": "Guest map visibility",
  "locationForm.hidden": "Hidden",
  "locationForm.approximate": "Approximate area",
  "locationForm.exact": "Exact location",
  "locationForm.visibilityHint":
    "Approximate shows your area without the exact pin. Hidden removes the map and nearby places.",
  "locationForm.save": "Save location",
  "locationForm.saving": "Saving…",
} as const;

export type LocationFormKey =
  | keyof typeof propertyAddressEnglish
  | keyof typeof nearbyLocationEnglish;
const english = { ...propertyAddressEnglish, ...nearbyLocationEnglish };

export const nearbyInputClass =
  "mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";
export default function NearbyLocationForm({
  value,
  onChange,
  apiKey,
  disabled,
  translate,
  locale,
}: {
  value: PropertyProfileLocation;
  onChange: (value: PropertyProfileLocation) => void;
  apiKey: string;
  disabled: boolean;
  /** The form's copy (VAY-2322; the address fields are shared with the PMS); English without it. */
  translate?: (key: LocationFormKey) => string;
  locale?: string;
}) {
  const t = translate ?? ((key: LocationFormKey) => english[key]);
  function change(patch: Partial<PropertyProfileLocation>) {
    onChange({ ...value, ...patch });
  }
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <legend className="mb-2 text-lg font-semibold text-gray-950">
        {t("locationForm.title")}
      </legend>
      <p className="text-sm text-gray-500">{t("locationForm.intro")}</p>
      <PropertyAddressFields
        value={value}
        onChange={change}
        apiKey={apiKey}
        disabled={disabled}
        translate={t}
        locale={locale}
      />
      <label className="block text-sm font-medium text-gray-700">
        {t("locationForm.timezone")}
        <input
          className={nearbyInputClass}
          value={value.timezone}
          maxLength={200}
          placeholder="Asia/Makassar"
          onChange={(event) => change({ timezone: event.target.value })}
        />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        {t("locationForm.visibility")}
        <select
          className={nearbyInputClass}
          value={value.geoPublic ? value.mapDisplayMode : "hidden"}
          onChange={(event) =>
            change({
              mapDisplayMode: event.target.value as PropertyProfileLocation["mapDisplayMode"],
              geoPublic: event.target.value !== "hidden",
            })
          }
        >
          <option value="hidden">{t("locationForm.hidden")}</option>
          <option value="approximate">{t("locationForm.approximate")}</option>
          <option value="exact">{t("locationForm.exact")}</option>
        </select>
      </label>
      <p className="text-xs text-gray-500">{t("locationForm.visibilityHint")}</p>
    </fieldset>
  );
}
