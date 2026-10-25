"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  cancellationLine,
  type CancellationLinePart,
  type PolicyBlock,
} from "@/lib/cancellationPolicy";
import { resolveLocale } from "@/lib/utils";
import CancellationPolicy from "./CancellationPolicy";

/** VAY-2360: the booked stay's cancellation in one line of the confirmation ticket, in step 3's words and
 * dates, with "Full policy" opening step 3's table for the booked rates. */
export default function ConfirmationCancellation({
  blocks,
  formatMoney,
  manageHref,
}: {
  blocks: PolicyBlock[];
  formatMoney: (minor: string) => string;
  manageHref: string;
}) {
  const t = useTranslations("confirmation");
  const tp = useTranslations("beforeYouBook.policy");
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  const line = cancellationLine(blocks);
  if (!line) return null;
  const today = blocks[0]!.today;
  const day = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString(resolveLocale(locale), {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(date.slice(0, 4) !== today.slice(0, 4) && { year: "numeric" }),
      timeZone: "UTC",
    });
  const text = (part: CancellationLinePart) =>
    t(`cancelLine.${part.key}`, {
      date: part.date ? day(part.date) : "",
      amount: part.amountMinor ? formatMoney(part.amountMinor) : "",
      rooms: (part.rooms ?? []).filter(Boolean).join(", "),
    });
  const amber = line.tone === "amber";
  const tone = amber
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : "border-green-200 bg-green-50 text-green-800";
  return (
    <div
      className={`flex items-start gap-2.5 border-t border-dashed px-[18px] py-3 sm:gap-3 sm:px-7 ${tone}`}
      data-testid="confirmation-cancellation"
    >
      <svg
        aria-hidden="true"
        className="mt-0.5 h-[18px] w-[18px] shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        viewBox="0 0 24 24"
      >
        <path
          d={
            amber
              ? "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              : "M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
          }
        />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
        <p className="min-w-0 flex-1 text-sm leading-[21px] sm:text-[15px]">
          <strong className="font-bold">{text(line.lead)}</strong>
          {` ${line.rest.map(text).join(" ")}`}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start whitespace-nowrap text-sm font-semibold leading-[21px] underline"
        >
          {t("fullPolicy")}
        </button>
      </div>
      <dialog
        ref={dialog}
        aria-label={tp("title")}
        onClose={() => setOpen(false)}
        className="m-auto mb-0 w-full max-w-none rounded-t-2xl bg-white p-5 text-gray-900 shadow-xl backdrop:bg-black/50 sm:mb-auto sm:w-[calc(100%-2rem)] sm:max-w-[560px] sm:rounded-2xl sm:p-6"
      >
        <div className="flex flex-col gap-5">
          {blocks.map((block) => (
            <CancellationPolicy
              key={block.key}
              block={block}
              titled={blocks.length > 1}
              formatMoney={formatMoney}
            />
          ))}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Link
              href={manageHref}
              className="flex h-11 items-center justify-center rounded-full border border-gray-300 px-5 font-semibold text-gray-900 hover:bg-gray-50"
            >
              {t("manageOrCancel")}
            </Link>
            <button
              type="button"
              autoFocus
              onClick={() => setOpen(false)}
              className="h-11 rounded-full bg-primary-700 px-5 font-semibold text-white hover:bg-primary-800"
            >
              {t("close")}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
