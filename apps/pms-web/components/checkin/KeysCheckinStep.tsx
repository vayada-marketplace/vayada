"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";

export interface CheckinReviewRow {
  key: string;
  title: string;
  detail: string;
  ok: boolean;
  /** The step to go back to; none for an extra check, which is filled in here. */
  editStep?: number;
  /** An extra check's own control. */
  control?: ReactNode;
}

/** Step 4: a "key handed over" box per room when the hotel hands out keys (D5), then every step
 * with ✓ or ! and Edit, and the extra checks from Settings → Check-in (VAY-2373). */
export function KeysCheckinStep({
  keys,
  onKey,
  rows,
  onEdit,
}: {
  /** Null when Settings → Check-in has no key step. */
  keys: Array<{ key: string; title: string; guests: string; given: boolean }> | null;
  onKey: (key: string, given: boolean) => void;
  rows: CheckinReviewRow[];
  onEdit: (step: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-8">
      {keys && keys.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-lg font-bold text-gray-900">{t("checkIn.flow.keys.handOver")}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {keys.map((room) => (
              <label
                key={room.key}
                className={`flex cursor-pointer items-center gap-3.5 rounded-2xl px-4 py-3.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary-500 ${
                  room.given
                    ? "bg-primary-50 shadow-[inset_0_0_0_2px] shadow-primary-600"
                    : "border border-gray-200 bg-white"
                }`}
              >
                <input
                  type="checkbox"
                  checked={room.given}
                  onChange={(event) => onKey(room.key, event.target.checked)}
                  className="h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="min-w-0">
                  <span className="block text-[15px] font-bold text-gray-900">{room.title}</span>
                  {room.guests && (
                    <span className="block truncate text-sm text-gray-600">{room.guests}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      <section
        className={`flex flex-col gap-3 ${keys && keys.length > 0 ? "border-t border-gray-200 pt-8" : ""}`}
      >
        <h3 className="text-lg font-bold text-gray-900">{t("checkIn.flow.keys.beforeCheckin")}</h3>
        <ul className="divide-y divide-gray-200 overflow-hidden rounded-2xl border border-gray-200">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center gap-3.5 px-4 py-3.5">
              <span
                aria-hidden="true"
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  row.ok ? "bg-green-600 text-white" : "bg-amber-100 text-amber-700"
                }`}
              >
                {row.ok ? <CheckIcon className="h-4 w-4" strokeWidth={2.5} /> : "!"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold text-gray-900">{row.title}</p>
                <p className={`text-sm ${row.ok ? "text-gray-600" : "text-amber-700"}`}>
                  {row.detail}
                </p>
              </div>
              {row.control}
              {row.editStep !== undefined && (
                <button
                  type="button"
                  onClick={() => onEdit(row.editStep!)}
                  className="shrink-0 text-[15px] font-semibold text-primary-700 hover:underline"
                >
                  {t("checkIn.flow.keys.edit")}
                  <span className="sr-only"> {row.title}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
