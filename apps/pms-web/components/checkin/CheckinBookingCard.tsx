"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";

export interface CheckinCardAction {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** Under the button: green when the step is fine, orange while something is open. */
  status: { text: string; ok: boolean };
}

/** The booking beside every step, with the step's button at its foot; sticky on laptops, below the
 * step on narrow screens (VAY-2418). */
export function CheckinBookingCard({
  reference,
  source,
  viewHref,
  dates,
  rows,
  balance,
  action,
  back,
}: {
  reference: string;
  source: string;
  viewHref: string;
  /** Check-in and check-out. */
  dates: Array<{ label: string; date: string; time: string | null }>;
  /** `warn` shows the value in orange while it is incomplete. */
  rows: Array<{ label: string; value: string; warn?: boolean }>;
  balance: { label: string; value: string };
  action: CheckinCardAction;
  back: { label: string; onClick: () => void } | null;
}) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("checkIn.flow.summary.title")}
      className="self-start rounded-2xl border border-gray-200 bg-white p-6 lg:sticky lg:top-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold text-gray-900">{t("checkIn.flow.summary.title")}</h2>
        <Link
          href={viewHref}
          className="text-sm font-semibold text-primary-700 hover:text-primary-800 hover:underline"
        >
          {t("checkIn.flow.summary.view")}
          <span className="sr-only"> {reference}</span>
        </Link>
      </div>
      <p className="mt-0.5 truncate text-sm text-gray-600">
        {reference} · {source}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-gray-200 py-4">
        {dates.map((entry) => (
          <div key={entry.label} className="min-w-0">
            <dt className="text-xs text-gray-500">{entry.label}</dt>
            <dd className="font-semibold text-gray-900">{entry.date}</dd>
            {entry.time && <dd className="text-sm text-gray-600">{entry.time}</dd>}
          </div>
        ))}
      </dl>
      <dl className="space-y-2.5 py-4 text-[15px]">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-gray-600">{row.label}</dt>
            <dd
              className={`text-right font-semibold ${row.warn ? "text-amber-700" : "text-gray-900"}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="flex justify-between gap-4 border-t border-gray-200 pt-4 text-[15px]">
        <dt className="font-semibold text-gray-900">{balance.label}</dt>
        <dd className="text-right font-bold text-gray-900">{balance.value}</dd>
      </dl>
      <button
        type="button"
        disabled={action.disabled}
        onClick={action.onClick}
        className="mt-5 flex h-[52px] w-full items-center justify-center rounded-xl bg-primary-600 px-5 text-base font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        {action.label}
      </button>
      <p
        role="status"
        className={`mt-2.5 text-center text-sm font-semibold ${
          action.status.ok ? "text-green-700" : "text-amber-700"
        }`}
      >
        {action.status.text}
      </p>
      {back && (
        <button
          type="button"
          onClick={back.onClick}
          className="mx-auto mt-3 flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-gray-700 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          {back.label}
        </button>
      )}
    </aside>
  );
}
