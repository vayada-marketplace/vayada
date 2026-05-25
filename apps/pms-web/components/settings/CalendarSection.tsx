"use client";

import { SettingsSection, SettingsCard } from "./layout";

interface CalendarSectionProps {
  autoRearrange: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
}

export function CalendarSection({
  autoRearrange,
  saving,
  onToggle,
}: CalendarSectionProps) {
  return (
    <SettingsSection
      id="calendar"
      title="Calendar"
      description="How new bookings are placed on the calendar when no single room fits the dates."
    >
      <SettingsCard>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">
              Auto-rearrange room assignments
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {autoRearrange
                ? "On — when a new booking doesn’t fit any single room, the system shuffles future bookings between same-type rooms to free a slot. Checked-in and checked-out guests are never moved. Every shuffle is logged."
                : "Off — when a new booking doesn’t fit any single room, it goes to the Unassigned row and you place it manually."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoRearrange}
            disabled={saving}
            onClick={() => onToggle(!autoRearrange)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
              autoRearrange ? "bg-primary-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                autoRearrange ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
