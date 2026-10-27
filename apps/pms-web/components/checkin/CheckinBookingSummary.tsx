"use client";

import { useTranslation } from "@/lib/i18n";

/** Laptop: the booking at a glance beside the steps, updated as staff work (VAY-2373). */
export function CheckinBookingSummary({
  reference,
  rows,
  booker,
}: {
  reference: string;
  rows: Array<{ label: string; value: string }>;
  booker: { name: string; email: string; phone: string };
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("checkIn.flow.summary.title")}
      className="hidden self-start rounded-2xl border border-gray-200 bg-white p-6 lg:sticky lg:top-6 lg:block"
    >
      <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
        {t("checkIn.flow.summary.title")}
      </p>
      <p className="mt-3 text-lg font-bold text-gray-900">{reference}</p>
      <dl className="mt-4 space-y-3 border-b border-gray-200 pb-4 text-[15px]">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-gray-600">{row.label}</dt>
            <dd className="text-right font-semibold text-gray-900">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-gray-500">{t("checkIn.flow.summary.booker")}</p>
      <p className="mt-1 font-bold text-gray-900">{booker.name}</p>
      {booker.email && (
        <a href={`mailto:${booker.email}`} className="block truncate text-primary-700 underline">
          {booker.email}
        </a>
      )}
      {booker.phone && (
        <a href={`tel:${booker.phone}`} className="block truncate text-primary-700 underline">
          {booker.phone}
        </a>
      )}
    </aside>
  );
}
