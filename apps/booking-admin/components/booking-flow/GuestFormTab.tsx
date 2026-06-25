"use client";

import { useTranslation } from "@/lib/i18n";
import { SaveButton } from "@/components/ui";

interface GuestFormTabProps {
  specialRequestsEnabled: boolean;
  setSpecialRequestsEnabled: (enabled: boolean) => void;
  arrivalTimeEnabled: boolean;
  setArrivalTimeEnabled: (enabled: boolean) => void;
  guestCountEnabled: boolean;
  setGuestCountEnabled: (enabled: boolean) => void;
  adultAgeThreshold: number;
  setAdultAgeThreshold: (value: number) => void;
  childrenEnabled: boolean;
  setChildrenEnabled: (enabled: boolean) => void;
  onSave: () => void;
  saving: boolean;
}

export default function GuestFormTab({
  specialRequestsEnabled,
  setSpecialRequestsEnabled,
  arrivalTimeEnabled,
  setArrivalTimeEnabled,
  guestCountEnabled,
  setGuestCountEnabled,
  adultAgeThreshold,
  setAdultAgeThreshold,
  childrenEnabled,
  setChildrenEnabled,
  onSave,
  saving,
}: GuestFormTabProps) {
  const { t } = useTranslation();
  const childMaxAge = Math.max(0, adultAgeThreshold - 1);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5">
      <h2 className="text-sm font-semibold text-gray-900">{t("bookingFlow.guestForm.title")}</h2>
      <p className="text-[12px] text-gray-500 mt-0.5 mb-3">{t("bookingFlow.guestForm.subtitle")}</p>
      <div className="space-y-2">
        <div
          className={`flex items-center justify-between p-3 rounded-lg border transition-all ${specialRequestsEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
        >
          <div>
            <span className="text-[13px] font-medium text-gray-900">
              {t("bookingFlow.guestForm.specialRequests")}
            </span>
            <span className="ml-2 text-[10px] font-medium text-green-600">
              {t("bookingFlow.guestForm.recommended")}
            </span>
          </div>
          <SwitchButton
            label={t("bookingFlow.guestForm.specialRequests")}
            enabled={specialRequestsEnabled}
            onClick={() => setSpecialRequestsEnabled(!specialRequestsEnabled)}
          />
        </div>
        <div
          className={`flex items-center justify-between p-3 rounded-lg border transition-all ${arrivalTimeEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
        >
          <span className="text-[13px] font-medium text-gray-900">
            {t("bookingFlow.guestForm.estimatedArrivalTime")}
          </span>
          <SwitchButton
            label={t("bookingFlow.guestForm.estimatedArrivalTime")}
            enabled={arrivalTimeEnabled}
            onClick={() => setArrivalTimeEnabled(!arrivalTimeEnabled)}
          />
        </div>
        <div
          className={`flex items-center justify-between p-3 rounded-lg border transition-all ${guestCountEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
        >
          <span className="text-[13px] font-medium text-gray-900">
            {t("bookingFlow.guestForm.numberOfGuests")}
          </span>
          <SwitchButton
            label={t("bookingFlow.guestForm.numberOfGuests")}
            enabled={guestCountEnabled}
            onClick={() => setGuestCountEnabled(!guestCountEnabled)}
          />
        </div>
        <div
          className={`flex items-center justify-between gap-4 p-3 rounded-lg border transition-all ${childrenEnabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200"}`}
        >
          <div>
            <span className="text-[13px] font-medium text-gray-900">
              {t("bookingFlow.guestForm.children")}
            </span>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {t("bookingFlow.guestForm.childrenDescription")}
            </p>
          </div>
          <SwitchButton
            label={t("bookingFlow.guestForm.children")}
            enabled={childrenEnabled}
            onClick={() => setChildrenEnabled(!childrenEnabled)}
          />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="text-[13px] font-medium text-gray-900">
              {t("bookingFlow.guestForm.adultAgeThreshold")}
            </span>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {t("bookingFlow.guestForm.ageRange", {
                adultAge: adultAgeThreshold,
                childMaxAge,
              })}
            </p>
          </div>
          <input
            type="number"
            aria-label={t("bookingFlow.guestForm.adultAgeThreshold")}
            min={1}
            max={120}
            value={adultAgeThreshold}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) {
                setAdultAgeThreshold(Math.min(120, Math.max(1, next)));
              }
            }}
            className="h-9 w-24 rounded-md border border-gray-300 px-3 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <SaveButton onClick={onSave} saving={saving} />
      </div>
    </div>
  );
}

function SwitchButton({
  label,
  enabled,
  onClick,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={enabled}
      onClick={onClick}
      className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${enabled ? "bg-primary-500" : "bg-gray-300"}`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-4" : "left-0.5"}`}
      />
    </button>
  );
}
