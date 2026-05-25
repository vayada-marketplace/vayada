"use client";

import { SettingsSection, SettingsCard } from "./layout";

interface BookingEngineSectionProps {
  instantBook: boolean;
  saving: boolean;
  onToggle: (next: boolean) => void;
  sameDayBookingsEnabled: boolean;
  sameDayBookingCutoffTime: string;
  savingSameDay: boolean;
  channexConnected: boolean;
  onSameDayEnabledChange: (next: boolean) => void;
  onSameDayCutoffTimeChange: (next: string) => void;
  onSaveSameDay: () => void;
}

export function BookingEngineSection({
  instantBook,
  saving,
  onToggle,
  sameDayBookingsEnabled,
  sameDayBookingCutoffTime,
  savingSameDay,
  channexConnected,
  onSameDayEnabledChange,
  onSameDayCutoffTimeChange,
  onSaveSameDay,
}: BookingEngineSectionProps) {
  const timeOptions = Array.from({ length: 48 }, (_, i) => {
    const hour = Math.floor(i / 2);
    const minute = i % 2 === 0 ? "00" : "30";
    return `${String(hour).padStart(2, "0")}:${minute}`;
  });

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

      <SettingsCard>
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">
                Same-day booking cutoff
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Guests can book a stay for today until this time. After that,
                today will no longer be bookable.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={sameDayBookingsEnabled}
              disabled={savingSameDay}
              onClick={() => onSameDayEnabledChange(!sameDayBookingsEnabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
                sameDayBookingsEnabled ? "bg-primary-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  sameDayBookingsEnabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {sameDayBookingsEnabled && (
            <div className="grid gap-2 sm:max-w-xs">
              <label
                htmlFor="same-day-booking-cutoff"
                className="text-xs font-medium text-gray-700"
              >
                Latest same-day booking time
              </label>
              <select
                id="same-day-booking-cutoff"
                value={sameDayBookingCutoffTime}
                disabled={savingSameDay}
                onChange={(event) => onSameDayCutoffTimeChange(event.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 disabled:opacity-50"
              >
                {timeOptions.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
            {sameDayBookingsEnabled ? (
              <p>
                Guests can book for today until {sameDayBookingCutoffTime}{" "}
                property local time. After {sameDayBookingCutoffTime}, the
                earliest available check-in date is tomorrow.
              </p>
            ) : (
              <p>
                Guests cannot book a stay with today as the check-in date.
              </p>
            )}
            {channexConnected && (
              <p className="mt-2">
                This setting will be synced to connected channels through
                Channex by closing same-day availability after the selected
                cutoff time.
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={savingSameDay}
            onClick={onSaveSameDay}
            className="inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {savingSameDay ? "Saving..." : "Save same-day cutoff"}
          </button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
