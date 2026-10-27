"use client";

import { useTranslation } from "@/lib/i18n";

/** Step 1: the booking's facts and the special request, with "I have read the request" when
 * Settings → Check-in asks for it (VAY-2373). */
export function ArrivalStep({
  facts,
  request,
  confirmRequest,
  requestRead,
  onRequestRead,
}: {
  facts: Array<{ label: string; value: string }>;
  /** Null when there is none, or Settings → Check-in hides it. */
  request: string | null;
  confirmRequest: boolean;
  requestRead: boolean;
  onRequestRead: (read: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 md:gap-3">
        {facts.map((fact) => (
          <div key={fact.label} className="min-w-0 md:rounded-xl md:bg-gray-50 md:px-4 md:py-3.5">
            <dt className="text-sm text-gray-600">{fact.label}</dt>
            <dd className="mt-0.5 text-base font-bold text-gray-900">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {request && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800">
            {t("dashboard.popup.specialRequest")}
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-base text-gray-900">{request}</p>
          {confirmRequest && (
            <label className="mt-3 flex w-fit cursor-pointer items-center gap-2.5 text-[15px] font-semibold text-amber-800">
              <input
                type="checkbox"
                checked={requestRead}
                onChange={(event) => onRequestRead(event.target.checked)}
                className="h-5 w-5 rounded border-amber-400 text-primary-600 focus:ring-primary-500"
              />
              {t("checkIn.flow.arrival.requestRead")}
            </label>
          )}
        </section>
      )}
    </div>
  );
}
