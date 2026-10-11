"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";

/** The closed "More options" row under the steps. A native <details> keeps its editors mounted while closed, so an
 * unapplied entry and its Save guard survive; with `keepOpen` (such an entry inside) it opens and stays open.
 * `summary` names what is set inside, marked with a dot, so nothing hides behind the closed row. */
export function MoreOptions({
  keepOpen = false,
  summary,
  children,
}: {
  keepOpen?: boolean;
  summary?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (keepOpen && details.current) details.current.open = true;
  }, [keepOpen]);
  return (
    <details ref={details} className="group rounded-2xl border border-gray-200 bg-white">
      <summary
        onClick={(event) => {
          if (keepOpen) event.preventDefault();
        }}
        className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-5 py-5 transition-colors hover:bg-gray-50 md:px-7 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-gray-500 transition-transform group-open:rotate-90"
        />
        <span className="text-[15px] font-semibold text-gray-900">
          {t("pricing.steps.more.title")}
        </span>
        {summary && (
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
        )}
        <span
          className={`ml-auto truncate text-[14px] ${summary ? "text-gray-700" : "hidden text-gray-500 sm:block"}`}
        >
          {summary ?? t("pricing.steps.more.hint")}
        </span>
      </summary>
      <div className="space-y-4 border-t border-gray-100 p-5 md:p-7">{children}</div>
    </details>
  );
}
