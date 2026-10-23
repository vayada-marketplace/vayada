"use client";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import PropertyAddressFields, { type propertyAddressEnglish } from "./PropertyAddressFields";

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
  /** The address fields' copy (VAY-2322, shared with the PMS); English without it. */
  translate?: (key: keyof typeof propertyAddressEnglish) => string;
  locale?: string;
}) {
  function change(patch: Partial<PropertyProfileLocation>) {
    onChange({ ...value, ...patch });
  }
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <legend className="mb-2 text-lg font-semibold text-gray-950">Location</legend>
      <p className="text-sm text-gray-500">
        Confirm your address and pin. We’ll suggest places nearby automatically.
      </p>
      <PropertyAddressFields
        value={value}
        onChange={change}
        apiKey={apiKey}
        disabled={disabled}
        translate={translate}
        locale={locale}
        split
      />
      <label className="block text-sm font-medium text-gray-700">
        Time zone
        <input
          className={nearbyInputClass}
          value={value.timezone}
          maxLength={200}
          placeholder="Asia/Makassar"
          onChange={(event) => change({ timezone: event.target.value })}
        />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Guest map visibility
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
          <option value="hidden">Hidden</option>
          <option value="approximate">Approximate area</option>
          <option value="exact">Exact location</option>
        </select>
      </label>
      <p className="text-xs text-gray-500">
        Approximate shows your area without the exact pin. Hidden removes the map and nearby places.
      </p>
    </fieldset>
  );
}
