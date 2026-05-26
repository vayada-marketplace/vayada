"use client";

import { SettingsSection, SettingsCard } from "./layout";

interface CalendarSectionProps {
  autoRearrange: boolean;
  autoOpenEnabled: boolean;
  autoOpenMode: "rolling" | "fixed";
  autoOpenMonths: 12 | 18 | 24;
  autoOpenFixedMonth: string;
  autoOpenThrough: string | null;
  autoOpenWarnings: string[];
  saving: boolean;
  onToggle: (next: boolean) => void;
  onAutoOpenEnabledChange: (next: boolean) => void;
  onAutoOpenModeChange: (next: "rolling" | "fixed") => void;
  onAutoOpenMonthsChange: (next: 12 | 18 | 24) => void;
  onAutoOpenFixedMonthChange: (next: string) => void;
  onSaveAutoOpen: () => void;
}

export function CalendarSection({
  autoRearrange,
  autoOpenEnabled,
  autoOpenMode,
  autoOpenMonths,
  autoOpenFixedMonth,
  autoOpenThrough,
  autoOpenWarnings,
  saving,
  onToggle,
  onAutoOpenEnabledChange,
  onAutoOpenModeChange,
  onAutoOpenMonthsChange,
  onAutoOpenFixedMonthChange,
  onSaveAutoOpen,
}: CalendarSectionProps) {
  return (
    <SettingsSection
      id="calendar"
      title="Calendar"
      description="How new bookings are placed on the calendar when no single room fits the dates."
    >
      <SettingsCard>
        <div className="flex items-start justify-between gap-4 pb-5 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">Auto-rearrange room assignments</p>
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

        <div className="pt-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">Auto-open future calendar</p>
              <p className="text-xs text-gray-500 mt-1">
                Keeps availability open to full month boundaries. Manual blocks and bookings stay in
                place.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoOpenEnabled}
              aria-label="Auto-open future calendar"
              disabled={saving}
              onClick={() => onAutoOpenEnabledChange(!autoOpenEnabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
                autoOpenEnabled ? "bg-primary-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  autoOpenEnabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {autoOpenEnabled && (
            <div className="space-y-4">
              <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                {(["rolling", "fixed"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onAutoOpenModeChange(mode)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      autoOpenMode === mode
                        ? "bg-white text-gray-900 shadow-sm"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    {mode === "rolling" ? "Rolling window" : "Fixed end date"}
                  </button>
                ))}
              </div>

              {autoOpenMode === "rolling" ? (
                <label className="block">
                  <span className="block text-xs font-medium text-gray-700 mb-1">
                    Keep open for the next
                  </span>
                  <select
                    value={autoOpenMonths}
                    onChange={(e) => onAutoOpenMonthsChange(Number(e.target.value) as 12 | 18 | 24)}
                    className="w-full max-w-xs px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                  >
                    <option value={12}>12 months</option>
                    <option value={18}>18 months</option>
                    <option value={24}>24 months</option>
                  </select>
                </label>
              ) : (
                <label className="block">
                  <span className="block text-xs font-medium text-gray-700 mb-1">
                    Keep open until
                  </span>
                  <input
                    type="month"
                    value={autoOpenFixedMonth}
                    onChange={(e) => onAutoOpenFixedMonthChange(e.target.value)}
                    className="w-full max-w-xs px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                  />
                </label>
              )}

              {autoOpenThrough && (
                <p className="text-xs text-gray-500">
                  Current auto-open horizon: {autoOpenThrough}
                </p>
              )}

              {autoOpenWarnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-1">
                  {autoOpenWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSaveAutoOpen}
              disabled={
                saving || (autoOpenEnabled && autoOpenMode === "fixed" && !autoOpenFixedMonth)
              }
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : "Save calendar settings"}
            </button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
