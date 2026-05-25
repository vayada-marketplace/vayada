"use client";

import { SettingsSection, SettingsCard, FormRow } from "./layout";
import { PROPERTY_TYPES, TIMEZONE_OPTIONS } from "./constants";

const inputClass =
  "w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white";

interface PropertySectionProps {
  propertyType: string;
  setPropertyType: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  state: string;
  setState: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  address: string;
  setAddress: (v: string) => void;
  zipCode: string;
  setZipCode: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  latitude: string;
  setLatitude: (v: string) => void;
  longitude: string;
  setLongitude: (v: string) => void;
  saving: boolean;
  onSave: () => void;
}

export function PropertySection(props: PropertySectionProps) {
  const {
    propertyType,
    setPropertyType,
    timezone,
    setTimezone,
    country,
    setCountry,
    state,
    setState,
    city,
    setCity,
    address,
    setAddress,
    zipCode,
    setZipCode,
    phone,
    setPhone,
    latitude,
    setLatitude,
    longitude,
    setLongitude,
    saving,
    onSave,
  } = props;

  return (
    <SettingsSection
      id="property-details"
      title="Property"
      description="Property type, location, and contact. Required for channel manager (OTA connections)."
    >
      <SettingsCard
        footer={
          <div className="flex justify-end">
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormRow
            label="Property Type"
            description={
              <>Only select &quot;Hotel&quot; for actual hotels — affects channel manager billing.</>
            }
          >
            <select
              value={propertyType}
              onChange={(e) => setPropertyType(e.target.value)}
              className={inputClass}
            >
              {PROPERTY_TYPES.map((pt) => (
                <option key={pt.value} value={pt.value}>
                  {pt.label}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Timezone">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={inputClass}
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label="Country (ISO code)">
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              placeholder="ID"
              maxLength={2}
              className={inputClass}
            />
          </FormRow>

          <FormRow label="State / Province">
            <input
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="Bali"
              className={inputClass}
            />
          </FormRow>

          <FormRow label="City">
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Seminyak"
              className={inputClass}
            />
          </FormRow>

          <FormRow label="Zip Code">
            <input
              type="text"
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              placeholder="80361"
              className={inputClass}
            />
          </FormRow>

          <div className="md:col-span-2">
            <FormRow label="Address">
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Jl. Raya Seminyak No. 123"
                className={inputClass}
              />
            </FormRow>
          </div>

          <FormRow label="Phone">
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+62 812 3456 7890"
              className={inputClass}
            />
          </FormRow>

          <div className="grid grid-cols-2 gap-3">
            <FormRow label="Latitude">
              <input
                type="text"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
                placeholder="-8.6917"
                className={inputClass}
              />
            </FormRow>
            <FormRow label="Longitude">
              <input
                type="text"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
                placeholder="115.1683"
                className={inputClass}
              />
            </FormRow>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
