"use client";

import { SettingsSection, SettingsCard } from "./layout";

interface BookingEngineSectionProps {
  instantBook: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}

export function BookingEngineSection({
  instantBook,
  saving,
  onToggle,
}: BookingEngineSectionProps) {
  return (
    <SettingsSection
      id="booking-engine"
      title="Booking Engine"
      description="Choose how new bookings from your booking engine are accepted."
    >
      <SettingsCard>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">
              Accept bookings instantly
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {instantBook
                ? "On — new bookings are confirmed immediately. Card payments are charged at booking time and the guest receives an instant confirmation."
                : "Off — new bookings arrive as requests. You have 24 hours to accept or reject; card payments are only authorized until you confirm."}
            </p>
            <p className="text-[11px] text-gray-400 mt-2">
              Bank-transfer bookings always require manual review since no
              payment has been received yet.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={instantBook}
            disabled={saving}
            onClick={() => onToggle(!instantBook)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
              instantBook ? "bg-primary-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                instantBook ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
