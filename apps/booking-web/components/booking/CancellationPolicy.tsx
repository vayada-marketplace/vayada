"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type {
  PolicyBlock,
  PolicyPay,
  PolicyWhen,
} from "@vayada/domain-booking/replacement-pricing";
import { formatStayDate, resolveLocale } from "@/lib/utils";

export const chevron = (open: boolean) => (
  <svg
    className={`h-[18px] w-[18px] shrink-0 text-gray-600 transition-transform ${open ? "rotate-180" : ""}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
  </svg>
);

/** One cancellation policy on step 3 (VAY-2347): a row that starts open, with a badge for where
 * the stay stands today, a table of what the guest pays if they cancel when, the row that applies
 * now marked, and a short note. `title` names the rooms when the stay has several policies. */
export default function CancellationPolicy({
  block,
  titled,
  formatMoney,
}: {
  block: PolicyBlock;
  /** Several policies: each block is named by its rooms (D7). */
  titled: boolean;
  formatMoney: (minor: string) => string;
}) {
  const t = useTranslations("beforeYouBook.policy");
  const locale = useLocale();
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const { policy } = block;
  // A date in another year than the hotel's today says its year.
  const day = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(date.slice(0, 4) !== block.today.slice(0, 4) && { year: "numeric" }),
      timeZone: "UTC",
    });
  const when = (w: PolicyWhen) =>
    w.kind === "between"
      ? t("when.between", { from: day(w.from), until: day(w.until) })
      : "date" in w
        ? t(`when.${w.kind}`, { date: day(w.date) })
        : t(`when.${w.kind}`);
  const pay = (p: PolicyPay) =>
    p.kind === "part"
      ? t("pay.part", { percent: p.percent, amount: formatMoney(p.amountMinor) })
      : p.kind === "full"
        ? t("pay.full", { amount: formatMoney(p.amountMinor) })
        : t(`pay.${p.kind}`);
  const badge = policy.badge;
  const note = policy.note;
  const noteText = [
    policy.request ? t("note.request") : null,
    "date" in note
      ? t(`note.${note.kind}`, { date: formatStayDate(note.date, locale) })
      : t(`note.${note.kind}`),
    policy.bankTransfer ? t("note.bankTransfer") : null,
  ]
    .filter(Boolean)
    .join(" ");
  const amber = policy.tone === "amber";
  const title = titled ? t("titleRooms", { rooms: block.rooms.join(", ") }) : t("title");
  return (
    <div className="space-y-3.5">
      <h3>
        <button
          type="button"
          className="flex w-full items-center gap-3 text-left"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="flex flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="text-[17px] font-semibold text-gray-900">{title}</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[13px] font-bold ${
                amber ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-700"
              }`}
            >
              {"date" in badge
                ? t(`badge.${badge.kind}`, { date: day(badge.date) })
                : t(`badge.${badge.kind}`)}
            </span>
          </span>
          {chevron(open)}
        </button>
      </h3>
      {open && (
        <div id={panelId} className="overflow-hidden rounded-xl border border-gray-200">
          <div role="table" aria-label={title}>
            <div role="row" className="flex gap-4 border-b border-gray-200 bg-gray-50 px-4 py-2.5">
              <span role="columnheader" className="flex-1 text-[13px] font-bold text-gray-500">
                {t("ifYouCancel")}
              </span>
              <span role="columnheader" className="text-[13px] font-bold text-gray-500">
                {t("youPay")}
              </span>
            </div>
            {policy.rows.map((row, index) => (
              <div
                key={index}
                role="row"
                aria-current={row.now || undefined}
                className={`flex flex-col gap-0.5 border-b border-gray-200 px-4 py-3 sm:flex-row sm:items-start sm:gap-4 ${
                  row.now ? (amber ? "bg-amber-50" : "bg-green-50") : "bg-white"
                }`}
              >
                <span role="cell" className="flex flex-1 flex-wrap gap-x-1.5 text-[15px]">
                  <span
                    className={
                      row.ended
                        ? "text-gray-500 line-through"
                        : row.now
                          ? "font-semibold text-gray-900"
                          : "text-gray-900"
                    }
                  >
                    {when(row.when)}
                  </span>
                  {row.now && (
                    <span className={`font-bold ${amber ? "text-amber-800" : "text-green-700"}`}>
                      · {t("appliesNow")}
                    </span>
                  )}
                  {row.ended && <span className="text-gray-500">· {t("ended")}</span>}
                </span>
                <span
                  role="cell"
                  className={`text-[15px] sm:text-right ${
                    row.ended
                      ? "text-gray-500"
                      : row.now
                        ? "font-bold text-gray-900"
                        : "text-gray-900"
                  }`}
                >
                  {pay(row.pay)}
                </span>
              </div>
            ))}
          </div>
          <p className="bg-white px-4 py-3 text-sm text-gray-600">{noteText}</p>
        </div>
      )}
    </div>
  );
}
