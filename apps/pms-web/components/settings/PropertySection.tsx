"use client";

import { SettingsSection, SettingsCard, FormRow } from "./layout";
import { TIMEZONE_OPTIONS } from "./constants";

const inputClass =
  "w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white";

interface PropertySectionProps {
  timezone: string;
  setTimezone: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  saving: boolean;
  onSave: () => void;
}

export function PropertySection({
  timezone,
  setTimezone,
  country,
  setCountry,
  saving,
  onSave,
}: PropertySectionProps) {
  return (
    <SettingsSection
      id="property-details"
      title="Property"
      description="Only what the channel manager actually needs. Title, currency, and contact email are set elsewhere."
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
          <FormRow label="Timezone" required>
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

          <FormRow label="Country (ISO code)" required>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              placeholder="ID"
              maxLength={2}
              className={inputClass}
            />
          </FormRow>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
